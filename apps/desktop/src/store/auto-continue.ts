/**
 * Auto-continue: take the first follow-up chip and send it, so a chain of small
 * steps runs without a click per step.
 *
 * Off by default, and every chain is bounded: an unattended loop spends real
 * model calls, so the counter lives here rather than in the component and a
 * chain never outlives {@link AUTO_CONTINUE_MAX} sends or the page. The chip row
 * always shows the state and one click stops it — a loop the user cannot see
 * ending is worse than no loop at all.
 *
 * Nothing here is persisted: armed by a click, and only for as long as that chain
 * runs. A reload, a finished chain or a stop all leave it off, so auto-continue is
 * never inherited by a conversation the user did not arm.
 */
import { atom } from 'nanostores'

/** Sends per chain. Three small steps is the most a suggestion is worth trusting. */
export const AUTO_CONTINUE_MAX = 3

/** How long a settled reply is left alone before its first chip fires, so the
 *  user can read the answer (and cancel) before anything is sent. */
export const AUTO_CONTINUE_DELAY_MS = 1_500

/** A chain older than this is a stale tab waking up, not a chain: start over. */
const CHAIN_TTL_MS = 30 * 60_000

const chains = new Map<string, Chain>()

interface Chain {
  steps: number
  stopped: boolean
  updatedAt: number
  /** Normalised text of every suggestion this chain already sent. */
  sent: string[]
  /** Signature of the trio the last send came from, '' before the first send. */
  trio: string
  /** The settled reply this chain already acted on, so one reply sends once. */
  handled: string
}

/** Armed by a click in this page, never restored from storage. */
export const $autoContinue = atom<boolean>(false)

export function setAutoContinue(enabled: boolean) {
  // Either way this is a click, and a click starts a fresh budget.
  chains.clear()
  $autoContinue.set(enabled)
}

function chain(sessionId: string): Chain {
  const existing = chains.get(sessionId)

  if (existing && Date.now() - existing.updatedAt < CHAIN_TTL_MS) {
    return existing
  }

  const fresh: Chain = { steps: 0, stopped: false, updatedAt: Date.now(), sent: [], trio: '', handled: '' }
  chains.set(sessionId, fresh)

  return fresh
}

/**: One suggestion reduced to the part that means the same thing twice: case,
 *  spacing, surrounding quotes and trailing punctuation do not make a new step. */
export function normalizeSuggestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '')
    .replace(/[.!?…,:;]+$/g, '')
    .trim()
}

/** A trio is the same trio when every chip normalises identically, in order. */
export function trioSignature(suggestions: readonly string[]): string {
  return suggestions.map(normalizeSuggestion).join(' | ')
}

/** Why this suggestion must not be sent automatically, or null when it is a step
 *  forward. A chain that repeats itself spends model calls on no progress, so the
 *  first repeat ends it instead of running out the counter. */
export function repeatReason(sessionId: string, suggestion: string, suggestions: readonly string[]): 'same-step' | 'same-suggestions' | null {
  const current = chain(sessionId)
  const normalised = normalizeSuggestion(suggestion)

  if (normalised && current.sent.includes(normalised)) {
    return 'same-step'
  }

  return current.trio !== '' && trioSignature(suggestions) === current.trio ? 'same-suggestions' : null
}

/** Steps already taken in this chain. */
export function autoContinueSteps(sessionId: string): number {
  return chain(sessionId).steps
}

/** The settled reply this chain already acted on ('' before the first send). */
export function autoContinueHandled(sessionId: string): string {
  return chain(sessionId).handled
}

/** Record the reply this chain acted on, so one settled reply sends at most once. */
export function markAutoContinueHandled(sessionId: string, key: string) {
  const current = chain(sessionId)

  current.handled = key
  current.updatedAt = Date.now()
}

/** True when another suggestion may be sent for this session. */
export function canAutoContinue(sessionId: string): boolean {
  if (!$autoContinue.get()) {
    return false
  }

  const current = chain(sessionId)

  return !current.stopped && current.steps < AUTO_CONTINUE_MAX
}

/** Count the send that is about to happen, returning the step just spent. */
export function bumpAutoContinue(sessionId: string, sent?: { text?: string; suggestions?: readonly string[] }): number {
  const current = chain(sessionId)

  current.steps += 1
  current.updatedAt = Date.now()

  const normalised = sent?.text === undefined ? '' : normalizeSuggestion(sent.text)

  if (normalised && !current.sent.includes(normalised)) {
    current.sent.push(normalised)
  }

  if (sent?.suggestions) {
    current.trio = trioSignature(sent.suggestions)
  }

  // The budget is spent: disarm, so continuing takes another click.
  if (current.steps >= AUTO_CONTINUE_MAX) {
    $autoContinue.set(false)
  }

  return current.steps
}

/** Stop this chain and disarm: the next run needs a click, never a switch left on
 *  from earlier in the conversation. */
export function endAutoContinueChain(sessionId: string) {
  const current = chain(sessionId)

  current.stopped = true
  current.updatedAt = Date.now()
  $autoContinue.set(false)
}

/** Tests: forget every chain without touching the switch. */
export function resetAutoContinueChains() {
  chains.clear()
}
