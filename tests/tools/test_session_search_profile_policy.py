"""Profile recall permissions are enforced before opening another profile store."""
import json
import tempfile
from pathlib import Path
from typing import Any

import pytest

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from tools.session_search_tool import session_search, _resolve_profile_db


@pytest.fixture
def recall_profiles(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="recall-policy-") as td:
        root = Path(td)
        monkeypatch.chdir(root)
        homes = {name: root / name for name in ("default", "restricted")}
        for name, home in homes.items():
            home.mkdir()
            (home / "config.yaml").write_text("session_search:\n  allow_cross_profile: false\n")
            db = SessionDB(home / "state.db")
            db.create_session(name + "-session", source="cli")
            db.append_message(name + "-session", role="user", content=name + " private canary")
            db._conn.commit()
            db.close()
        from hermes_cli import profiles
        monkeypatch.setattr(profiles, "profile_exists", lambda n: n in homes)
        monkeypatch.setattr(profiles, "get_profile_dir", lambda n: homes[n])
        token = set_hermes_home_override(homes["restricted"])
        try:
            yield homes
        finally:
            reset_hermes_home_override(token)


def test_restricted_profile_rejects_explicit_cross_profile(recall_profiles):
    result = json.loads(session_search(profile="default", session_id="default-session"))
    assert result.get("success") is False
    assert "cross-profile session search is disabled" in result.get("error", "").lower()
    assert "default private canary" not in json.dumps(result)


@pytest.mark.parametrize("args", [
    {"profile": "default"},
    {"profile": "default", "query": "canary"},
    {"profile": "default", "session_id": "default-session", "around_message_id": 1},
    {"session_id": "default/default-session"},
])
def test_all_cross_profile_shapes_refused_before_open(recall_profiles, monkeypatch, args):
    def forbidden_open(*args, **kwargs):
        pytest.fail("foreign database constructor was reached")
    monkeypatch.setattr("hermes_state.SessionDB", forbidden_open)
    result = json.loads(session_search(**args))
    assert result.get("success") is False
    assert "cross-profile session search is disabled" in result.get("error", "").lower()


@pytest.mark.parametrize("profile", [None, "", "restricted"])
def test_own_history_still_readable(recall_profiles, profile):
    result = json.loads(session_search(profile=profile, session_id="restricted-session"))
    assert result.get("success") is True
    assert "restricted private canary" in json.dumps(result)
    assert "default private canary" not in json.dumps(result)


def test_own_browse_and_search_still_work(recall_profiles):
    cases: list[dict[str, Any]] = [{}, {"query": "canary"}]
    for args in cases:
        result = json.loads(session_search(**args))
        assert result.get("success") is True
        assert "restricted-session" in json.dumps(result)
        assert "default-session" not in json.dumps(result)


def test_bare_foreign_id_does_not_fall_through(recall_profiles):
    result = json.loads(session_search(session_id="default-session"))
    assert result.get("success") is False
    assert "default private canary" not in json.dumps(result)


@pytest.mark.parametrize("policy", ["session_search: {allow_cross_profile: true}"])
def test_unrestricted_caller_retains_explicit_cross_profile(recall_profiles, policy):
    (recall_profiles["restricted"] / "config.yaml").write_text(policy)
    result = json.loads(session_search(profile="default", session_id="default-session"))
    assert result.get("success") is True
    assert "default private canary" in json.dumps(result)


@pytest.mark.parametrize("value", ["null", "0", "'false'", "[]", "{}"])
def test_malformed_cross_profile_flag_fails_closed(recall_profiles, value):
    (recall_profiles["restricted"] / "config.yaml").write_text(
        "session_search: {allow_cross_profile: " + value + "}")
    with pytest.raises(PermissionError, match="cross-profile session search is disabled"):
        _resolve_profile_db("default")


@pytest.mark.parametrize("value", ["null", "[]", "false", "'invalid'"])
def test_malformed_section_fails_closed(recall_profiles, value):
    (recall_profiles["restricted"] / "config.yaml").write_text("session_search: " + value)
    with pytest.raises(PermissionError, match="invalid session_search policy"):
        _resolve_profile_db("default")


@pytest.mark.parametrize("policy", ["{}", "session_search: {}", "unclosed: ["])
def test_missing_or_unparseable_policy_cannot_grant_cross_profile(recall_profiles, policy):
    (recall_profiles["restricted"] / "config.yaml").write_text(policy)
    result = json.loads(session_search(profile="default", session_id="default-session"))
    assert result.get("success") is False
    assert "default private canary" not in json.dumps(result)


def test_unreadable_config_cannot_grant_cross_profile(recall_profiles, monkeypatch):
    from hermes_cli import config
    monkeypatch.setattr(config, "load_config", lambda: (_ for _ in ()).throw(PermissionError("unreadable")))
    result = json.loads(session_search(profile="default", session_id="default-session"))
    assert result.get("success") is False
    assert "default private canary" not in json.dumps(result)


def test_profile_scope_survives_real_parallel_tool_dispatch(recall_profiles):
    from concurrent.futures import ThreadPoolExecutor
    from hermes_constants import get_hermes_home
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS, InlineToolContext
    from tools.thread_context import propagate_context_to_thread
    from types import SimpleNamespace
    db = SessionDB(recall_profiles["restricted"] / "state.db", read_only=True)
    agent = SimpleNamespace(_get_session_db_for_recall=lambda: db, session_id="restricted-session")
    tool_ctx = InlineToolContext(effective_task_id="policy-test", tool_call_id="policy-call")
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            # Negative control: a bare executor loses the profile (fail-open shape).
            assert pool.submit(get_hermes_home).result() != recall_profiles["restricted"]
            # Production path: agent/tool_executor.py submits every concurrent tool call
            # through propagate_context_to_thread (line ~1418), never a bare submit.
            result = pool.submit(propagate_context_to_thread(INLINE_TOOL_EXECUTORS["session_search"]), agent, {
                "profile": "default", "session_id": "default-session"}, tool_ctx).result()
    finally:
        db.close()
    result = json.loads(result) if isinstance(result, str) else result
    assert result.get("success") is False
    assert "cross-profile session search is disabled" in result.get("error", "").lower()
    assert "default private canary" not in json.dumps(result)


def test_multiplex_without_profile_scope_fails_closed(monkeypatch):
    """A thread that lost the home override must not inherit the launch profile's grant.

    Under multiplexing every routed turn installs a home override (gateway/run.py
    _profile_runtime_scope). A contextvar-less thread therefore looks exactly like the
    launch profile — whose policy may allow cross-profile search. Attribution is
    impossible, so the guard refuses instead of granting.
    """
    from agent.secret_scope import set_multiplex_context, reset_multiplex_context
    from hermes_constants import get_hermes_home_override
    monkeypatch.setattr("hermes_cli.config.load_config",
                        lambda *a, **k: {"session_search": {"allow_cross_profile": True}})
    cleared = set_hermes_home_override(None)
    mux_token = set_multiplex_context(True)
    try:
        assert get_hermes_home_override() is None
        with pytest.raises(PermissionError, match="no profile scope in this execution context"):
            _resolve_profile_db("default")
    finally:
        reset_multiplex_context(mux_token)
        reset_hermes_home_override(cleared)


def test_multiplex_with_profile_scope_honours_policy(recall_profiles, monkeypatch):
    """The fail-closed branch keys on the missing override, not on multiplexing itself."""
    from agent.secret_scope import set_multiplex_context, reset_multiplex_context, set_secret_scope, reset_secret_scope
    monkeypatch.setattr("hermes_cli.config.load_config", lambda *a, **k: {"session_search": {}})
    mux_token = set_multiplex_context(True)
    home_token = set_hermes_home_override(str(recall_profiles["restricted"]))
    secret_token = set_secret_scope({}, profile_home=str(recall_profiles["restricted"]))
    try:
        # Same profile as the caller: opening it is not cross-profile, so it is allowed.
        db = _resolve_profile_db("restricted")
        assert db is not None
        db.close()
        # A foreign profile still needs the explicit grant.
        with pytest.raises(PermissionError, match="cross-profile session search is disabled"):
            _resolve_profile_db("default")
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
        reset_multiplex_context(mux_token)
