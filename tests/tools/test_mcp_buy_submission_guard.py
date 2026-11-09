"""Offline safety contract for BUY submissions through Hermes' MCP handler."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from tools import mcp_tool_handlers as handlers


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("place_equity_order", {"side": "buy", "symbol": "TEST"}),
        ("robinhood__place_equity_order", {"side": "BUY", "symbol": "TEST"}),
        ("place_advanced_order", {"side": "BUY", "symbol": "TEST"}),
        ("place_crypto_order", {"side": "buy", "symbol": "TEST"}),
        (
            "place_option_order",
            {"legs": [{"side": "sell"}, {"side": "buy"}]},
        ),
        ("exercise_option", {"option_id": "offline-fixture"}),
        (" place_equity_order", {"side": "sell", "symbol": "TEST"}),
        ("place_equity_order ", {"side": "sell", "symbol": "TEST"}),
        ("place_equity_order_v2", {"side": "sell", "symbol": "TEST"}),
        ("submit_order", {"side": "sell", "symbol": "TEST"}),
        ("order_submit", {"side": "sell", "symbol": "TEST"}),
        (None, {}),
        # A newly introduced order tool without a recognizable side fails closed.
        ("place_future_order", {"symbol": "TEST"}),
        ("place_equity_order", {"side": "hold", "symbol": "TEST"}),
        ("place_option_order", {"legs": []}),
        ("buy_equity", {"symbol": "TEST"}),
        ("purchase_shares", {"symbol": "TEST"}),
        ("buy", {}),
        ("market_buy", {"symbol": "TEST"}),
        ("submit_trade", {"symbol": "TEST"}),
        ("execute_trade", {"symbol": "TEST"}),
        ("sell_to_open", {"symbol": "TEST"}),
    ],
)
def test_buy_and_ambiguous_submission_routes_are_blocked_before_transport(tool, arguments):
    with patch.object(handlers, "_acquire_call_server", return_value=(None, '{"error":"offline"}')) as acquire:
        raw = handlers._make_tool_handler("robinhood", tool, 1.0)(arguments)

    result = json.loads(raw)
    assert "error" in result
    assert "BUY" in result["error"] or "ambiguous" in result["error"].lower()
    acquire.assert_not_called()


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("place_equity_order", {"side": "sell", "symbol": "TEST"}),
        ("place_advanced_order", {"side": "sell", "symbol": "TEST"}),
        ("place_crypto_order", {"side": "sell", "symbol": "TEST"}),
        ("place_option_order", {"legs": [{"side": "sell"}]}),
        ("place_future_order", {"side": "sell", "symbol": "TEST"}),
        ("get_equity_orders", {}),
    ],
)
def test_clear_sell_and_read_calls_are_not_blocked_by_buy_guard(tool, arguments):
    with patch.object(handlers, "_acquire_call_server", return_value=(None, '{"error":"offline"}')) as acquire:
        raw = handlers._make_tool_handler("robinhood", tool, 1.0)(arguments)

    assert json.loads(raw) == {"error": "offline"}
    acquire.assert_called_once()


@pytest.mark.parametrize("server", ["robinhood_mcp", "rh", "robinhood_agentic"])
def test_aliased_trading_server_still_gets_buy_guard(server):
    with patch.object(handlers, "_acquire_call_server") as acquire:
        raw = handlers._make_tool_handler(server, "buy", 1.0)({})

    assert "BUY" in json.loads(raw)["error"]
    acquire.assert_not_called()


def test_plugin_context_mcp_call_is_stopped_by_same_guard_before_transport():
    from hermes_cli.plugins import PluginContext
    from hermes_cli.plugins_manifest import PluginManifest

    context = PluginContext(PluginManifest(name="offline-test"), MagicMock())
    with patch.object(PluginContext, "_mcp_allowlist", return_value=["robinhood"]), \
         patch.object(handlers, "_acquire_call_server") as acquire:
        result = context.call_mcp(
            "robinhood", "place_equity_order", {"side": "buy", "symbol": "TEST"}
        )

    assert result["ok"] is False
    assert "BUY" in result["error"]
    acquire.assert_not_called()


@pytest.mark.parametrize("tool", ["set_border_color", "place_order", "reorder_items"])
def test_non_trading_server_tools_are_not_blocked(tool):
    with patch.object(handlers, "_acquire_call_server", return_value=(None, '{"error":"offline"}')) as acquire:
        raw = handlers._make_tool_handler("shopping", tool, 1.0)({})

    assert json.loads(raw) == {"error": "offline"}
    acquire.assert_called_once()


def test_discovered_mcp_tool_registration_cannot_bypass_guard():
    from tools.mcp_tool_registration import _tool_candidates

    tool = SimpleNamespace(
        name="place_equity_order",
        description="Offline order fixture",
        inputSchema={"type": "object", "properties": {"side": {"type": "string"}}},
        annotations=None,
    )
    candidate = _tool_candidates("robinhood", [tool], lambda _name: True, 1.0)[0]

    with patch.object(handlers, "_acquire_call_server") as acquire:
        result = json.loads(candidate.handler({"side": "buy"}))

    assert "BUY" in result["error"]
    acquire.assert_not_called()

