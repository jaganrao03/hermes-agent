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
