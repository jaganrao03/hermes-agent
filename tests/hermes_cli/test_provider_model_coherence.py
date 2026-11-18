"""Provider/model coherence: config validation, and the rate-limit reset log line.

The reported failure is a pairing no endpoint can serve — ``openai-codex`` + ``claude-sonnet-5``,
which a session model override produced over config's ``model.provider``. It 429'd on the Codex
quota probe and surfaced as ``Provider fallback: openai-codex/claude-sonnet-5 unavailable``, so a
Claude subscription window read like a Codex/Anthropic outage. These tests pin the two things that
make that diagnosable: config validation refuses the pair, and a 429 logs when its window reopens.
"""

from __future__ import annotations

import logging

from hermes_cli.config import validate_config_structure


def _errors(config: dict) -> list[str]:
    return [i.message for i in validate_config_structure(config) if i.severity == "error"]


def test_anthropic_model_on_codex_provider_is_rejected():
    issues = _errors({"model": {"default": "claude-sonnet-5", "provider": "openai-codex"}})

    assert len(issues) == 1
    assert "claude-sonnet-5" in issues[0] and "openai-codex" in issues[0]
    assert "anthropic" in issues[0]


def test_fallback_entries_are_validated_too():
    issues = _errors({"fallback_providers": [
        {"provider": "openai-codex", "model": "gpt-6.1-sol"},
        {"provider": "gemini", "model": "claude-sonnet-5-5"},
    ]})

    assert len(issues) == 1
    assert issues[0].startswith("fallback_providers[1]:")


def test_coherent_pairs_pass():
    assert _errors({"model": {"default": "gpt-6-luna", "provider": "openai-codex"},
                    "fallback_providers": [
                        {"provider": "openai-codex", "model": "gpt-6.1-sol"},
                        {"provider": "gemini", "model": "gemini-3.5-flash-lite"},
                        {"provider": "deepseek", "model": "deepseek-v4-flash"},
                        {"provider": "anthropic", "model": "claude-sonnet-5-5"}]}) == []


def test_aggregators_and_custom_routes_are_never_flagged():
    """A reseller may serve any vendor, and an unknown id proves nothing — both stay silent."""
    assert _errors({"fallback_providers": [
        {"provider": "nous", "model": "upstage/solar-mini4:free"},
        {"provider": "openrouter", "model": "anthropic/claude-sonnet-5"},
        {"provider": "custom:my-endpoint", "model": "claude-sonnet-5"},
        {"provider": "deepseek", "model": "some-future-model-nobody-knows"},
    ]}) == []


def test_rate_limit_log_names_the_reset(caplog):
    from hermes_cli.rate_limit_log import log_rate_limit_reset

    with caplog.at_level(logging.WARNING):
        delay = log_rate_limit_reset("anthropic", "claude-sonnet-5", wait_seconds=8100)

    assert delay == 8100
    line = caplog.text
    assert "anthropic/claude-sonnet-5" in line
    assert "window resets at" in line and "(in ~3h)" in line


def test_rate_limit_log_says_when_the_provider_is_silent(caplog):
    """Anthropic's subscription 429 body is a bare "Error": state that no window was reported."""
    from hermes_cli.rate_limit_log import log_rate_limit_reset

    with caplog.at_level(logging.WARNING):
        assert log_rate_limit_reset("anthropic", "claude-sonnet-5") is None
        assert log_rate_limit_reset("anthropic", "claude-sonnet-5", reset_at=1) is None

    assert "provider reported no reset time" in caplog.text
    assert "Hermes' own backoff" in caplog.text


def test_rate_limit_log_accepts_a_provider_epoch(caplog):
    import time as _time

    from hermes_cli.rate_limit_log import log_rate_limit_reset

    with caplog.at_level(logging.WARNING):
        delay = log_rate_limit_reset("gemini", "gemini-3.5-flash-lite", reset_at=_time.time() + 120)

    assert delay is not None and 110 < delay <= 121
    assert "in ~2 min" in caplog.text
