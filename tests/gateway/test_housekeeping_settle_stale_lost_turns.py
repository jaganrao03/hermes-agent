"""The housekeeping tick settles a stale lost turn while the gateway is up.

Regression: ``settle_recovered_dead_owner_stale`` ran only from boot recovery, so a gateway that
restarted once mid-turn and then stayed up kept that chat answering ``unknown_execution`` — the
desktop's "Turn lost during restart" card refusing new prompts instead of queueing them — until
somebody pressed Discard.
"""
from __future__ import annotations

from types import SimpleNamespace

import gateway.session_unattended_unknown as unattended
from gateway.run import _housekeeping_settle_stale_lost_turns


def _runner(db='db', epoch=7):
    return SimpleNamespace(session_authority=SimpleNamespace(db=db, epoch=epoch))


def test_settles_with_the_owner_epoch(monkeypatch):
    calls = []
    monkeypatch.setattr(unattended, 'settle_recovered_dead_owner_stale',
                        lambda db, epoch: calls.append((db, epoch)) or 1)
    _housekeeping_settle_stale_lost_turns(_runner(db='state.db', epoch=42))
    assert calls == [('state.db', 42)]


def test_no_authority_is_a_no_op(monkeypatch):
    calls = []
    monkeypatch.setattr(unattended, 'settle_recovered_dead_owner_stale',
                        lambda db, epoch: calls.append((db, epoch)) or 0)
    _housekeeping_settle_stale_lost_turns(None)
    _housekeeping_settle_stale_lost_turns(SimpleNamespace(session_authority=None))
    assert calls == []


def test_a_failing_sweep_never_takes_the_tick_down(monkeypatch):
    def boom(db, epoch):
        raise RuntimeError('database is locked')

    monkeypatch.setattr(unattended, 'settle_recovered_dead_owner_stale', boom)
    _housekeeping_settle_stale_lost_turns(_runner())  # must not raise
