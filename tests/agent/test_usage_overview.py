"""Usage overview cache/shape + DeepSeek balance fetcher + ``/api/usage/limits`` route."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agent import usage_overview as uo
from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow


@pytest.fixture(autouse=True)
def _clean_cache():
    uo.clear_cache()
    yield
    uo.clear_cache()


def _snap(provider="openai-codex", used=30.0, details=()):
    return AccountUsageSnapshot(
        provider=provider, source="t", fetched_at=datetime.now(UTC), plan="Plus",
        windows=(AccountUsageWindow(label="Weekly", used_percent=used,
                                    reset_at=datetime(2026, 12, 1, tzinfo=UTC)),) if used is not None else (),
        details=tuple(details),
    )


def test_row_reports_remaining_not_used():
    row = uo.snapshot_to_row("openai-codex", _snap(used=30.0))
    w = row["windows"][0]
    assert w["used_percent"] == 30.0 and w["remaining_percent"] == 70.0
    assert w["resets_at"].startswith("2026-12-01")
    assert row["state"] == "ready" and row["plan"] == "Plus"


def test_remaining_is_clamped():
    assert uo.snapshot_to_row("x", _snap(used=140.0))["windows"][0]["remaining_percent"] == 0.0
    assert uo.snapshot_to_row("x", _snap(used=-5.0))["windows"][0]["remaining_percent"] == 100.0


def test_balance_only_snapshot_keeps_details():
    row = uo.snapshot_to_row("deepseek", _snap(used=None, details=["Balance: $12.00"]))
    assert row["windows"] == [] and row["details"] == ["Balance: $12.00"] and row["state"] == "ready"


def test_ttl_caches_success_and_collapses_duplicates():
    calls = []

    def fetch(slug):
        calls.append(slug)
        return _snap(slug)

    first = uo.usage_overview(["A", "a", "b"], fetch=fetch, now=1000.0)
    assert [r["provider"] for r in first] == ["a", "b"] and sorted(calls) == ["a", "b"]
    uo.usage_overview(["a", "b"], fetch=fetch, now=1000.0 + uo.OK_TTL_S - 1)
    assert len(calls) == 2  # served from cache
    uo.usage_overview(["a"], fetch=fetch, now=1000.0 + uo.OK_TTL_S + 1)
    assert calls.count("a") == 2 and calls.count("b") == 1
    uo.usage_overview(["a"], fetch=fetch, now=1000.0 + uo.OK_TTL_S + 2, force=True)
    assert calls.count("a") == 3


def test_failure_is_isolated_and_retried_sooner():
    state = {"n": 0}

    def fetch(slug):
        state["n"] += 1
        if slug == "bad":
            raise RuntimeError("boom with secret sk-123")
        return _snap(slug)

    rows = uo.usage_overview(["bad", "good"], fetch=fetch, now=0.0)
    by = {r["provider"]: r for r in rows}
    assert by["good"]["state"] == "ready"
    assert by["bad"]["state"] == "unavailable" and by["bad"]["unavailable_reason"] == "fetch failed"
    assert "sk-123" not in repr(rows)  # the exception text never reaches the payload
    n = state["n"]
    uo.usage_overview(["bad"], fetch=fetch, now=uo.FAIL_TTL_S - 1)
    assert state["n"] == n  # still inside the failure TTL
    uo.usage_overview(["bad"], fetch=fetch, now=uo.FAIL_TTL_S + 1)
    assert state["n"] == n + 1


def test_none_snapshot_is_unavailable():
    rows = uo.usage_overview(["z"], fetch=lambda s: None, now=0.0)
    assert rows[0]["state"] == "unavailable" and rows[0]["unavailable_reason"] == "no usage data"


# ── DeepSeek balance fetcher ─────────────────────────────────────────────────

class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _patch_deepseek(monkeypatch, body, token="sk-test"):
    import httpx

    seen = {}

    class _Client:
        def __init__(self, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            seen["url"], seen["headers"] = url, headers
            return _Resp(body)

    monkeypatch.setattr(httpx, "Client", _Client)
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider",
                        lambda **kw: {"api_key": token, "base_url": "https://api.deepseek.com/v1"})
    return seen


def _deepseek():
    from providers import get_provider_profile

    return get_provider_profile("deepseek")


def test_deepseek_balance_snapshot(monkeypatch):
    seen = _patch_deepseek(monkeypatch, {"is_available": True, "balance_infos": [
        {"currency": "USD", "total_balance": "12.5", "granted_balance": "0.00", "topped_up_balance": "12.50"}]})
    snap = _deepseek().fetch_account_usage()
    assert seen["url"] == "https://api.deepseek.com/user/balance"
    assert seen["headers"]["Authorization"] == "Bearer sk-test"
    assert snap.windows == () and snap.details == ("Balance: $12.50 • $12.50 topped up",)
    assert snap.available
    assert "sk-test" not in repr(uo.snapshot_to_row("deepseek", snap))


def test_deepseek_exhausted_balance_is_flagged(monkeypatch):
    _patch_deepseek(monkeypatch, {"is_available": False, "balance_infos": [
        {"currency": "USD", "total_balance": "0.00"}]})
    snap = _deepseek().fetch_account_usage()
    assert snap.details[0] == "Balance: $0.00" and "unavailable" in snap.details[-1]


def test_deepseek_without_key_or_balances_returns_none(monkeypatch):
    _patch_deepseek(monkeypatch, {"balance_infos": []}, token="")
    assert _deepseek().fetch_account_usage() is None
    _patch_deepseek(monkeypatch, {"balance_infos": []}, token="sk-x")
    assert _deepseek().fetch_account_usage() is None


def test_deepseek_is_usage_capable():
    from agent.account_usage_cache import has_account_usage

    assert has_account_usage("deepseek")


# ── Route ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(_isolate_hermes_home):
    from starlette.testclient import TestClient

    from hermes_cli import web_server

    c = TestClient(web_server.app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


def test_route_requires_the_session_token(_isolate_hermes_home):
    from starlette.testclient import TestClient

    from hermes_cli import web_server

    assert TestClient(web_server.app).get("/api/usage/limits").status_code in (401, 403)


def test_route_returns_named_rows_and_no_secrets(client, monkeypatch):
    from hermes_cli.web_routers import usage_limits

    monkeypatch.setattr(usage_limits, "_usage_capable_providers",
                        lambda: [{"slug": "deepseek", "name": "DeepSeek"}, {"slug": "openai-codex", "name": "Codex"}])
    monkeypatch.setattr("agent.account_usage.fetch_account_usage",
                        lambda slug, **kw: _snap(slug, used=None, details=["Balance: $3.00"]) if slug == "deepseek"
                        else _snap(slug, used=25.0))
    body = client.get("/api/usage/limits").json()
    by = {r["provider"]: r for r in body["providers"]}
    assert by["deepseek"]["name"] == "DeepSeek" and by["deepseek"]["details"] == ["Balance: $3.00"]
    assert by["openai-codex"]["windows"][0]["remaining_percent"] == 75.0
    assert "token" not in repr(body).lower() and "api_key" not in repr(body)


def test_route_refresh_bypasses_cache(client, monkeypatch):
    from hermes_cli.web_routers import usage_limits

    calls = []
    monkeypatch.setattr(usage_limits, "_usage_capable_providers", lambda: [{"slug": "p", "name": "P"}])
    monkeypatch.setattr("agent.account_usage.fetch_account_usage", lambda slug, **kw: calls.append(1) or _snap(slug))
    client.get("/api/usage/limits"); client.get("/api/usage/limits")
    assert len(calls) == 1
    client.get("/api/usage/limits?refresh=1")
    assert len(calls) == 2
