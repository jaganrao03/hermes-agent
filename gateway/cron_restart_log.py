"""Append-only record of cron jobs interrupted by a gateway restart (2026-11-18).

WHY: an interrupted cron run left only two weak traces — a counter in the drain line
(``cron_at_start=1, cron_now=0``) and, sometimes, the job's own paused/unverified
admission row. Naming the job ("agentic-trading-run (Mon-Thu) was killed mid buy review
at 13:20") meant grepping agent.log and reconstructing the run by hand, and a job that
self-aborted on gateway disconnect left no cron-side trace at all.

WHAT: one JSON line per interrupted job, appended to
``$HERMES_HOME/logs/cron-restart-interruptions.jsonl``, plus a WARNING per job and a
best-effort ``cron_incidents`` row so the incident is visible from the incident list.
Records are append-only: nothing is ever rewritten or deleted, and a failure here must
never break the shutdown path (the gateway is already stopping).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# One record per job per gateway process: the stop path records the same job from more
# than one phase (post-interrupt sweep, then finalize), and a double line reads like two
# interruptions. Keyed by pid so each restart writes its own record.
_RECORDED: set[tuple[str, int]] = set()
_RECORDED_LOCK = threading.Lock()

# Two dispositions, because they need different handling by a human:
#   killed     — still executing when a drain deadline expired and the sweep killed its tools.
#   abandoned  — gone from the scheduler without a clean finish (e.g. its worker saw the
#                gateway disconnect and paused itself with an unverified admission).
DISPOSITIONS = ("killed", "abandoned")


def _log_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    return home / "logs" / "cron-restart-interruptions.jsonl"


def _job_name(job_id: str) -> str:
    """Best-effort job name; the id alone when the store can't be read."""
    try:
        from cron.jobs import get_job

        job = get_job(job_id) or {}
        return str(job.get("name") or job_id)
    except Exception:                       # naming must never break shutdown
        return job_id


def _record_incident(job_id: str, job_name: str, reason: str) -> None:
    """Surface the interruption in the incident list too (best-effort)."""
    try:
        from cron.incidents import upsert_incident

        upsert_incident(
            job_id, reason, job_name=job_name, failure_type="restart_interrupted",
        )
    except Exception as exc:
        logger.debug("cron interruption incident write failed for %s: %s", job_id, exc)


def record_interruptions(
    job_ids: Iterable[str], *, phase: str, reason: str, disposition: str = "killed",
) -> list[dict[str, Any]]:
    """Append one record per interrupted job; returns the records written.

    Idempotent within a call (duplicate ids collapse) and safe to call from the shutdown
    path: every failure is swallowed after a debug line.
    """
    if disposition not in DISPOSITIONS:
        raise ValueError(f"unknown disposition {disposition!r}; expected one of {DISPOSITIONS}")
    ids = [str(j) for j in dict.fromkeys(job_ids or []) if j]
    if not ids:
        return []

    pid = os.getpid()
    with _RECORDED_LOCK:
        ids = [j for j in ids if (j, pid) not in _RECORDED]
        _RECORDED.update((j, pid) for j in ids)
    if not ids:
        return []                           # already recorded by an earlier shutdown phase

    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    records: list[dict[str, Any]] = []
    for job_id in ids:
        job_name = _job_name(job_id)
        records.append({
            "ts": stamp,
            "event": "cron_interrupted_by_restart",
            "job_id": job_id,
            "job_name": job_name,
            "phase": phase,
            "disposition": disposition,
            "reason": reason,
            "gateway_pid": os.getpid(),
        })

    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:      # append-only, never truncate
            for record in records:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:
        logger.debug("cron interruption log write failed: %s", exc)

    for record in records:
        logger.warning(
            "Cron job interrupted by restart: %s (%s) phase=%s disposition=%s — %s",
            record["job_name"], record["job_id"], phase, disposition, reason,
        )
        _record_incident(record["job_id"], record["job_name"], reason)

    return records


def job_finished_cleanly(job_id: str) -> bool:
    """True when the job's newest execution completed AND the job is not paused.

    A job that self-paused with an unverified admission (the restart-disconnect path) is
    NOT clean even though no execution row says 'running' any more.
    """
    try:
        from cron.jobs import get_job

        job = get_job(job_id) or {}
        if job.get("paused") or job.get("pause_reason"):
            return False
    except Exception:
        return False
    try:
        import sqlite3

        home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
        db = home / "cron" / "executions.db"
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute(
                "SELECT status FROM executions WHERE job_id=? ORDER BY started_at DESC LIMIT 1",
                (job_id,),
            ).fetchone()
        finally:
            con.close()
        return bool(row) and str(row[0]) == "completed"
    except Exception:
        return False
