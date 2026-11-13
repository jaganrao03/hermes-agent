/**
 * PARKED PROMPTS — "is this session blocked on the user right now?"
 *
 * A turn that ends with a clarify question, an approval card, a sudo prompt or
 * a vault unlock is not a finished turn: the work cannot continue until the
 * user answers. Surfaces that announce completions ask this first, so the
 * "needs you" cue wins and the "finished" one stays quiet.
 *
 * Kept separate from turn-completion-gate.ts so the gate stays a pure function
 * of the transcript and this stays the one place that knows which prompt
 * stores exist (adding a new prompt verb means one edit here, not one per
 * caller).
 */

import { sessionClarifyRequest } from './clarify'
import {
  sessionApprovalRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  sessionVaultUnlockRequest
} from './prompts'

/** Every prompt store reads the same way for this purpose; the request shapes
 *  differ, so only `get()` matters here. */
type AnyPromptStore = { get: () => unknown }

const isParked = (store: AnyPromptStore): boolean => Boolean(store.get())

/** True when any blocking prompt is waiting for THIS session's user. */
export function hasParkedUserPrompt(sessionId: null | string | undefined): boolean {
  if (!sessionId) {
    return false
  }

  return (
    isParked(sessionApprovalRequest(sessionId)) ||
    isParked(sessionClarifyRequest(sessionId)) ||
    isParked(sessionSudoRequest(sessionId)) ||
    isParked(sessionSecretRequest(sessionId)) ||
    isParked(sessionVaultUnlockRequest(sessionId))
  )
}
