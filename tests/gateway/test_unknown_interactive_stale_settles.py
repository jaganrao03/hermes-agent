"""A person's lost turn, still unresolved at the next start, settles once it is stale.

``recover_session_inputs`` fences a turn a dead owner left ``started`` as ``unknown`` and leaves the
old ``owner_epoch`` on the row. For an interactive row that paused the session's FIFO until a person
resolved it — and at boot there is nobody to ask, so a restart mid-turn wedged those sessions until
an operator ran ``hermes sessions discard`` (restore/continue answered ``unknown_execution``).
``settle_recovered_dead_owner_stale`` settles such a row ``interrupted`` (never replayed, transcript
notice) once its session has been idle past the threshold, and still leaves a fresh one — or one
fenced by the current owner — paused for the person.

Real ``SessionStore`` SQLite, two real owner epochs; no store monkeypatching.
"""
import queue
import time
from types import SimpleNamespace

import pytest

from gateway.config import GatewayConfig, Platform
from gateway.session import SessionSource, SessionStore
from gateway.session_authority import LiveSession, initialize_session_authority
from gateway.session_contract import SessionRef, Submission
from gateway.session_controls import AuthorityConnection
from hermes_state_runtime import claim_session_input, list_session_admissions
from tests.waiting import async_wait_until


class Peer:
    def __init__(self):
        self.frames = queue.Queue()

    def write(self, frame):
        self.frames.put(frame)
        return True


def _runner(tmp_path, monkeypatch, executed):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    store = SessionStore(tmp_path / 'sessions', GatewayConfig())

    async def answer(event):
        from gateway.session_results import execution_result
        executed.append(event.text)
        execution_result.get()['result'] = {'final_response': 'ACK_' + event.text, 'completed': True, 'messages': []}
        return 'ACK_' + event.text

    runner = SimpleNamespace(_session_db=store._db, session_store=store, _draining=False,
                             _handle_message=answer, _adapter_for_source=lambda source: None)
    return store, runner


def _stamp_activity(db, session_id, age_seconds):
    db._execute_write(lambda c: c.execute(
        'UPDATE sessions SET last_activity_at=? WHERE id=?', (time.time() - age_seconds, session_id)))


def _statuses(db):
    return {r['admission_id']: (r['status'], r['outcome'])
            for r in list_session_admissions(db, session_id='s', pending_only=False)}


async def _person_lost_head_then_restart(tmp_path, monkeypatch, executed, *, idle_for):
    """Owner 1 claims a person's head (a follower queued behind it) and dies; owner 2 starts.
    ``idle_for`` ages the session's last activity before owner 2 boots (None leaves it unset)."""
    store, runner = _runner(tmp_path, monkeypatch, executed)
    db = store._db
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='gw10')
    db.create_session('s', source='telegram')
    first = await initialize_session_authority(runner, profile_id='p', instance_id='owner-1')
    first.sessions['s'] = LiveSession(source, 's')
    ref = SessionRef('p', 's')
    actor = AuthorityConnection(first, Peer(), {'user_id': 'human'}).actor
    first._schedule = lambda ref: None
    head = await first.submit(actor, Submission('head', ref, {'text': 'HEAD'}, 'queue'))
    follower = await first.submit(actor, Submission('follower', ref, {'text': 'FOLLOWER'}, 'queue'))
    claimed = claim_session_input(db, epoch=first.epoch, session_id='s')
    assert claimed['admission_id'] == head.admission_id
    db.append_message('s', 'user', 'HEAD')  # the lost turn got as far as its user row
    if idle_for is not None:
        _stamp_activity(db, 's', idle_for)
    second = await initialize_session_authority(runner, profile_id='p', instance_id='owner-2')
    second.sessions['s'] = LiveSession(source, 's')
    return store, second, head.admission_id, follower.admission_id


@pytest.mark.asyncio
async def test_stale_persons_lost_turn_settles_interrupted_and_the_fifo_moves_on(tmp_path, monkeypatch):
    executed = []
    store, authority, head_id, follower_id = await _person_lost_head_then_restart(
        tmp_path, monkeypatch, executed, idle_for=3600)
    try:
        assert _statuses(authority.db)[head_id] == ('terminal', 'interrupted')
        authority._schedule(SessionRef('p', 's'))
        live = authority.sessions['s']
        await async_wait_until(lambda: live.task is not None and live.task.done(), what='drain finished')
        # The person's lost turn is never replayed; only the follower runs.
        assert executed == ['FOLLOWER']
        assert _statuses(authority.db)[follower_id] == ('terminal', 'completed')
        notices = [m['content'] for m in authority.db.get_messages('s') if m.get('display_kind') == 'failed_turn']
        assert notices and any('restart' in n.lower() for n in notices), notices
    finally:
        store.close_all_db_handles()


@pytest.mark.asyncio
async def test_a_dead_owners_lost_turn_settles_so_the_queue_runs(tmp_path, monkeypatch):
    """A fresh loss from an owner that is gone settles on the drain, and the queue behind it runs.

    Waiting for staleness never fires in an active conversation, so the FIFO — and every prompt
    queued behind the lost turn — used to stay paused (the desktop's "Turn lost during restart")
    until the person found Discard. A dead owner epoch can never run that row again.
    """
    executed = []
    store, authority, head_id, follower_id = await _person_lost_head_then_restart(
        tmp_path, monkeypatch, executed, idle_for=5)
    try:
        assert _statuses(authority.db)[head_id] == ('unknown', None)
        authority._schedule(SessionRef('p', 's'))
        live = authority.sessions['s']
        await async_wait_until(lambda: live.task is not None and live.task.done(), what='drain finished')
        assert executed == ['FOLLOWER']
        assert _statuses(authority.db)[head_id] == ('terminal', 'interrupted')
        assert _statuses(authority.db)[follower_id] == ('terminal', 'completed')
    finally:
        store.close_all_db_handles()


@pytest.mark.asyncio
async def test_a_session_with_no_recorded_activity_is_never_judged_stale(tmp_path, monkeypatch):
    executed = []
    store, authority, head_id, follower_id = await _person_lost_head_then_restart(
        tmp_path, monkeypatch, executed, idle_for=None)
    try:
        assert _statuses(authority.db)[head_id] == ('unknown', None)
        assert _statuses(authority.db)[follower_id] == ('queued', None)
    finally:
        store.close_all_db_handles()


@pytest.mark.asyncio
async def test_a_turn_fenced_by_this_owner_keeps_pausing(tmp_path, monkeypatch):
    """A loss inside the running owner (a managed worker) leaves the person present to decide."""
    from gateway.session_unattended_unknown import settle_recovered_dead_owner_stale
    executed = []
    store, runner = _runner(tmp_path, monkeypatch, executed)
    db = store._db
    db.create_session('s', source='telegram')
    authority = await initialize_session_authority(runner, profile_id='p', instance_id='owner-1')
    authority.sessions['s'] = LiveSession(SessionSource(platform=Platform.TELEGRAM, chat_id='gw10'), 's')
    try:
        ref = SessionRef('p', 's')
        actor = AuthorityConnection(authority, Peer(), {'user_id': 'human'}).actor
        head = await authority.submit(actor, Submission('head', ref, {'text': 'HEAD'}, 'queue'))
        claim_session_input(db, epoch=authority.epoch, session_id='s')
        db._execute_write(lambda c: c.execute(
            "UPDATE session_admissions SET status='unknown' WHERE admission_id=?", (head.admission_id,)))
        _stamp_activity(db, 's', 3600)
        assert settle_recovered_dead_owner_stale(db, authority.epoch) == 0
        assert _statuses(db)[head.admission_id] == ('unknown', None)
    finally:
        store.close_all_db_handles()


@pytest.mark.asyncio
async def test_a_new_prompt_leaves_a_turn_fenced_by_this_owner_alone(tmp_path, monkeypatch):
    """A loss inside the running owner is the person's to resolve: still paused, no auto-settle."""
    from gateway.session_unattended_unknown import settle_dead_owner_unknown_for_session
    executed = []
    store, runner = _runner(tmp_path, monkeypatch, executed)
    db = store._db
    db.create_session('s', source='telegram')
    authority = await initialize_session_authority(runner, profile_id='p', instance_id='owner-1')
    authority.sessions['s'] = LiveSession(
        SessionSource(platform=Platform.TELEGRAM, chat_id='gw10'), 's')
    try:
        ref = SessionRef('p', 's')
        actor = AuthorityConnection(authority, Peer(), {'user_id': 'human'}).actor
        head = await authority.submit(actor, Submission('head', ref, {'text': 'HEAD'}, 'queue'))
        claim_session_input(db, epoch=authority.epoch, session_id='s')
        db._execute_write(lambda c: c.execute(
            "UPDATE session_admissions SET status='unknown' WHERE admission_id=?",
            (head.admission_id,)))
        assert settle_dead_owner_unknown_for_session(db, authority.epoch, 's') == 0
        assert _statuses(db)[head.admission_id] == ('unknown', None)
    finally:
        store.close_all_db_handles()
