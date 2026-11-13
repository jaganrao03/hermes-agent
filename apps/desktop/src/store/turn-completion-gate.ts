/**
 * TURN-COMPLETION GATE — one answer to "did this turn actually finish, with
 * something waiting for the user?", shared by every surface that lights a
 * completion cue (the sidebar's green dot, the OS "Hermes finished" notice).
 *
 * Why it exists: both cues fire on the busy→idle EDGE, which says only that
 * the run stopped. A stopped turn is not always a finished one — the user can
 * cancel it, the provider can fail it, or it can end with a prompt row and no
 * reply at all (a restart, a lost executor). Lighting green for those spends
 * the user's attention on a dead end, which is worse than staying quiet.
 *
 * Deliberately NOT "must have produced text": an image-only or artifact-only
 * reply is a finished turn, so a non-text part counts as content.
 */

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'

export interface TurnSettleSignals {
  /** The user stopped this turn (state.interrupted) — they watched it end. */
  interrupted?: boolean
  /** A clarify/approval is parked; the amber needs-input dot owns the row. */
  needsInput?: boolean
  /** Transcript at settle time, oldest first. */
  messages?: ChatMessage[]
}

/** Anything a person can read or open: text, or a non-text part (image/file). */
const hasContent = (message: ChatMessage): boolean =>
  Boolean(chatMessageText(message).trim()) || Boolean(message.parts?.some(part => part.type !== 'text'))

/**
 * Whether the settle deserves a completion cue.
 *
 * The transcript rules only ever DOWNGRADE a claim the transcript can speak
 * for. A state with no visible rows (a runtime adopted mid-turn, a background
 * profile never loaded here) keeps the old behaviour: silence there would hide
 * real completions rather than filter fake ones.
 */
export function turnLooksDone({ interrupted, needsInput, messages }: TurnSettleSignals): boolean {
  if (interrupted || needsInput) {
    return false
  }

  const transcript = messages ?? []

  if (!transcript.some(message => !message.hidden)) {
    return true
  }

  const lastUserIndex = transcript.findLastIndex(message => !message.hidden && message.role === 'user')

  const reply = transcript
    .slice(lastUserIndex + 1)
    .reverse()
    .find(message => !message.hidden && message.role === 'assistant')

  // A prompt row with nothing after it is the "ended without a reply" case —
  // there is no completion to announce.
  if (lastUserIndex !== -1 && !reply) {
    return false
  }

  if (!reply) {
    return true
  }

  // A failure card is its own cue; a green dot beside it would contradict it.
  // A partial answer that survived the failure is still worth reading, though.
  return hasContent(reply)
}

/** True when the turn ended blocked on the user (parked clarify/approval), so a
 *  caller should announce "needs you" rather than "finished". */
export function turnAwaitsUser({ needsInput }: TurnSettleSignals): boolean {
  return Boolean(needsInput)
}
