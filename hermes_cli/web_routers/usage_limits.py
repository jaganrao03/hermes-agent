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


_BUILTIN_NAMES = {"anthropic": "Anthropic", "openai-codex": "OpenAI Codex", "openrouter": "OpenRouter"}


def _usage_capable_providers() -> list[dict]:
    """Every provider that CAN report usage, as ``{slug, name}`` — not just the model picker's.

    The picker lists providers with models configured; a signed-in subscription that is not in
    the picker (e.g. Codex with its weekly window spent) still has limits worth showing. A
    provider with no credentials simply returns no snapshot and is hidden by the client.
    """
    from agent.account_usage import _USAGE_FETCHERS
    from providers import list_providers
    from providers.base import ProviderProfile

    out: dict[str, str] = {slug: _BUILTIN_NAMES.get(slug, slug) for slug in sorted(_USAGE_FETCHERS)}
    for profile in list_providers():
        if type(profile).fetch_account_usage is ProviderProfile.fetch_account_usage:
            continue
        out.setdefault(profile.name, profile.display_name or _BUILTIN_NAMES.get(profile.name, profile.name))
    return [{"slug": slug, "name": name} for slug, name in out.items()]


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
