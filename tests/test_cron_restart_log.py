"""Tests for the cron-restart interruption record (gateway/cron_restart_log.py).

Contract: every job a restart interrupts leaves exactly ONE durable JSONL line per
gateway process, plus a WARNING and a best-effort incident row; nothing here may raise
into the shutdown path; the log is append-only.
"""
import importlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class CronRestartLogTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self._env.start()
        self.mod = importlib.import_module("gateway.cron_restart_log")
        importlib.reload(self.mod)                     # fresh per-process dedupe set
        self.log = self.home / "logs" / "cron-restart-interruptions.jsonl"

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _lines(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]

    def test_writes_one_record_per_job(self):
        recs = self.mod.record_interruptions(
            ["c7e2b9f61af8", "36a877444470"],
            phase="post-interrupt", disposition="killed", reason="restart",
        )
        self.assertEqual(len(recs), 2)
        rows = self._lines()
        self.assertEqual([r["job_id"] for r in rows], ["c7e2b9f61af8", "36a877444470"])
        self.assertEqual(rows[0]["event"], "cron_interrupted_by_restart")
        self.assertEqual(rows[0]["disposition"], "killed")
        self.assertEqual(rows[0]["phase"], "post-interrupt")
        self.assertEqual(rows[0]["gateway_pid"], os.getpid())

    def test_second_phase_does_not_duplicate(self):
        self.mod.record_interruptions(["job-a"], phase="post-interrupt", disposition="killed", reason="r1")
        again = self.mod.record_interruptions(["job-a"], phase="final-cleanup", disposition="killed", reason="r2")
        self.assertEqual(again, [])
        self.assertEqual(len(self._lines()), 1)

    def test_duplicate_ids_in_one_call_collapse(self):
        self.mod.record_interruptions(["job-a", "job-a"], phase="p", disposition="killed", reason="r")
        self.assertEqual(len(self._lines()), 1)

    def test_no_file_for_empty_input(self):
        self.assertEqual(self.mod.record_interruptions([], phase="p", reason="r"), [])
        self.assertEqual(self.mod.record_interruptions(None, phase="p", reason="r"), [])
        self.assertFalse(self.log.exists())

    def test_unknown_disposition_is_rejected(self):
        with self.assertRaises(ValueError):
            self.mod.record_interruptions(["job-a"], phase="p", reason="r", disposition="maybe")

    def test_append_only_across_calls(self):
        self.mod.record_interruptions(["job-a"], phase="p", disposition="killed", reason="r")
        before = self.log.read_text()
        self.mod.record_interruptions(["job-b"], phase="p", disposition="abandoned", reason="r")
        after = self.log.read_text()
        self.assertTrue(after.startswith(before), "earlier records must survive untouched")
        self.assertEqual(len(self._lines()), 2)

    def test_job_name_falls_back_to_id(self):
        with mock.patch("cron.jobs.get_job", side_effect=RuntimeError("no store")):
            recs = self.mod.record_interruptions(["job-x"], phase="p", disposition="killed", reason="r")
        self.assertEqual(recs[0]["job_name"], "job-x")

    def test_incident_row_written(self):
        with mock.patch("cron.jobs.get_job", return_value={"id": "job-a", "name": "agentic-trading-run"}):
            self.mod.record_interruptions(["job-a"], phase="p", disposition="killed",
                                          reason="Gateway restart killed the run")
        db = self.home / "cron" / "executions.db"
        self.assertTrue(db.exists(), "incident write should create the cron db")
        rows = sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute(
            "SELECT job_id, failure_type FROM cron_incidents WHERE job_id='job-a'").fetchall()
        self.assertEqual(rows, [("job-a", "restart_interrupted")])

    def test_job_finished_cleanly_false_when_paused(self):
        with mock.patch("cron.jobs.get_job", return_value={"id": "job-a", "paused": True}):
            self.assertFalse(self.mod.job_finished_cleanly("job-a"))
        with mock.patch("cron.jobs.get_job", return_value={"id": "job-a", "pause_reason": "unverified admission"}):
            self.assertFalse(self.mod.job_finished_cleanly("job-a"))

    def test_job_finished_cleanly_false_without_execution_row(self):
        with mock.patch("cron.jobs.get_job", return_value={"id": "job-a"}):
            self.assertFalse(self.mod.job_finished_cleanly("job-a"))


class ShutdownWiringTests(unittest.TestCase):
    """The shutdown hook must name the jobs, not just count them."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self._env.start()
        self.mod = importlib.import_module("gateway.cron_restart_log")
        importlib.reload(self.mod)
        self.log = self.home / "logs" / "cron-restart-interruptions.jsonl"
        from gateway.run_shutdown import GatewayShutdownMixin
        self.mixin = GatewayShutdownMixin

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _rows(self):
        return [json.loads(l) for l in self.log.read_text().splitlines() if l.strip()] if self.log.exists() else []

    def test_survivors_recorded_by_shape(self):
        class Stub:
            _cron_inflight_at_shutdown = frozenset({"job-abandoned", "job-killed"})
            _record_cron_restart = self.mixin._record_cron_restart
        stub = Stub()
        with mock.patch("cron.scheduler.get_running_job_ids", return_value=frozenset({"job-killed"})), \
             mock.patch.object(self.mod, "job_finished_cleanly", side_effect=lambda j: False), \
             mock.patch("cron.jobs.get_job", return_value=None):
            self.mixin._record_cron_restart_survivors(stub)
        by_id = {r["job_id"]: r for r in self._rows()}
        self.assertEqual(by_id["job-abandoned"]["disposition"], "abandoned")
        self.assertEqual(by_id["job-killed"]["disposition"], "killed")

    def test_clean_finish_records_nothing(self):
        class Stub:
            _cron_inflight_at_shutdown = frozenset({"job-done"})
            _record_cron_restart = self.mixin._record_cron_restart
        with mock.patch("cron.scheduler.get_running_job_ids", return_value=frozenset()), \
             mock.patch.object(self.mod, "job_finished_cleanly", return_value=True), \
             mock.patch("cron.jobs.get_job", return_value=None):
            self.mixin._record_cron_restart_survivors(Stub())
        self.assertEqual(self._rows(), [])

    def test_no_snapshot_is_a_noop(self):
        class Stub:
            pass
        self.mixin._record_cron_restart_survivors(Stub())
        self.assertEqual(self._rows(), [])


if __name__ == "__main__":
    unittest.main()
