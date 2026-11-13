"""Fail-closed classification for order-submission calls through Hermes MCP.

SINGLE SOURCE OF TRUTH (2026-11-12): this file is deployed BYTE-IDENTICAL to both app trees —
  ~/.hermes/hermes-agent/tools/mcp_tool_buy_guard.py   (the buy handoff / oneshot CLI tree)
  ~/dev/hermes-agent-fork/tools/mcp_tool_buy_guard.py  (the running gateway tree)
They previously held two different rules, so which BUY was permitted depended on which process asked.
Edit ONE copy, copy it over the other, and run ~/.hermes/scripts/tests/test-buy-guard-single-rule.py.
"""

import re
from typing import Any, Optional

from tools.registry import tool_error

AGENTIC_ACCOUNT = "997604194"


def _is_robinhood(server_name: Any) -> bool:
    """True only for the Robinhood MCP servers ('robinhood', 'rh', 'robin-hood', ...)."""
    server = server_name.casefold().replace("-", "_") if isinstance(server_name, str) else ""
    return "robinhood" in server or "rh" in set(server.split("_"))


def buy_submission_error(server_name: str, tool_name: str, arguments: Any) -> Optional[str]:
    """Return an error before transport for BUY-capable or ambiguous order routes.

    Exactly ONE buy route is allowed: place_equity_order on a Robinhood MCP server, and — when the call
    states the account — only Jagan's Agentic account (997604194). Crypto, option, "advanced", generic
    and ambiguous order routes stay denied on every server. Sells and read-only order calls pass.
    This does not replace the downstream rulebook, buy guard, signal ledger, broker or approval checks.
    """
    if (
        not isinstance(tool_name, str)
        or not tool_name
        or not tool_name.isascii()
        or any(char.isspace() for char in tool_name)
    ):
        return tool_error("BUY guard blocks malformed or non-canonical tool names")

    name = tool_name.casefold().rsplit("/", 1)[-1].rsplit(".", 1)[-1]
    name = name.rsplit("__", 1)[-1]
    if name == "exercise_option":
        return tool_error("BUY guard blocks option exercise through Hermes MCP")
    if (name == "buy" or re.search(r"(^|_)(buy|purchase|sell_to_open)(_|$)", name)
            or name.startswith(("submit_trade", "execute_trade", "place_trade", "open_trade"))
            or name == "trade"):
        return tool_error("BUY guard blocks BUY-capable submission tools through Hermes MCP")
    if name.startswith("place_") and not name.endswith("_order"):
        return tool_error("BUY guard blocks non-canonical order tool names")
    if (
        re.search(r"(^|_)orders?(_|$)", name)
        and not name.startswith(("get_", "list_", "search_", "review_", "cancel_"))
        and not (name.startswith("place_") and name.endswith("_order"))
    ):
        return tool_error("BUY guard blocks unrecognized order mutation tool names")
    if not (name.startswith("place_") and name.endswith("_order")):
        return None
    if not isinstance(arguments, dict):
        return tool_error("BUY guard blocks ambiguous order arguments")

    side = arguments.get("side")
    if side is not None:
        if not isinstance(side, str) or side.casefold() not in {"buy", "sell"}:
            return tool_error("BUY guard blocks ambiguous order side")
        if side.casefold() == "buy":
            if not (_is_robinhood(server_name) and name == "place_equity_order"):
                return tool_error("BUY guard blocks BUY order submissions through Hermes MCP")
            stated = arguments.get("account_number")
            if stated not in (None, "") and str(stated) != AGENTIC_ACCOUNT:
                return tool_error("BUY guard blocks BUY on a Robinhood account other than the Agentic account")

    if name == "place_option_order":
        legs = arguments.get("legs")
        if not isinstance(legs, list) or not legs:
            return tool_error("BUY guard blocks ambiguous option-order legs")
        for leg in legs:
            if not isinstance(leg, dict):
                return tool_error("BUY guard blocks ambiguous option-order legs")
            leg_side = leg.get("side")
            if not isinstance(leg_side, str) or leg_side.casefold() not in {"buy", "sell"}:
                return tool_error("BUY guard blocks ambiguous option-order side")
            if leg_side.casefold() == "buy":
                return tool_error("BUY guard blocks BUY option legs through Hermes MCP")
        return None

    if side is None:
        return tool_error("BUY guard blocks ambiguous order side")
    return None
