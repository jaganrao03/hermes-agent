"""An ``unknown`` turn nobody is waiting on settles as interrupted (#134889 GW-10, #139532).

A turn lost across an owner restart is fenced ``unknown`` and pauses its session's FIFO, because
only the person who sent it knows whether to resend it. An automation delivery has no such person:
a cron run (``CRON_PRINCIPAL_ID``), a process completion or heartbeat (``automation:<route>``,
``local_automation_v1``, a native envelope's ``automation`` block) or a webhook delivery
(``webhook_delivery``) or a Kanban card attempt (``kanban_card_v1``, set by the dispatcher). Pausing on it stalls every message queued behind it until an operator
notices (a Bot Chat sat ten hours behind one).

Such a row settles through the same fenced resolution a person's Discard uses
(``resolve_unknown_session_input``): terminal ``interrupted``, never requeued or replayed, with a
Hermes transcript notice committed in the same transaction. No second recovery store.
"""
from __future__ import annotations

import logging
import os
import time

from hermes_state_keys import CRON_PRINCIPAL_ID

logger = logging.getLogger(__name__)


def is_unattended(row) -> bool:
    """True for an admission no person submitted (so nobody can be asked to resend it)."""
    principal = row.get('principal_id') or ''
    if principal == CRON_PRINCIPAL_ID or principal.startswith('automation:'):
        return True
    payload = row.get('payload') or {}
    native = payload.get('native_text_v1') or {}
    # A webhook delivery: the provider already got its 202 and nobody can be asked to resend it.
    # A Kanban card attempt (#134889 KB-8): the dispatcher's marker, committed only by
    # ``SessionAuthority.submit(_kanban_card=...)``; a card row main minted without it still pauses.
    return ('local_automation_v1' in payload or 'kanban_card_v1' in payload
            or 'automation' in native or 'webhook_delivery' in native)


def _unattended_unknown(rows):
    return [row for row in rows if row['status'] == 'unknown' and is_unattended(row)]


def settle_recovered_unattended(db, epoch) -> int:
    """Boot recovery, right after ``recover_session_inputs`` fenced lost turns ``unknown`` and before
    any FIFO is scheduled: settle every unattended one. Synchronous; runs off the owner loop."""
    from agent.turn_failure_copy import AUTOMATION_INTERRUPTED_NOTICE
    from gateway.session_ingress_media import release_admission_media
    from gateway.session_results import close_discarded_turn
    from hermes_state_runtime import RuntimeStoreError, _row, resolve_unknown_session_input
    with db._read_ctx() as conn:
        rows = [_row(r) for r in conn.execute(
            "SELECT * FROM session_admissions WHERE status='unknown' ORDER BY seq").fetchall()]
    settled = 0
    for row in _unattended_unknown(rows):
        try:
            resolve_unknown_session_input(
                db, epoch=epoch, admission_id=row['admission_id'], generation=row['generation'],
                _terminal_write=lambda conn, lost: close_discarded_turn(db, conn, lost, AUTOMATION_INTERRUPTED_NOTICE))
        except RuntimeStoreError as exc:
            logger.warning('Lost automation admission %s left unknown: %s', row['admission_id'], exc.reason)
            continue
        release_admission_media(db, row['admission_id'])
        settled += 1
        logger.info('Lost automation admission %s on session %s settled interrupted (not replayed)',
                    row['admission_id'], row['target_session_id'])
    return settled


STALE_UNKNOWN_DEFAULT_SECONDS = 600.0


def _stale_after_seconds() -> float:
    """How long a person's lost turn may sit unresolved before a restart settles it."""
    raw = os.environ.get('HERMES_SETTLE_STALE_UNKNOWN_SECONDS', '')
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return STALE_UNKNOWN_DEFAULT_SECONDS
    return value if value > 0 else STALE_UNKNOWN_DEFAULT_SECONDS


def _session_last_activity(db, session_id):
    with db._read_ctx() as conn:
        row = conn.execute('SELECT last_activity_at FROM sessions WHERE id=?',
                           (session_id,)).fetchone()
    return row[0] if row and row[0] is not None else None


def settle_recovered_dead_owner_stale(db, epoch, *, now=None, stale_after_s=None) -> int:
    """Boot recovery, after :func:`settle_recovered_unattended`: settle a PERSON's lost turn that
    nobody resolved before this restart, once it is stale, instead of pausing its session forever.

    ``recover_session_inputs`` fences every turn a previous owner left ``started`` as ``unknown``
    and leaves the old ``owner_epoch`` on the row; no worker can ever attach to it again. An
    interactive row then pauses the session's FIFO until a person resolves it — and at boot there
    is nobody to ask, so a gateway restarted mid-turn wedged its sessions until an operator ran
    ``hermes sessions discard`` (every later restore/continue answered ``unknown_execution``).
    The person is told in the transcript and can resend; nothing is replayed.

    Two guards keep the interactive promise where it still holds. A row fenced by THIS owner
    (``owner_epoch == epoch``) is left alone: someone is present to decide. A row whose session
    was active within ``stale_after_s`` (default 10 min, ``HERMES_SETTLE_STALE_UNKNOWN_SECONDS``)
    is left alone too — the person may still be mid-conversation; the pause notice and ``/discard``
    resolve it as before. A session with no recorded activity is never judged stale.
    """
    from agent.turn_failure_copy import LOST_TURN_NOTICE
    from gateway.session_ingress_media import release_admission_media
    from gateway.session_results import close_discarded_turn
    from hermes_state_runtime import RuntimeStoreError, _row, resolve_unknown_session_input
    cutoff = (time.time() if now is None else now) - (
        _stale_after_seconds() if stale_after_s is None else stale_after_s)
    with db._read_ctx() as conn:
        rows = [_row(r) for r in conn.execute(
            "SELECT * FROM session_admissions WHERE status='unknown' ORDER BY seq").fetchall()]
    settled = 0
    for row in rows:
        if not row or is_unattended(row) or row['owner_epoch'] == epoch:
            continue
        last = _session_last_activity(db, row['target_session_id'])
        if last is None or last > cutoff:
            continue
        try:
            resolve_unknown_session_input(
                db, epoch=epoch, admission_id=row['admission_id'], generation=row['generation'],
                _terminal_write=lambda conn, lost: close_discarded_turn(db, conn, lost, LOST_TURN_NOTICE))
        except RuntimeStoreError as exc:
            logger.warning('Stale lost turn %s left unknown: %s', row['admission_id'], exc.reason)
            continue
        release_admission_media(db, row['admission_id'])
        settled += 1
        logger.info('Stale lost turn %s on session %s settled interrupted (not replayed)',
                    row['admission_id'], row['target_session_id'])
    return settled


def settle_dead_owner_unknown_for_session(db, epoch, session_id, *, now=None) -> int:
    """Settle a lost turn fenced by a DEAD owner in ONE session — no staleness wait.

    ``settle_recovered_dead_owner_stale`` holds back ``stale_after_s`` because a background sweep
    must not close a turn while its person may still be mid-conversation. A NEW prompt arriving in
    that session is the opposite signal: the person is here and wants to move on, and a row left by
    a previous owner epoch can never run again, so leaving it only refuses the prompt with
    ``unknown_execution`` (the desktop's "Turn lost during restart", with its queue stuck behind
    it). Nothing is replayed; the transcript gets the same lost-turn notice.
    """
    from agent.turn_failure_copy import LOST_TURN_NOTICE
    from gateway.session_ingress_media import release_admission_media
    from gateway.session_results import close_discarded_turn
    from hermes_state_runtime import RuntimeStoreError, _row, resolve_unknown_session_input
    with db._read_ctx() as conn:
        rows = [_row(r) for r in conn.execute(
            "SELECT * FROM session_admissions WHERE target_session_id=? AND status='unknown' ORDER BY seq",
            (session_id,)).fetchall()]
    settled = 0
    for row in rows:
        if not row or is_unattended(row) or row['owner_epoch'] == epoch:
            continue
        try:
            resolve_unknown_session_input(
                db, epoch=epoch, admission_id=row['admission_id'], generation=row['generation'],
                _terminal_write=lambda conn, lost: close_discarded_turn(db, conn, lost, LOST_TURN_NOTICE))
        except RuntimeStoreError as exc:
            logger.warning('Lost turn %s left unknown: %s', row['admission_id'], exc.reason)
            continue
        release_admission_media(db, row['admission_id'])
        settled += 1
        logger.info('Lost turn %s on session %s settled: the person sent a new prompt',
                    row['admission_id'], session_id)
    return settled


async def settle_unattended_unknown(authority, ref) -> bool:
    """The drain found an ``unknown`` head (fenced in this owner, e.g. a lost managed worker):
    settle the unattended ones through the owner's resolution. True when any settled, so the
    drain re-reads its FIFO instead of pausing; a person's ``unknown`` row still pauses it."""
    import asyncio

    from agent.turn_failure_copy import AUTOMATION_INTERRUPTED_NOTICE
    from hermes_state_runtime import RuntimeStoreError, list_session_admissions
    rows = await asyncio.to_thread(list_session_admissions, authority.db, session_id=ref.session_id)
    settled = False
    for row in _unattended_unknown(rows):
        try:
            await authority.resolve_unknown_as_owner(ref, row['admission_id'], row['generation'],
                                                     notice=AUTOMATION_INTERRUPTED_NOTICE)
        except RuntimeStoreError as exc:
            logger.warning('Lost automation admission %s left unknown: %s', row['admission_id'], exc.reason)
            continue
        settled = True
    return settled
