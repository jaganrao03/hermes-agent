"""Seed a sandbox state.db with N titled sessions for the phone probe (PROBE_SEED=N).

usage: seed-sessions.py <hermes_home> <n_sessions> [long_session_messages]
Uses the repo's own SessionDB so the schema/migrations match what the gateway expects.
"""
import os
import sys
import time
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(repo))
home, n = Path(sys.argv[1]), int(sys.argv[2])
if not str(home).startswith(("/tmp", str(Path.home() / ".hermes" / "cache"))) and "sandbox" not in str(home) and "e2e" not in str(home):
    raise SystemExit(f"refusing to seed a non-sandbox home: {home}")
os.environ["HERMES_HOME"] = str(home)
from hermes_state import SessionDB

db = SessionDB(db_path=home / "state.db")
now = time.time()
topics = ["Debug the sync worker", "Plan the Austin move", "Review PR feedback", "Draft a status update", "Budget check-in", "Fix flaky e2e test", "Summarise the meeting notes"]
for i in range(n):
    sid = f"seed_{i:05d}"
    db.create_session(sid, "cli" if i % 3 else "telegram", model="seed-model")
    db.append_message(sid, "user", f"{topics[i % len(topics)]} #{i}")
    db.append_message(sid, "assistant", f"Reply for #{i}. " + "Some answer text. " * 12)
    db.set_session_title(sid, f"{topics[i % len(topics)]} #{i}")
print(f"seeded {n} sessions into {home}/state.db")
