"""Provider usage limits and balances for the webapp's "limits" popover.

Wraps :func:`agent.account_usage.fetch_account_usage` (percent windows for subscription logins,
dollar balances for API-key providers) behind a short TTL cache so a popover opening, or several
browser tabs, never fan out into one provider API call each.

Read-only: nothing here rotates, refreshes or benches a credential, and no token ever reaches the
returned payload (a snapshot carries labels, percentages, reset times and balance text only).
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable, Optional

_log = logging.getLogger(__name__)

# A successful read is reused this long; a failed one is retried sooner than a good one, but not
# on every popover open (a provider that is down must not be hammered).
OK_TTL_S = 60.0
FAIL_TTL_S = 20.0
FETCH_DEADLINE_S = 12.0

_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, float, dict]] = {}  # key -> (stored_at, ttl, row)


def _home_key() -> str:
    from hermes_constants import hermes_home_key

    return hermes_home_key()


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else None


def snapshot_to_row(provider: str, snapshot: Any) -> dict:
    """Wire shape for one provider. ``remaining_percent`` is derived here so every client agrees."""
    windows = []
    for window in getattr(snapshot, "windows", ()) or ():
        used = getattr(window, "used_percent", None)
        remaining = None if used is None else max(0.0, min(100.0, 100.0 - float(used)))
        windows.append({
            "label": window.label,
            "used_percent": None if used is None else float(used),
            "remaining_percent": remaining,
            "resets_at": _iso(getattr(window, "reset_at", None)),
            "detail": getattr(window, "detail", None),
            "scope": getattr(window, "scope", "account"),
        })
    return {
        "provider": provider,
        "title": getattr(snapshot, "title", None),
        "plan": getattr(snapshot, "plan", None),
        "source": getattr(snapshot, "source", None),
        "fetched_at": _iso(getattr(snapshot, "fetched_at", None)),
        "windows": windows,
        "details": list(getattr(snapshot, "details", ()) or ()),
        "unavailable_reason": getattr(snapshot, "unavailable_reason", None),
        "state": "unavailable" if getattr(snapshot, "unavailable_reason", None) else "ready",
    }


def _unavailable(provider: str, reason: str) -> dict:
    return {"provider": provider, "title": None, "plan": None, "source": None, "fetched_at": None,
            "windows": [], "details": [], "unavailable_reason": reason, "state": "unavailable"}


def _fetch_one(provider: str, fetch: Callable[..., Any]) -> dict:
    try:
        snapshot = fetch(provider)
    except Exception as exc:  # fail open: one provider's outage must not blank the rest
        _log.debug("usage overview: %s fetch failed: %s", provider, type(exc).__name__)
        return _unavailable(provider, "fetch failed")
    if snapshot is None:
        return _unavailable(provider, "no usage data")
    return snapshot_to_row(provider, snapshot)


def usage_overview(
    providers: Iterable[str],
    *,
    fetch: Optional[Callable[..., Any]] = None,
    now: Optional[float] = None,
    force: bool = False,
) -> list[dict]:
    """One row per provider slug, input order preserved, duplicates collapsed.

    ``fetch`` and ``now`` are injectable for tests; ``force`` skips the TTL (explicit refresh).
    """
    if fetch is None:
        from agent.account_usage import fetch_account_usage as fetch  # type: ignore[assignment]

    clock = time.time() if now is None else now
    home = _home_key()
    slugs = list(dict.fromkeys(str(p or "").strip().lower() for p in providers if str(p or "").strip()))

    rows: dict[str, dict] = {}
    todo: list[str] = []
    with _lock:
        for slug in slugs:
            hit = _cache.get((home, slug))
            if hit and not force and clock - hit[0] < hit[1]:
                rows[slug] = hit[2]
            else:
                todo.append(slug)

    if todo:
        with ThreadPoolExecutor(max_workers=min(8, len(todo))) as pool:
            futures = {slug: pool.submit(_fetch_one, slug, fetch) for slug in todo}
            for slug, future in futures.items():
                try:
                    row = future.result(timeout=FETCH_DEADLINE_S)
                except Exception:
                    row = _unavailable(slug, "timed out")
                rows[slug] = row
                ttl = OK_TTL_S if row["state"] == "ready" else FAIL_TTL_S
                with _lock:
                    _cache[(home, slug)] = (clock, ttl, row)

    return [rows[slug] for slug in slugs]


def clear_cache() -> None:
    with _lock:
        _cache.clear()
