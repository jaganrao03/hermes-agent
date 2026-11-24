"""``GET /api/usage/limits`` — plan windows and wallet balances for the webapp's limits popover.

One row per signed-in provider that can report usage (Codex/Anthropic windows, OpenRouter and
DeepSeek balances, ...), served from a 60 s cache. Read-only; the payload never contains a token.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter
from starlette.concurrency import run_in_threadpool

from hermes_cli.web_deps import late
from hermes_cli.web_routers._common import http_failure

_log = logging.getLogger(__name__)
router = APIRouter()

_config_profile_scope = late("_config_profile_scope", "hermes_cli.web_server_profiles")


def _usage_capable_providers() -> list[dict]:
    """Signed-in providers whose usage can be read, as ``{slug, name}`` in picker order."""
    from agent.account_usage_cache import has_account_usage
    from hermes_cli.inventory import build_model_options_payload, load_picker_context

    payload = build_model_options_payload(load_picker_context())
    out: list[dict] = []
    for row in payload.get("providers", []):
        slug = str(row.get("slug") or "").strip().lower()
        if not slug or row.get("is_user_defined") or row.get("authenticated") is False:
            continue
        if has_account_usage(slug):
            out.append({"slug": slug, "name": str(row.get("name") or slug)})
    return out


def _build(profile: Optional[str], force: bool) -> dict:
    from agent.usage_overview import usage_overview

    with _config_profile_scope(profile):
        providers = _usage_capable_providers()
        rows = usage_overview([p["slug"] for p in providers], force=force)
    names = {p["slug"]: p["name"] for p in providers}
    for row in rows:
        row["name"] = names.get(row["provider"], row["provider"])
    return {"providers": rows}


@router.get("/api/usage/limits")
async def get_usage_limits(profile: Optional[str] = None, refresh: bool = False):
    """``{"providers": [{provider, name, plan, windows[], details[], state, ...}]}``.

    ``windows[].remaining_percent`` is what is LEFT (100 - used). ``details`` carries dollar
    balances as display text. ``refresh=1`` bypasses the cache (an explicit refresh button).
    """
    with http_failure("GET /api/usage/limits failed", 500, detail="Failed to read usage limits"):
        return await run_in_threadpool(_build, profile, bool(refresh))
