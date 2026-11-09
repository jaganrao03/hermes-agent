"""Write a queued cron delivery's terminal outcome back onto the run that queued it.

An agent run hands its send to ``cron.delivery_queue`` and books ``last_status =
"delivery_queued"`` / ledger ``delivery_outcome = "queued"``. Once a gateway drain sends,
refuses, suppresses or fences the send ``unknown``, the job record and the execution
ledger must carry the real result (main's inline ``ok``/``delivered`` and
``delivery_failed``/``failed`` + ``last_delivery_error``); otherwise ``hermes cron list``
says "delivery still in progress" forever and refused sends never surface.

Both sides call :func:`settle_queued_delivery`: the drain right after it terminalizes a
row, and the run right after its own bookkeeping (a drain can finish before the run's
``mark_job_run`` lands). Every write is fenced on the execution id, so the call is
idempotent and never rewrites a later run's status.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Queue terminal status -> ledger delivery_outcome. ``unknown`` (owner died mid-send, never
# retried) is surfaced as a failure: the user cannot be told the result arrived.
_LEDGER_OUTCOME = {
    "delivered": "delivered", "suppressed": "suppressed", "failed": "failed", "unknown": "failed",
}


def _settle_job_record(
    job_id: str, execution_id: str, delivery_error: Optional[str], *,
    bot_chat_delivery_ids: Optional[tuple[str, ...]] = None,
) -> bool:
    """Stamp the outcome onto the job only while *execution_id* is still its current run:
    the ledger's latest attempt for the job AND the job's latest recorded completion."""
    from cron.executions import latest_execution
    from cron.jobs import _with_job, save_jobs

    latest = latest_execution(job_id)
    if latest is None or latest.get("id") != execution_id:
        return False

    def apply(jobs, _i, job):
        completions = job.get("canonical_completions") or []
        if completions:
            if completions[-1] != execution_id:
                return False
        else:
            # Older/direct cron jobs may predate canonical_completions. Permit their
            # write-back only when the still-queued job names this exact Bot Chat receipt.
            queued = job.get("last_delivery_queued") or {}
            queued_ids = {item.get("delivery_id") for item in queued.values()
                          if isinstance(item, dict)} if isinstance(queued, dict) else set()
            if (job.get("last_status") != "delivery_queued" or not bot_chat_delivery_ids
                    or not set(bot_chat_delivery_ids).issubset(queued_ids)):
                return False
        status = job.get("last_status")
        if status == "delivery_queued":
            status = "delivery_failed" if delivery_error else "ok"
        if (status, delivery_error) == (job.get("last_status"), job.get("last_delivery_error")):
            return True
        job["last_status"] = status
        job["last_delivery_error"] = delivery_error
        save_jobs(jobs)
        return True

    return bool(_with_job(job_id, apply, missing=False))


def _bot_chat_terminal(job: Optional[dict]) -> Optional[tuple[str, Optional[str], tuple[str, ...]]]:
    """Read terminal Bot Chat receipts still referenced by a job's queued outcome."""
    if not isinstance(job, dict):
        return None
    queued = job.get("last_delivery_queued")
    if not isinstance(queued, dict):
        return None
    targets = [(target, item) for target, item in queued.items()
               if isinstance(target, str) and target.startswith("bot-chat:")
               and isinstance(item, dict) and item.get("delivery_id")]
    if not targets:
        return None

    from hermes_constants import get_hermes_home
    from tools.bot_live_delivery import read_delivery_result

    outcomes = []
    settled_ids = []
    for _target, item in targets:
        delivery_id = str(item["delivery_id"])
        receipt = read_delivery_result(get_hermes_home(), delivery_id)
        if not isinstance(receipt, dict):
            return None
        status = receipt.get("status")
        if status in ("queued", "claimed", None):
            return None
        if status == "settled":
            outcomes.append(("delivered", None))
        elif status == "suppressed":
            outcomes.append(("suppressed", None))
        elif status in ("failed", "cancelled", "ambiguous"):
            outcomes.append(("failed", f"Bot Chat delivery receipt ended with status '{status}'"))
        else:
            return None
        settled_ids.append(delivery_id)

    failure = next((item for item in outcomes if item[0] == "failed"), None)
    if failure:
        outcome, error = failure
    elif any(item[0] == "delivered" for item in outcomes):
        outcome, error = "delivered", None
    else:
        outcome, error = "suppressed", None
    # The legacy job-record fence below requires exact receipt associations.
    return outcome, error, tuple(settled_ids)


def _terminal(
    execution_id: str, job: Optional[dict] = None,
) -> Optional[tuple[str, Optional[str], Optional[tuple[str, ...]]]]:
    """``(ledger_outcome, delivery_error, bot_chat_delivery_ids)`` once terminal, else None."""
    from cron.delivery_queue import get_status

    row = get_status(str(execution_id))
    if row is not None:
        if row["status"] not in _LEDGER_OUTCOME:
            return None
        delivery_error = None
        if row["status"] in ("failed", "unknown"):
            delivery_error = str(row.get("error") or f"delivery {row['status']}")
        return _LEDGER_OUTCOME[row["status"]], delivery_error, None
    return _bot_chat_terminal(job)


def settled_outcome(execution_id: str, job_id: Optional[str] = None) -> Optional[str]:
    """Terminal delivery outcome for *execution_id* (None while all routes are pending)."""
    job = None
    if job_id:
        from cron.jobs import get_job
        job = get_job(str(job_id))
    terminal = _terminal(execution_id, job)
    return terminal[0] if terminal else None


def settle_queued_delivery(job_id: Optional[str], execution_id: Optional[str]) -> bool:
    """Apply a terminal queue or Bot Chat outcome for *execution_id*; False while pending."""
    if not job_id or not execution_id:
        return False
    from cron.jobs import get_job
    job = get_job(str(job_id))
    terminal = _terminal(str(execution_id), job)
    if terminal is None:
        return False
    from cron.executions import settle_delivery_outcome

    settle_delivery_outcome(str(execution_id), terminal[0])
    return _settle_job_record(
        str(job_id), str(execution_id), terminal[1], bot_chat_delivery_ids=terminal[2]
    )


def settle_quietly(job_id: Optional[str], execution_id: Optional[str]) -> None:
    """Bookkeeping failure must not undo a terminal at-most-once send or fail its run."""
    try:
        settle_queued_delivery(job_id, execution_id)
    except Exception:
        logger.warning("Cron delivery %s: outcome write-back failed", execution_id, exc_info=True)


def reconcile_pending_deliveries() -> int:
    """Recheck queued outcomes each scheduler tick; Bot Chat settles independently of cron."""
    from cron.executions import latest_execution
    from cron.jobs import load_jobs

    reconciled = 0
    for job in load_jobs():
        if not isinstance(job, dict) or job.get("last_status") != "delivery_queued":
            continue
        job_id = job.get("id")
        if not isinstance(job_id, str) or not job_id:
            continue
        execution = latest_execution(job_id)
        if not execution or execution.get("status") not in ("completed", "failed", "unknown"):
            continue
        try:
            if settle_queued_delivery(job_id, str(execution["id"])):
                reconciled += 1
        except Exception:
            logger.warning("Cron delivery %s: periodic outcome reconciliation failed",
                           execution.get("id"), exc_info=True)
    return reconciled
