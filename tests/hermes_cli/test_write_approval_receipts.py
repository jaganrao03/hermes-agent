"""Approval cleanup failures and privacy-safe decision receipts."""
import json
import os
import tempfile
import threading
from pathlib import Path

import pytest

from hermes_cli import write_approval_commands as commands
from tools import write_approval as wa


@pytest.fixture
def isolated(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="approval-receipt-") as root:
        monkeypatch.chdir(root)
        monkeypatch.setenv("HERMES_HOME", str(Path(root) / "home"))
        yield Path(root) / "home"


def test_applied_cleanup_failure_is_explicit(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"action": "test", "content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    monkeypatch.setattr(commands, "_apply_one", lambda *args: (True, "", {}))
    monkeypatch.setattr(wa, "discard_pending", lambda *args: False)
    out = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    assert "cleanup" in out.lower()
    assert "already applied" in out.lower()
    assert wa.get_pending("skills", rec["id"])
    event = json.loads((isolated / "pending" / "approval-audit.jsonl").read_text())
    assert event["outcome"] == "cleanup_failed"


def test_cleanup_failure_cannot_replay(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"action": "test"}, summary="synthetic", origin="foreground")
    calls = []
    monkeypatch.setattr(commands, "_apply_one", lambda *args: (calls.append(1) is None, "", {}))
    monkeypatch.setattr(wa, "discard_pending", lambda *args: False)
    commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    again = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    assert calls == [1]
    assert "reconcil" in again.lower()


def test_rejection_creates_private_metadata_receipt(isolated):
    rec = wa.stage_write("skills", {"action": "test", "content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    out = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
    assert "Rejected" in out
    assert wa.get_pending("skills", rec["id"]) is None
    path = isolated / "pending" / "approval-audit.jsonl"
    text = path.read_text()
    assert "PRIVATE" not in text
    event = json.loads(text)
    assert event["pending_id"] == rec["id"]
    assert event["action"] == "reject"
    assert event["outcome"] == "rejected"
    assert os.stat(path).st_mode & 0o077 == 0


def test_reject_cleanup_failure_is_not_reported_missing(isolated, monkeypatch):
    rec = wa.stage_write("memory", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    monkeypatch.setattr(wa, "discard_pending", lambda *args: False)
    out = commands.handle_pending_subcommand("memory", ["reject", rec["id"]])
    assert "cleanup failed" in out.lower()
    assert wa.get_pending("memory", rec["id"])
    event = json.loads((isolated / "pending" / "approval-audit.jsonl").read_text())
    assert event["outcome"] == "cleanup_failed"


def test_audit_failure_is_visible(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    monkeypatch.setattr(commands, "_receipt", lambda *args: False)
    out = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
    assert "audit" in out.lower() and "warning" in out.lower()
    assert wa.get_pending("skills", rec["id"]) is None


@pytest.mark.parametrize("success,outcome", [(True, "approved"), (False, "apply_failed_or_partial")])
def test_approval_receipt_excludes_payload(isolated, monkeypatch, success, outcome):
    rec = wa.stage_write("memory", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    monkeypatch.setattr(commands, "_apply_one", lambda *args: (success, "PRIVATE" if not success else "", {}))
    commands.handle_pending_subcommand("memory", ["approve", rec["id"]], memory_store=object())
    raw = (isolated / "pending" / "approval-audit.jsonl").read_text()
    assert "PRIVATE" not in raw
    assert json.loads(raw)["outcome"] == outcome
    assert (wa.get_pending("memory", rec["id"]) is None) == success


def test_concurrent_approval_claims_only_once(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    entered, release = threading.Event(), threading.Event()
    calls, results = [], []

    def apply(*args):
        calls.append(1)
        entered.set()
        assert release.wait(10)
        return True, "", {}

    monkeypatch.setattr(commands, "_apply_one", apply)
    thread = threading.Thread(target=lambda: results.append(commands.handle_pending_subcommand("skills", ["approve", rec["id"]])))
    thread.start()
    try:
        assert entered.wait(10)
        second = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
        assert "concurrent" in second.lower()
    finally:
        release.set()
        thread.join(10)
    assert not thread.is_alive()
    assert calls == [1]
    assert wa.get_pending("skills", rec["id"]) is None


def test_corrupt_pending_can_be_rejected(isolated):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    wa._pending_path("skills", rec["id"]).write_text("not json")
    out = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
    assert "Rejected pending" in out
    assert not wa._pending_path("skills", rec["id"]).exists()


def test_attempt_marker_blocks_retry_after_partial_failure(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    calls = []
    monkeypatch.setattr(commands, "_apply_one", lambda *args: (calls.append(1) is not None, "failed", {}))
    first = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    second = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    assert "partial" in first.lower()
    assert "reconcile" in second.lower()
    marker = isolated / "pending" / "approval-attempts" / "skills" / (rec["id"] + ".json")
    assert json.loads(marker.read_text())["outcome"] == "apply_failed_or_partial"
    assert calls == [1]
    marker = isolated / "pending" / "approval-attempts" / "skills" / (rec["id"] + ".json")
    assert set(json.loads(marker.read_text())) == {"timestamp", "subsystem", "pending_id", "action", "outcome"}
    assert "PRIVATE" not in marker.read_text()


def test_reject_can_clear_pending_after_failed_approval_attempt(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    monkeypatch.setattr(commands, "_apply_one", lambda *args: (False, "validation failed", {}))
    commands.handle_pending_subcommand("skills", ["approve", rec["id"]])

    out = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])

    assert out is not None and "Rejected pending" in out
    assert wa.get_pending("skills", rec["id"]) is None


def test_reject_cannot_remove_pending_during_an_inflight_approval(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    entered, release = threading.Event(), threading.Event()

    def apply(*_args):
        entered.set()
        assert release.wait(10)
        return True, "", {}

    monkeypatch.setattr(commands, "_apply_one", apply)
    results = []
    thread = threading.Thread(
        target=lambda: results.append(commands.handle_pending_subcommand("skills", ["approve", rec["id"]]))
    )
    thread.start()
    try:
        assert entered.wait(10)
        rejected = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
        assert "concurrent" in rejected.lower() or "in progress" in rejected.lower()
        assert wa.get_pending("skills", rec["id"]) is not None
    finally:
        release.set()
        thread.join(10)

    assert not thread.is_alive()
    assert results and "Approved 1" in results[0]
    assert wa.get_pending("skills", rec["id"]) is None


def test_audit_symlink_is_refused(isolated):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    destination = isolated / "destination"
    destination.write_text("unchanged")
    (isolated / "pending" / "approval-audit.jsonl").symlink_to(destination)
    out = commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
    assert "audit" in out.lower() and "warning" in out.lower()
    assert destination.read_text() == "unchanged"


def test_invalid_id_cannot_access_other_paths(isolated):
    assert "Invalid" in commands.handle_pending_subcommand("skills", ["reject", "../../other"])
    assert wa.get_pending("skills", "../../other") is None


def test_staging_keeps_pending_directories_private_and_cleans_reservations(isolated):
    for index in range(3):
        wa.stage_write("skills", {"content": str(index)}, summary="test", origin="foreground")

    pending = isolated / "pending"
    reservations = pending / "approval-ids" / "skills"
    assert os.stat(pending).st_mode & 0o077 == 0
    assert os.stat(pending / "approval-ids").st_mode & 0o077 == 0
    assert os.stat(reservations).st_mode & 0o077 == 0
    assert list(reservations.iterdir()) == []


def test_legacy_pending_files_are_counted_listed_and_rejected(isolated):
    legacy = isolated / "pending" / "skills" / "legacy.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("not json")

    assert wa.pending_count("skills") == 1
    assert "legacy" in commands.handle_pending_subcommand("skills", ["pending"])
    result = commands.handle_pending_subcommand("skills", ["reject", "all"])

    assert "Discarded 1 unreadable legacy" in result
    assert not legacy.exists()
    assert wa.pending_count("skills") == 0


def test_profiles_have_independent_markers_and_receipts(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    commands.handle_pending_subcommand("skills", ["reject", rec["id"]])
    first = isolated / "pending" / "approval-audit.jsonl"
    other = isolated.parent / "other-profile"
    monkeypatch.setenv("HERMES_HOME", str(other))
    rec2 = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    commands.handle_pending_subcommand("skills", ["reject", rec2["id"]])
    assert json.loads(first.read_text())["pending_id"] == rec["id"]
    assert json.loads((other / "pending" / "approval-audit.jsonl").read_text())["pending_id"] == rec2["id"]


def test_interrupted_replay_is_not_repeated(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    calls = []

    def interrupted(*args):
        calls.append(1)
        raise KeyboardInterrupt()

    monkeypatch.setattr(commands, "_apply_one", interrupted)
    with pytest.raises(KeyboardInterrupt):
        commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    out = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    assert out and "reconcile" in out.lower()
    assert calls == [1]
    events = [json.loads(line) for line in (isolated / "pending" / "approval-audit.jsonl").read_text().splitlines()]
    assert events[-1]["outcome"] == "interrupted_unknown"


def test_approve_all_continues_after_unexpected_exception(isolated, monkeypatch):
    first = wa.stage_write("skills", {"action": "test"}, summary="first", origin="foreground")
    second = wa.stage_write("skills", {"action": "test"}, summary="second", origin="foreground")
    def apply(subsystem, rec, memory_store):
        if rec["id"] == first["id"]:
            raise RuntimeError("PRIVATE")
        return True, "", {}
    monkeypatch.setattr(commands, "_apply_one", apply)
    out = commands.handle_pending_subcommand("skills", ["approve", "all"])
    assert out is not None
    assert "Approved 1" in out and "partial" in out
    assert "PRIVATE" not in out
    assert wa.get_pending("skills", first["id"]) is not None
    assert wa.get_pending("skills", second["id"]) is None
    events = [json.loads(line) for line in (isolated / "pending" / "approval-audit.jsonl").read_text().splitlines()]
    assert [event["outcome"] for event in events] == ["apply_failed_or_partial", "approved"]


def test_record_invalid_after_claim_is_audited_without_application(isolated, monkeypatch):
    rec = wa.stage_write("skills", {"action": "test"}, summary="synthetic", origin="foreground")
    read = wa.get_pending
    calls = 0
    def changed(subsystem, pending_id):
        nonlocal calls
        calls += 1
        return read(subsystem, pending_id) if calls == 1 else None
    monkeypatch.setattr(wa, "get_pending", changed)
    monkeypatch.setattr(commands, "_apply_one", lambda *args: pytest.fail("must not apply invalid record"))
    out = commands.handle_pending_subcommand("skills", ["approve", rec["id"]])
    assert out is not None and "invalid" in out
    events = [json.loads(line) for line in (isolated / "pending" / "approval-audit.jsonl").read_text().splitlines()]
    assert events[-1]["pending_id"] == rec["id"]
    assert events[-1]["outcome"] == "invalid_after_claim"


def test_reject_all_includes_corrupt_synthetic_record(isolated):
    good = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    bad = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    wa._pending_path("skills", bad["id"]).write_text("not json")
    out = commands.handle_pending_subcommand("skills", ["reject", "all"])
    assert out and "Rejected 2" in out
    assert not wa._pending_path("skills", good["id"]).exists()
    assert not wa._pending_path("skills", bad["id"]).exists()


def test_real_memory_replay_uses_only_isolated_home(isolated):
    from tools.memory_tool import MemoryStore

    store = MemoryStore()
    store.load_from_disk()
    rec = wa.stage_write("memory", {"action": "add", "target": "user", "content": "PRIVATE"},
                         summary="PRIVATE", origin="foreground")
    out = commands.handle_pending_subcommand("memory", ["approve", rec["id"]], memory_store=store)
    assert out and "Approved 1" in out
    assert store.user_entries == ["PRIVATE"]
    assert wa.get_pending("memory", rec["id"]) is None


def test_missing_memory_store_does_not_burn_approval(isolated):
    rec = wa.stage_write("memory", {"action": "add", "target": "user", "content": "PRIVATE"},
                         summary="PRIVATE", origin="foreground")
    out = commands.handle_pending_subcommand("memory", ["approve", rec["id"]])
    assert out and "store unavailable" in out.lower()
    assert not (isolated / "pending" / "approval-attempts" / "memory" / (rec["id"] + ".json")).exists()
    assert wa.get_pending("memory", rec["id"])


def test_pending_count_matches_readable_list(isolated):
    rec = wa.stage_write("skills", {"content": "PRIVATE"}, summary="PRIVATE", origin="foreground")
    wa._pending_path("skills", rec["id"]).write_text("invalid JSON")
    assert wa.pending_count("skills") == 1
    out = commands.handle_pending_subcommand("skills", ["pending"])
    assert out and rec["id"] in out and "unreadable" in out.lower()


def test_new_ids_do_not_overwrite_existing_or_retained_claim(isolated, monkeypatch):
    from types import SimpleNamespace
    ids = iter(["a" * 32, "a" * 32, "b" * 32, "c" * 32])
    monkeypatch.setattr(wa.uuid, "uuid4", lambda: SimpleNamespace(hex=next(ids)))
    first = wa.stage_write("skills", {"content": "first"}, summary="first", origin="foreground")
    marker = isolated / "pending" / "approval-attempts" / "skills" / (("b" * 32) + ".json")
    marker.parent.mkdir(parents=True)
    marker.write_text("retained")
    second = wa.stage_write("skills", {"content": "second"}, summary="second", origin="foreground")
    assert first["id"] == "a" * 32
    assert second["id"] == "c" * 32
    first_record = wa.get_pending("skills", first["id"])
    second_record = wa.get_pending("skills", second["id"])
    assert first_record is not None and first_record["payload"]["content"] == "first"
    assert second_record is not None and second_record["payload"]["content"] == "second"
    assert marker.read_text() == "retained"


@pytest.mark.parametrize("subsystem", ["memory", "skills"])
def test_staging_failure_is_reported_without_proposal_or_write(isolated, monkeypatch, subsystem):
    from types import SimpleNamespace
    from tools import memory_tool, skill_manager_tool
    monkeypatch.setattr(wa, "evaluate_gate", lambda *args, **kwargs: SimpleNamespace(allow=False, blocked=False, message="approval required"))
    def fail(*args, **kwargs):
        raise OSError("PRIVATE")
    monkeypatch.setattr(wa, "stage_write", fail)
    if subsystem == "memory":
        result = memory_tool._gate_or_stage(memory_tool.MemoryStore(), "add", "PRIVATE", {"action": "add"})
    else:
        result = skill_manager_tool._run_write_gate(lambda _: ({"action": "create"}, "PRIVATE"))
    assert result is not None
    parsed = json.loads(result)
    assert parsed.get("success") is False
    assert not parsed.get("staged")
    assert "PRIVATE" not in result


@pytest.mark.parametrize("field,value", [
    ("created_at", "bad"), ("summary", {}), ("payload", []),
    ("payload", {"action": "batch", "operations": ["bad"]}),
])
def test_malformed_record_does_not_hide_other_pending(isolated, field, value):
    good = wa.stage_write("memory", {"action": "add", "content": "ok"}, summary="ok", origin="foreground")
    bad = wa.stage_write("memory", {"action": "add", "content": "bad"}, summary="bad", origin="foreground")
    bad[field] = value
    wa._pending_path("memory", bad["id"]).write_text(json.dumps(bad))
    out = commands.handle_pending_subcommand("memory", ["pending"])
    assert out and good["id"] in out
    assert wa.get_pending("memory", bad["id"]) is None
    assert "Rejected" in commands.handle_pending_subcommand("memory", ["reject", bad["id"]])
