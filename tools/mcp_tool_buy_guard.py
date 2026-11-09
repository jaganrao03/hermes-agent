"""Fail-closed classification for order-submission calls through Hermes MCP."""

import re
from typing import Any, Optional

from tools.registry import tool_error


def buy_submission_error(server_name: str, tool_name: str, arguments: Any) -> Optional[str]:
    """Return an error before transport for BUY-capable or ambiguous order routes.

    This boundary deliberately denies BUYs rather than trying to infer approval from prompts,
    tool metadata, or caller labels. Sells remain available when their side is unambiguous.
    """
    server = server_name.casefold().replace("-", "_") if isinstance(server_name, str) else ""
    server_tokens = set(server.split("_"))
    if "robinhood" not in server and "rh" not in server_tokens:
        return None
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
            return tool_error("BUY guard blocks BUY order submissions through Hermes MCP")

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
