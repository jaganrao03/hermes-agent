"""One greppable log line for a provider rate limit — which route, and WHEN it reopens.

The 429 body Hermes usually gets from Anthropic's subscription route is ``rate_limit_error`` with
the message "Error", no ``Retry-After`` and no ``anthropic-ratelimit-*-reset`` header, so nothing in
the exception text said which window was closed or when it reopens. The only nearby evidence was a
fallback notice for a *different* route, which read like a provider outage. Logging the reset here
keeps the cause in the log even when the provider is silent about it.

Deliberately dependency-free (stdlib only): both ``agent.*`` and ``hermes_cli.*`` call it, and the
agent layer must never be imported from the CLI layer.
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


def _reset_delay(reset_at: Any = None, wait_seconds: Any = None) -> float | None:
    """Seconds until the window reopens, from an absolute epoch (``reset_at``) or a known wait."""
    if isinstance(wait_seconds, (int, float)) and wait_seconds > 0:
        return float(wait_seconds)
    if isinstance(reset_at, (int, float)) and reset_at > 1e9:  # epoch seconds, not a duration
        delay = float(reset_at) - time.time()
        return delay if delay > 0 else None
    if isinstance(reset_at, str) and reset_at.strip():
        try:
            delay = float(reset_at.strip()) - time.time()
        except ValueError:
            return None
        return delay if delay > 0 else None
    return None


def _human_window(seconds: float) -> str:
    if seconds >= 3600:
        return f"~{-(-seconds // 3600):.0f}h"
    return f"~{-(-seconds // 60):.0f} min"


def log_rate_limit_reset(
    provider: Any, model: Any = None, *, reset_at: Any = None, wait_seconds: Any = None,
    status: str = "rate limit (429)",
) -> float | None:
    """WARNING-line a refused request with its route and reset time; returns the wait (or None).

    ``reset_at`` accepts a provider epoch; ``wait_seconds`` a ``Retry-After``/``AuthError.retry_after``.
    ``status`` names the refusal (a 402 is a credit wall, not a rate limit). With neither reset
    source, the line states that explicitly — a silent refusal still deserves a log, and
    "no reset reported" is what tells the reader the cooldown that follows is Hermes' own backoff,
    not the provider's window.
    """
    route = "/".join(str(part).strip() for part in (provider, model) if part) or "primary route"
    delay = _reset_delay(reset_at, wait_seconds)
    if delay is None:
        logger.warning(
            "%s %s: provider reported no reset time — the cooldown that follows is Hermes' own "
            "backoff, not the provider's window", route, status)
        return None
    resets_at = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(time.time() + delay))
    logger.warning("%s %s: window resets at %s (in %s)", route, status, resets_at, _human_window(delay))
    return delay
