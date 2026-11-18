"""Regression: a bare model id from a client must be attributed to the provider that serves it.

The desktop/mobile composer (and a bare ``hermes --model <id>``) sends a model with no provider.
``_resolve_agent_model_runtime`` used to fall back to config's ``model.provider`` (openai-codex),
so ``claude-sonnet-5`` was resolved against the Codex endpoint, the Codex quota probe 429'd, and
the user saw ``Provider fallback: openai-codex/claude-sonnet-5 unavailable`` — an attribution for a
route that never existed.
"""

import pytest


@pytest.fixture()
def offline_catalog(monkeypatch):
    """Deterministic, credential-less catalog: static catalogs decide, nothing dials out."""
    from hermes_cli import models_detect

    monkeypatch.setattr(models_detect, "current_provider_catalog_match", lambda name, provider: None)
    monkeypatch.setattr(models_detect, "provider_has_credentials", lambda provider: True)


def test_anthropic_model_is_not_attributed_to_codex(offline_catalog):
    from hermes_cli.fallback_config import attribute_model_provider

    assert attribute_model_provider("openai-codex", "claude-sonnet-5") == "anthropic"


def test_native_model_stays_on_its_provider(offline_catalog):
    from hermes_cli.fallback_config import attribute_model_provider

    # The configured provider owns the name → never re-route.
    assert attribute_model_provider("openai-codex", "gpt-6-luna") == "openai-codex"
    assert attribute_model_provider("anthropic", "claude-sonnet-5") == "anthropic"
    # Unplaceable id → keep the caller's provider instead of guessing.
    assert attribute_model_provider("openai-codex", "totally-made-up-model") == "openai-codex"


def test_missing_provider_is_left_alone_without_a_model(offline_catalog):
    from hermes_cli.fallback_config import attribute_model_provider

    assert attribute_model_provider("", "") == ""
    assert attribute_model_provider("deepseek", None) == "deepseek"


def _capture_runtime(monkeypatch):
    """Patch the runtime ladder so the test only inspects the requested provider/model."""
    from tui_gateway import server

    seen = {}

    class _Resolution:
        def __init__(self):
            self.runtime = {"provider": "anthropic", "source": "manual:test"}
            self.selected_model = None
            self.used_fallback = False

    def _fake(_resolve_kwargs=None):
        seen.update(_resolve_kwargs or {})
        return _Resolution()

    monkeypatch.setattr(server._agent_factory, "_resolve_runtime_with_fallback", _fake)
    return server._agent_factory, seen


def test_bare_model_override_resolves_to_its_real_provider(monkeypatch, offline_catalog):
    factory, seen = _capture_runtime(monkeypatch)

    factory._resolve_agent_model_runtime({"model": "claude-sonnet-5", "provider": None}, None)

    assert seen["target_model"] == "claude-sonnet-5"
    assert seen["requested"] == "anthropic"


def test_explicit_provider_override_wins(monkeypatch, offline_catalog):
    factory, seen = _capture_runtime(monkeypatch)

    factory._resolve_agent_model_runtime({"model": "claude-sonnet-5", "provider": "openai-codex"}, None)

    assert seen["requested"] == "openai-codex"


def test_notice_names_the_reason_instead_of_unavailable(offline_catalog):
    from hermes_cli.fallback_config import pre_agent_fallback_notice

    assert pre_agent_fallback_notice(
        "anthropic", "claude-sonnet-5", "deepseek", "deepseek-v4-flash", reason="rate-limited (429)"
    ) == ("⚠️ Provider fallback: anthropic/claude-sonnet-5 rate-limited (429); "
          "using deepseek/deepseek-v4-flash for this response.")
    # Callers that do not know why keep the old wording.
    assert pre_agent_fallback_notice(
        "openai-codex", "gpt-6-luna", "gemini", "gemini-3.5-flash-lite"
    ) == ("⚠️ Provider fallback: openai-codex/gpt-6-luna unavailable; "
          "using gemini/gemini-3.5-flash-lite for this response.")


def test_notice_corrects_a_misattributed_primary(offline_catalog):
    """The exact reported string: an Anthropic session model reported against the Codex provider."""
    from hermes_cli.fallback_config import pre_agent_fallback_notice

    assert pre_agent_fallback_notice(
        "openai-codex", "claude-sonnet-5", "gemini", "gemini-3.5-flash-lite"
    ) == ("⚠️ Provider fallback: anthropic/claude-sonnet-5 unavailable; "
          "using gemini/gemini-3.5-flash-lite for this response.")


def test_notice_built_by_the_fallback_ladder_survives(monkeypatch, offline_catalog):
    """The ladder knows the failure reason; the later attribution helper must not overwrite it."""
    from tui_gateway import server

    notice = "⚠️ Provider fallback: anthropic/claude-sonnet-5 rate-limited (429); using deepseek/deepseek-v4-flash for this response."

    class _Resolution:
        runtime = {"provider": "deepseek", "_fallback_notice": notice}
        selected_model = "deepseek-v4-flash"
        used_fallback = True

    # Use the server-bound copy: tui_gateway binds these functions onto the server module at import,
    # so only that copy resolves _load_cfg/_load_fallback_model from the server namespace.
    monkeypatch.setattr(server, "_resolve_runtime_with_fallback", lambda kw=None: _Resolution())

    model, runtime = server._resolve_agent_model_runtime(
        {"model": "claude-sonnet-5", "provider": None}, None)

    assert model == "deepseek-v4-flash"
    assert runtime["_fallback_notice"] == notice

