"""Ownership acknowledgement must survive transient ledger contention, never bypass it."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from contextlib import closing, contextmanager
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.fixture
def handoff(monkeypatch):
    from cron import executions, scheduler

    with tempfile.TemporaryDirectory(prefix="worker-handoff-") as directory:
        root = Path(directory)
        monkeypatch.chdir(root)
        profile = root / "profile"
        monkeypatch.setenv("HERMES_HOME", str(profile))
        monkeypatch.setattr(executions, "EXECUTIONS_FILE", profile / "cron/executions.db")
        record = executions.create_execution("job-contention", source="builtin")
        assert executions.mark_execution_handoff_pending(record["id"]) is not None
        payload = root / "payload.json"
        ack = root / "worker.ready"
        payload.write_text(json.dumps({
            "job": {"id": "job-contention", "execution_id": record["id"]},
            "profile_home": str(profile),
        }))
        run = Mock(return_value=True)
        monkeypatch.setattr(scheduler, "run_one_job", run)
        yield executions, scheduler, record, payload, ack, run


def test_worker_acknowledges_only_after_contended_adoption_commits(handoff, monkeypatch):
    executions, scheduler, _record, payload, ack, run = handoff
    original_connect = executions._connect
    blocker = sqlite3.connect(executions.EXECUTIONS_FILE)
    opened = []
    retries = []

    def contended_connect():
        conn = original_connect()
        conn.execute("PRAGMA busy_timeout=0")
        opened.append(conn)
        if len(opened) == 1:
            blocker.execute("BEGIN IMMEDIATE")
        return conn

    def release_on_retry(_delay):
        # A failed adoption must have closed its connection and published nothing.
        assert not ack.exists()
        run.assert_not_called()
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            opened[-1].execute("SELECT 1")
        assert blocker.execute("SELECT status FROM executions WHERE id=?", (record["id"],)).fetchone()[0] == "claimed"
        retries.append(True)
        blocker.rollback()

    monkeypatch.setattr(executions, "_connect", contended_connect)
    monkeypatch.setattr(executions.time, "sleep", release_on_retry)
    try:
        assert scheduler._run_external_worker_payload(payload, ack) is True
    finally:
        blocker.close()

    assert len(retries) == 1
    assert len(opened) == 2
    run.assert_called_once()
    assert json.loads(ack.read_text()) == {"pid": os.getpid(), "execution_id": record["id"]}
    with closing(original_connect()) as conn:
        row = conn.execute("SELECT status, handoff_pending, pid FROM executions WHERE id=?", (record["id"],)).fetchone()
        assert tuple(row) == ("running", 0, os.getpid())
    assert executions.adopt_claimed_execution(record["id"]) is None


@pytest.mark.parametrize("error", ["database is locked", "database is busy", "database table is locked", "no such table: executions"])
def test_worker_never_acknowledges_when_adoption_fails(handoff, monkeypatch, error):
    executions, scheduler, _record, payload, ack, run = handoff
    attempts = []

    @contextmanager
    def broken_transaction():
        attempts.append(True)
        raise sqlite3.OperationalError(error)
        yield  # pragma: no cover

    monkeypatch.setattr(executions, "_transaction", broken_transaction)
    monkeypatch.setattr(executions.time, "sleep", lambda _delay: None)
    with pytest.raises(sqlite3.OperationalError, match=error):
        scheduler._run_external_worker_payload(payload, ack)
    assert len(attempts) == (3 if error in ("database is locked", "database is busy") else 1)
    assert not ack.exists()
    run.assert_not_called()


def test_worker_does_not_acknowledge_if_claim_changes_during_retry(handoff, monkeypatch):
    executions, scheduler, _record, payload, ack, run = handoff
    original_transaction = executions._transaction
    attempts = []

    @contextmanager
    def initially_busy():
        attempts.append(True)
        if len(attempts) == 1:
            raise sqlite3.OperationalError("database is locked")
        with original_transaction() as conn:
            yield conn

    def withdraw_handoff(_delay):
        with original_transaction() as conn:
            conn.execute("UPDATE executions SET handoff_pending=0 WHERE id=?", (record["id"],))

    monkeypatch.setattr(executions, "_transaction", initially_busy)
    monkeypatch.setattr(executions.time, "sleep", withdraw_handoff)
    assert scheduler._run_external_worker_payload(payload, ack) is False
    assert len(attempts) == 2
    assert not ack.exists()
    run.assert_not_called()
