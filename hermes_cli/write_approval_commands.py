#!/usr/bin/env python3
"""Shared handlers for the /memory and /skills write-approval subcommands."""

from __future__ import annotations

import json
import os
import re
import stat
from datetime import datetime, UTC
from typing import List, Optional

from hermes_constants import get_hermes_home
from tools import write_approval as wa
from utils import atomic_json_write


def _fmt_state(subsystem: str) -> str:
    on = wa.write_approval_enabled(subsystem)
    return f"{subsystem}.write_approval = {'on' if on else 'off'}"


def _fmt_pending_list(subsystem: str) -> str:
    records = wa.list_pending(subsystem)
    visible = {r["id"] for r in records}
    unreadable = sorted(p.stem for p in wa._pending_files(subsystem) if p.stem not in visible)
    if not records and not unreadable:
        return f"No pending {subsystem} writes."
    lines = [f"Pending {subsystem} writes ({len(records) + len(unreadable)}):"]
    for r in records:
        origin = r.get("origin", "foreground")
        tag = " [auto]" if origin == "background_review" else ""
        lines.append(f"  {r['id']}{tag}  {r.get('summary', '')}")
        if subsystem == wa.MEMORY:
            lines.extend(f"      {line}" for line in _matched_entries(r["payload"]))
    lines.extend(f"  {pending_id}  [unreadable legacy file; use reject all]" for pending_id in unreadable)
    lines.append("")
    lines.append(f"Apply: /{subsystem} approve <id>   Reject: /{subsystem} reject <id>")
    if subsystem == wa.SKILLS:
        lines.append("Review full diff: /skills diff <id>")
    return "\n".join(lines)


def handle_pending_subcommand(
    subsystem: str, args: list[str], *, memory_store=None, set_mode_fn=None) -> Optional[str]:
    """Dispatch a /memory or /skills write-approval subcommand.

    ``memory_store`` applies approved memory writes (CLI passes its live store; gateway a freshly
    loaded one); ``set_mode_fn`` persists the write_approval boolean. Returns text for the user,
    or None when the args are not a write-approval subcommand so the caller falls through to its
    other handling (e.g. /skills search).
    """
    if not args:
        return f"{_fmt_state(subsystem)}\n\n" + _fmt_pending_list(subsystem)
    sub, rest = args[0].lower(), args[1:]
    if sub == "pending":
        return _fmt_pending_list(subsystem)
    if sub in {"approve", "apply"}:
        return _approve(subsystem, rest, memory_store)
    if sub in {"reject", "deny", "drop"}:
        return _reject(subsystem, rest)
    if sub == "diff" and subsystem == wa.SKILLS:
        return _diff(rest)
    if sub in {"approval", "mode"}:  # 'mode' kept as a back-compat alias
        return _set_approval(subsystem, rest, set_mode_fn)
    return None  # not ours — caller handles


def _usage(subsystem: str) -> str:
    return f"Usage: /{subsystem} approve|reject <id>  (or 'all')"


def _receipt(subsystem: str, pending_id: str, action: str, outcome: str) -> bool:
    """Append only fixed metadata; never include the proposal or error text."""
    if subsystem not in (wa.SKILLS, wa.MEMORY) or not re.fullmatch(wa.PENDING_ID_RE, pending_id):
        return False
    event = {"timestamp": datetime.now(UTC).isoformat(), "subsystem": subsystem,
             "pending_id": pending_id, "action": action, "outcome": outcome}
    try:
        path = get_hermes_home() / "pending" / "approval-audit.jsonl"
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_NONBLOCK", 0), 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return False
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps(event, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return True
    except Exception:
        return False


def _claim(subsystem: str, pending_id: str, action: str) -> str:
    """Persist an exclusive attempt before any side effect; never retry uncertainty."""
    if subsystem not in (wa.SKILLS, wa.MEMORY) or not re.fullmatch(wa.PENDING_ID_RE, pending_id):
        return "Invalid pending write ID."
    directory = get_hermes_home() / "pending" / "approval-attempts" / subsystem
    marker = directory / (pending_id + ".json")
    try:
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        event = {"timestamp": datetime.now(UTC).isoformat(), "subsystem": subsystem,
                 "pending_id": pending_id, "action": action, "outcome": "attempt"}
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(event, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if hasattr(os, "O_DIRECTORY"):
            # Persist each newly created directory entry, not just the marker itself.
            for parent in (directory, directory.parent, directory.parent.parent, get_hermes_home()):
                directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        return ""
    except FileExistsError:
        if action == "reject":
            try:
                prior = json.loads(marker.read_text(encoding="utf-8"))
            except Exception:
                return f"{pending_id}: prior or concurrent attempt; reconcile its outcome before rejection."
            recoverable = prior.get("action") == "approve" and prior.get("outcome") in {
                "apply_failed_or_partial", "invalid_after_claim", "interrupted_unknown",
            }
            retry_reject = prior.get("action") == "reject" and prior.get("outcome") == "cleanup_failed"
            if recoverable or retry_reject:
                return ""
            return f"{pending_id}: prior or concurrent attempt; reconcile its outcome before rejection."
        return f"{pending_id}: prior or concurrent attempt; reconcile its outcome before any retry."
    except Exception:
        return f"{pending_id}: could not persist attempt marker; no action taken; reconcile before retry."


def _update_claim(subsystem: str, pending_id: str, action: str, outcome: str) -> bool:
    """Persist a terminal decision so reject cannot race an in-flight approval."""
    marker = get_hermes_home() / "pending" / "approval-attempts" / subsystem / (pending_id + ".json")
    try:
        event = json.loads(marker.read_text(encoding="utf-8"))
        if (event.get("subsystem"), event.get("pending_id"), event.get("action")) != (
            subsystem, pending_id, action
        ) or event.get("outcome") != "attempt":
            return False
        event["outcome"] = outcome
        atomic_json_write(marker, event)
        return True
    except Exception:
        return False


def _approve(subsystem: str, rest: list[str], memory_store) -> str:
    if not rest:
        return _usage(subsystem)
    target = rest[0]
    if target.lower() != "all" and not re.fullmatch(wa.PENDING_ID_RE, target):
        return "Invalid pending write ID."
    if subsystem == wa.MEMORY and memory_store is None:
        return "Memory store unavailable; no approval attempted."
    records = wa.list_pending(subsystem)
    if not records:
        return f"No pending {subsystem} writes."
    if target.lower() == "all":
        targets = list(records)
    else:
        rec = wa.get_pending(subsystem, target)
        if not rec:
            return f"No pending {subsystem} write with id '{target}'."
        targets = [rec]

    applied, failed, overwritten, patched, removed, audit_failed = 0, [], [], [], [], False
    for rec in targets:
        error = _claim(subsystem, rec["id"], "approve")
        if error:
            failed.append(error)
            continue
        pending_id = rec["id"]
        rec = wa.get_pending(subsystem, pending_id)
        if rec is None:
            failed.append("Pending write disappeared or became invalid after claim; reconcile before retry.")
            _update_claim(subsystem, pending_id, "approve", "invalid_after_claim")
            if not _receipt(subsystem, pending_id, "approve", "invalid_after_claim"):
                audit_failed = True
            continue
        try:
            ok, msg, result = _apply_one(subsystem, rec, memory_store)
        except Exception:
            ok, msg, result = False, "unexpected application error", {}
        except BaseException:
            _update_claim(subsystem, rec["id"], "approve", "interrupted_unknown")
            _receipt(subsystem, rec["id"], "approve", "interrupted_unknown")
            raise
        if ok:
            if wa.discard_pending(subsystem, rec["id"]):
                applied += 1
                outcome = "approved"
            else:
                outcome = "cleanup_failed"
                failed.append(f"{rec['id']}: already applied, but pending cleanup failed; do not approve again.")
            overwritten.extend(f"  {rec['id']}: {text}" for text in _changed_entries(result, "replaced"))
            patched.extend(f"  {rec['id']}: {text}" for text in _changed_entries(result, "patched"))
            removed.extend(f"  {rec['id']}: {text}" for text in _changed_entries(result, "removed"))
        else:
            outcome = "apply_failed_or_partial"
            failed.append(f"{rec['id']}: {msg} — outcome may be partial; reconcile before retry.")
        if not _update_claim(subsystem, rec["id"], "approve", outcome):
            audit_failed = True
        if not _receipt(subsystem, rec["id"], "approve", outcome):
            audit_failed = True

    out = [f"Approved {applied} {subsystem} write(s)."]
    if overwritten:
        # A memory 'replace' overwrites the WHOLE matched entry (#117952); the approver
        # is the last person who can notice a clause went missing, so show what was lost.
        out.append("Overwrote entire entry (re-add anything you still need):")
        out.extend(overwritten)
    if patched:
        # A patch keeps the rest of the entry, so show it as it was, not as lost text.
        out.append("Patched entry (as it was before the edit):")
        out.extend(patched)
    if removed:
        out.append("Removed entry (re-add anything you still need):")
        out.extend(removed)
    if failed:
        out.append("Failed:")
        out.extend(f"  {f}" for f in failed)
    if audit_failed:
        out.append("Warning: one or more approval audit receipts could not be written.")
    return "\n".join(out)


def _changed_entries(result: dict, kind: str) -> list[str]:
    """Full text of every entry a memory write changed, single-op or batch shape."""
    single = result.get(f"{kind}_entry")
    if kind == "patched" and single is None:
        single = result.get("patched_entry_before")
    batch = result.get(f"{kind}_entries") or {}
    return ([single] if single else []) + [batch[k] for k in sorted(batch, key=int)]


def _matched_entries(payload) -> list[str]:
    """The full entry each staged memory replace/remove is pinned to: the summary shows only
    the old_text search string, and approval applies to this entry, not to that search."""
    from tools.memory_tool import destructive_ops
    return [f"{op['action']}s entry: {op['matched_entry']}" if op.get("matched_entry")
            else f"{op['action']}: unpinned legacy target \u2014 reject and recreate before approving"
            for op in destructive_ops(payload)]


def _apply_one(subsystem: str, rec, memory_store):
    """``(ok, error, result)`` — *result* is the applier's full payload (empty on exceptions)."""
    payload = rec.get("payload", {})
    try:
        if subsystem == wa.MEMORY:
            if memory_store is None:
                return False, "memory store unavailable", {}
            from tools.memory_tool import apply_memory_pending
            result = apply_memory_pending(payload, memory_store)
        else:
            from tools.skill_manager_tool import apply_skill_pending
            result = json.loads(apply_skill_pending(payload))
        return bool(result.get("success")), result.get("error", ""), result
    except Exception as e:
        return False, str(e), {}


def _reject(subsystem: str, rest: list[str]) -> str:
    if not rest:
        return _usage(subsystem)
    target = rest[0]
    if target.lower() != "all" and not re.fullmatch(wa.PENDING_ID_RE, target):
        return "Invalid pending write ID."
    pending_files = wa._pending_files(subsystem)
    ids = [p.stem for p in pending_files] if target.lower() == "all" else [target]
    if target.lower() != "all" and not wa._pending_path(subsystem, target).exists():
        return f"No pending {subsystem} write with id '{target}'."
    rejected, failed, audit_failed, legacy_discarded = 0, [], False, 0
    for pending_id in ids:
        if not re.fullmatch(wa.PENDING_ID_RE, pending_id):
            legacy_path = next((p for p in pending_files if p.stem == pending_id), None)
            try:
                if legacy_path is None or not (legacy_path.is_file() or legacy_path.is_symlink()):
                    failed.append(pending_id)
                else:
                    legacy_path.unlink()
                    legacy_discarded += 1
            except OSError:
                failed.append(pending_id)
            continue
        error = _claim(subsystem, pending_id, "reject")
        if error:
            failed.append(error)
            continue
        if wa.discard_pending(subsystem, pending_id):
            rejected += 1
            outcome = "rejected"
        else:
            outcome = "cleanup_failed"
            failed.append(pending_id)
        if not _update_claim(subsystem, pending_id, "reject", outcome):
            audit_failed = True
        if not _receipt(subsystem, pending_id, "reject", outcome):
            audit_failed = True
    if target.lower() != "all" and rejected:
        out = [f"Rejected pending {subsystem} write '{target}'."]
    else:
        out = [f"Rejected {rejected} pending {subsystem} write(s)."]
    if legacy_discarded:
        out.append(f"Discarded {legacy_discarded} unreadable legacy pending file(s).")
    if failed:
        out.append(f"Cleanup failed for: {', '.join(failed)}; rejection not completed.")
    if audit_failed:
        out.append("Warning: one or more approval audit receipts could not be written.")
    return "\n".join(out)


def _diff(rest: list[str]) -> str:
    if not rest:
        return "Usage: /skills diff <id>"
    rec = wa.get_pending(wa.SKILLS, rest[0])
    if not rec:
        return f"No pending skill write with id '{rest[0]}'."
    return f"# Pending skill write {rec['id']}: {rec.get('summary', '')}\n\n" + wa.skill_pending_diff(rec)


_APPROVAL_VALUES = {
    **dict.fromkeys(("on", "true", "yes", "1", "enable", "enabled"), True),
    **dict.fromkeys(("off", "false", "no", "0", "disable", "disabled"), False)}


def _set_approval(subsystem: str, rest: list[str], set_mode_fn) -> str:
    """Turn the approval gate on/off for a subsystem."""
    if not rest:
        return (f"{_fmt_state(subsystem)}\n"
                f"Set with: /{subsystem} approval <on|off>")
    arg = rest[0].strip().lower()
    enabled = _APPROVAL_VALUES.get(arg)
    if enabled is None:
        return f"Invalid value '{arg}'. Use: on or off."
    if set_mode_fn is None:
        val = "true" if enabled else "false"
        return (f"To change the {subsystem} approval gate, run:\n"
                f"  hermes config set {subsystem}.write_approval {val}")
    try:
        set_mode_fn(enabled)
    except Exception as e:
        return f"Failed to set {subsystem}.write_approval: {e}"
    return f"{subsystem}.write_approval set to '{'on' if enabled else 'off'}'."
