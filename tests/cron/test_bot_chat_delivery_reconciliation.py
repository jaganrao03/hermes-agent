"""Settled live Bot Chat receipts reconcile queued cron outcomes without resending."""

from cron import delivery_outcome, executions, jobs
from tools import bot_live_delivery


def test_tick_reconciliation_settles_a_finished_bot_chat_receipt(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")

    job = jobs.create_job(prompt="result", schedule="every 1h", deliver="bot-chat")
    delivery_id = "a" * 64
    queued = {"bot-chat:(own)": {"status": "queued", "delivery_id": delivery_id}}
    jobs.update_job(job["id"], {
        "last_status": "delivery_queued",
        "last_delivery_error": None,
        "last_delivery_queued": queued,
    })
    execution = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(execution["id"])
    executions.finish_execution(execution["id"], success=True, delivery_outcome="queued")

    with bot_live_delivery._locked(tmp_path) as root:
        bot_live_delivery._write(root / f"{delivery_id}.json", {
            "delivery_id": delivery_id,
            "status": "settled",
            "profile_home": str(tmp_path.resolve()),
            "session_id": "test-session",
            "message": "daily-audit result",
            "reply": "settled",
        })

    assert delivery_outcome.settled_outcome(execution["id"], job["id"]) == "delivered"
    assert delivery_outcome.reconcile_pending_deliveries() == 1
    saved_job = jobs.get_job(job["id"])
    saved_execution = executions.get_execution(execution["id"])
    assert saved_job is not None and saved_job["last_status"] == "ok"
    assert saved_job["last_delivery_error"] is None
    assert saved_execution is not None and saved_execution["delivery_outcome"] == "delivered"


def test_pending_bot_chat_receipt_does_not_reconcile(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")
    job = jobs.create_job(prompt="result", schedule="every 1h", deliver="bot-chat")
    delivery_id = "b" * 64
    jobs.update_job(job["id"], {
        "last_status": "delivery_queued",
        "last_delivery_queued": {"bot-chat:(own)": {"status": "queued", "delivery_id": delivery_id}},
    })
    execution = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(execution["id"])
    executions.finish_execution(execution["id"], success=True, delivery_outcome="queued")
    with bot_live_delivery._locked(tmp_path) as root:
        bot_live_delivery._write(root / f"{delivery_id}.json", {
            "delivery_id": delivery_id,
            "status": "claimed",
            "profile_home": str(tmp_path.resolve()),
            "session_id": "test-session",
            "message": "daily-audit result",
            "reply": "",
        })

    assert delivery_outcome.reconcile_pending_deliveries() == 0
    saved_job = jobs.get_job(job["id"])
    saved_execution = executions.get_execution(execution["id"])
    assert saved_job is not None and saved_job["last_status"] == "delivery_queued"
    assert saved_execution is not None and saved_execution["delivery_outcome"] == "queued"


def test_superseded_execution_still_settles_its_delivery_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")
    job = jobs.create_job(prompt="result", schedule="every 1h", deliver="bot-chat")
    old = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(old["id"])
    executions.finish_execution(old["id"], success=True, delivery_outcome="queued")
    newer = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(newer["id"])
    executions.finish_execution(newer["id"], success=True, delivery_outcome="delivered")
    monkeypatch.setattr(delivery_outcome, "_terminal", lambda *_args: ("delivered", None, None))

    assert delivery_outcome.settle_queued_delivery(job["id"], old["id"]) is False
    saved = executions.get_execution(old["id"])
    assert saved is not None and saved["delivery_outcome"] == "delivered"


def test_deleted_job_still_settles_its_delivery_ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")
    job = jobs.create_job(prompt="result", schedule="every 1h", deliver="bot-chat")
    execution = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(execution["id"])
    executions.finish_execution(execution["id"], success=True, delivery_outcome="queued")
    assert jobs.remove_job(job["id"])
    monkeypatch.setattr(delivery_outcome, "_terminal", lambda *_args: ("delivered", None, None))

    assert delivery_outcome.settle_queued_delivery(job["id"], execution["id"]) is False
    saved = executions.get_execution(execution["id"])
    assert saved is not None and saved["delivery_outcome"] == "delivered"


def test_tick_housekeeping_runs_delivery_reconciliation(monkeypatch):
    from types import SimpleNamespace

    from cron import bot_chat_legacy, scheduler_authority, scheduler_tick

    calls = []
    monkeypatch.setattr(scheduler_authority, "reconcile_pending", lambda **_kwargs: None)
    monkeypatch.setattr(bot_chat_legacy, "drain_legacy_pending", lambda: None)
    monkeypatch.setattr(delivery_outcome, "reconcile_pending_deliveries", lambda: calls.append(True))
    scheduler = SimpleNamespace(_maybe_reap_dead_owners=lambda: None, logger=SimpleNamespace(
        warning=lambda *_args, **_kwargs: None))

    scheduler_tick._pre_dispatch_housekeeping(scheduler, headless=False)

    assert calls == [True]
