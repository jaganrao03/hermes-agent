import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo, useState } from 'react'

import { pluginRest } from '@/api/plugins'
import { requestComposerGetDraft, requestComposerInsert, requestComposerSubmit } from '@/app/chat/composer/focus'
import { useComposerScope } from '@/app/chat/composer/scope'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import {
  $autoContinue,
  AUTO_CONTINUE_DELAY_MS,
  AUTO_CONTINUE_MAX,
  autoContinueHandled,
  autoContinueSteps,
  bumpAutoContinue,
  canAutoContinue,
  endAutoContinueChain,
  markAutoContinueHandled,
  repeatReason,
  setAutoContinue
} from '@/store/auto-continue'

interface ContextMessage { role: 'user' | 'assistant'; content: string }
interface NextPromptSuggestion { text?: string; timestamp?: number }
interface NextPromptResponse {
  suggestion?: null | NextPromptSuggestion
  suggestions?: null | NextPromptSuggestion[]
  error?: unknown
  status?: string
  timestamp?: number
}

/**
 * Read the stored turn's chips.
 *
 * With a turn time (the latest user message's gateway timestamp), a row is only
 * usable when it was generated at or after that message — otherwise it is the
 * PREVIOUS turn's row, and showing it under a newer reply strands every answer
 * with the last answer's chips. Without one, accept anything: there is nothing
 * to compare against.
 */
export const parseNextPromptSuggestions = (value: unknown, freshAfter?: number): string[] => {
  if (!value || typeof value !== 'object') {return []}
  const response = value as NextPromptResponse
  const candidates = Array.isArray(response.suggestions) ? response.suggestions : [response.suggestion]
  const suggestions: string[] = []
  const seen = new Set<string>()

  const usable = (timestamp: number | undefined): boolean =>
    freshAfter === undefined || (typeof timestamp === 'number' && timestamp >= freshAfter)

  for (const candidate of candidates) {
    const text = typeof candidate?.text === 'string' ? candidate.text.trim() : ''

    const timestamp = typeof candidate?.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? candidate.timestamp : undefined

    const key = text.toLowerCase()

    if (!text || text.length > 120 || seen.has(key) || !usable(timestamp)) {continue}

    suggestions.push(text)
    seen.add(key)

    if (suggestions.length >= 3) {break}
  }

  return suggestions
}

/** Cached-row poll interval, and how long we wait for one before generating. */
const POLL_MS = 1_000
const POLL_ATTEMPTS = 10
/** Backoff between generation attempts; nothing is ever surfaced about them. */
const RETRY_DELAYS = [2_000, 6_000, 15_000]

interface FollowUpSuggestionsProps {
  sessionId: string
  fallbackSessionId?: string
  freshAfter?: number
  messages?: ContextMessage[]
}

/**
 * The tail of the settled transcript, shaped for the next-prompt model.
 *
 * Read HERE, in the leaf, and never in `AssistantMessageBody`: a `useAuiState`
 * selector subscribes its component to thread-wide state, and the message ROOT
 * re-rendering on a status flip is the exact invalidation widening that
 * `status-invalidation-scope.test.tsx` counts renders to prevent.
 */
const useSettledThreadContext = (): ContextMessage[] | null => {
  const json = useAuiState(s => {
    if (s.thread.isRunning || s.thread.messages.at(-1)?.id !== s.message.id) {return null}
    const exchanges: { role: 'user' | 'assistant'; content: string }[][] = []

    for (const message of s.thread.messages) {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()

      if (!text) {continue}
      // Head/tail clipping bounds both transport and model cost, keeping the
      // conclusion of a long reply rather than only its opening narration.
      const content = text.length > 1200 ? `${text.slice(0, 300)} … ${text.slice(-900)}` : text

      if (message.role === 'user') {exchanges.push([{ role: 'user', content }])}
      else if (message.role === 'assistant' && exchanges.length > 0) {
        const exchange = exchanges[exchanges.length - 1]
        exchange.splice(1, 1, { role: 'assistant', content })
      }
    }

    return JSON.stringify(exchanges.slice(-2).flat())
  })

  return useMemo(() => (json === null ? null : (JSON.parse(json) as ContextMessage[])), [json])
}

/**
 * Follow-up chips under the latest settled reply.
 *
 * Failures are deliberately invisible: a stale route, a rate limit or an
 * offline gateway just means no chips, never an error banner under Jagan's
 * answer. Generation is retried quietly in the background instead.
 */
export const FollowUpSuggestions: FC<FollowUpSuggestionsProps> = props =>
  // A caller-supplied transcript (tests, and any embedding that already has the
  // messages) must not need a runtime provider just to mount this leaf.
  props.messages ? (
    <FollowUpSuggestionsBody {...props} messages={props.messages} />
  ) : (
    <FollowUpSuggestionsLive {...props} />
  )

/** Live path: the only component that subscribes, and the only one that decides
 *  whether a reply is settled enough to offer chips. Both live here so the
 *  message ROOT reads no thread state for follow-ups at all. */
const FollowUpSuggestionsLive: FC<FollowUpSuggestionsProps> = props => {
  const messages = useSettledThreadContext()

  return messages ? <FollowUpSuggestionsBody {...props} messages={messages} /> : null
}

const FollowUpSuggestionsBody: FC<FollowUpSuggestionsProps> = ({ fallbackSessionId, freshAfter, messages, sessionId }) => {
  const scope = useComposerScope()
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const autoOn = useStore($autoContinue)
  const [autoSteps, setAutoSteps] = useState(() => autoContinueSteps(sessionId))
  // The context is small and only supplied for a settled reply. An equivalent
  // array from a rerender must not restart generation or exhaust model limits.
  const contextKey = JSON.stringify(messages ?? [])

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const context = JSON.parse(contextKey) as ContextMessage[]
    const sessionIds = [...new Set([sessionId, fallbackSessionId].filter((id): id is string => Boolean(id)))]

    const sleep = (ms: number): Promise<void> => new Promise(resolve => { timer = setTimeout(resolve, ms) })

    const fresh = (timestamp: number | undefined): boolean =>
      freshAfter === undefined || (typeof timestamp === 'number' && timestamp >= freshAfter)

    /** Publish chips (true) or report a definitive "no suggestions" (true) or a miss (false). */
    const settle = (result: NextPromptResponse): boolean => {
      const next = parseNextPromptSuggestions(result, freshAfter)

      if (next.length > 0) {
        setSuggestions(next)
        setLoading(false)

        return true
      }

      if (result.status === 'empty' && fresh(result.timestamp)) {
        setLoading(false)

        return true
      }

      return false
    }

    /** One pass over the candidate session ids. */
    const readCached = async (): Promise<'settled' | 'pending' | 'miss'> => {
      let pending = false

      for (const candidateSessionId of sessionIds) {
        try {
          const result = await pluginRest<NextPromptResponse>('next-prompt',
            `/suggestion?session_id=${encodeURIComponent(candidateSessionId)}`, { timeoutMs: 3_000 })

          if (!current) {return 'settled'}

          if (settle(result)) {return 'settled'}
          pending ||= result.status === 'pending' && fresh(result.timestamp)
        } catch {
          // A failing id must not hide a working one, and never reaches the UI.
        }
      }

      return pending ? 'pending' : 'miss'
    }

    const run = async (): Promise<void> => {
      // 1. Wait out the in-process hook write for a finished turn.
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        if ((await readCached()) !== 'miss') {return}

        if (!current) {return}
        await sleep(POLL_MS)
      }

      // 2. Nothing stored: ask for suggestions for this transcript (an opened
      //    historical session, or a profile whose hook never ran).
      if (context.length < 2) {
        setLoading(false)

        return
      }

      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
        try {
          const result = await pluginRest<NextPromptResponse>('next-prompt', '/generate', {
            method: 'POST', timeoutMs: 90_000,
            body: { session_id: sessionId, messages: context, fresh_after: freshAfter }
          })

          if (!current) {return}

          if (settle(result)) {return}
        } catch {
          // Silent: the chips simply do not appear.
        }

        if (!current) {return}

        const delay = RETRY_DELAYS[attempt]

        if (delay === undefined) {break}
        await sleep(delay)
      }

      setLoading(false)
    }

    setSuggestions([])
    setLoading(true)

    if (sessionIds.length > 0) {void run()}
    else {setLoading(false)}

    return () => {
      current = false

      if (timer !== undefined) {clearTimeout(timer)}
    }
  }, [contextKey, fallbackSessionId, freshAfter, sessionId])

  /**
   * Auto-continue: send the first chip once this reply settles, so a chain of
   * small steps runs on its own. The delay keeps the answer readable and
   * cancellable, and a draft in the composer means the user is writing — sending
   * would replace it, so the chain stops instead.
   */
  useEffect(() => {
    const [next] = suggestions

    if (!autoOn || !next || !canAutoContinue(sessionId)) {return}

    // One auto-send per settled reply: re-entering for the same context would
    // re-offer the chip it just sent and stop a healthy chain on the spot.
    if (autoContinueHandled(sessionId) === contextKey) {return}

    const timer = setTimeout(() => {
      void (async () => {
        if (!canAutoContinue(sessionId)) {return}

        // This reply is spent whether the send lands, repeats or fails.
        markAutoContinueHandled(sessionId, contextKey)

        const draft = await requestComposerGetDraft([sessionId], { active: true }).catch(() => null)

        if (draft?.text?.trim()) {
          endAutoContinueChain(sessionId)
          setAutoSteps(autoContinueSteps(sessionId))

          return
        }

        if (!canAutoContinue(sessionId)) {return}

        // A repeat is not progress: the chain ends here instead of spending a call
        // on a step it already took.
        if (repeatReason(sessionId, next, suggestions)) {
          endAutoContinueChain(sessionId)
          setAutoSteps(autoContinueSteps(sessionId))

          return
        }

        setAutoSteps(bumpAutoContinue(sessionId, { text: next, suggestions }))

        if (!requestComposerSubmit(next, { target: scope.target })) {
          endAutoContinueChain(sessionId)
        }
      })()
    }, AUTO_CONTINUE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [autoOn, contextKey, scope.target, sessionId, suggestions])

  if (suggestions.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 px-(--message-text-indent) pb-1" data-slot="assistant-follow-up-suggestions">
        {suggestions.map((suggestion, index) => (
          <Button key={`${index}-${suggestion}`} onClick={() => requestComposerInsert(suggestion, { mode: 'block', target: scope.target })} size="xs" type="button" variant="outline">
            {suggestion}
          </Button>
        ))}
        <Tip label={autoOn
          ? `Sending the first suggestion by itself, up to ${AUTO_CONTINUE_MAX} steps. Click to stop.`
          : `Send the first suggestion by itself, up to ${AUTO_CONTINUE_MAX} steps`}>
          <Button
            aria-pressed={autoOn}
            className="text-muted-foreground"
            data-slot="follow-up-auto-continue"
            onClick={() => setAutoContinue(!autoOn)}
            size="xs"
            type="button"
            variant="ghost">
            {autoOn ? `Auto ${autoSteps}/${AUTO_CONTINUE_MAX}` : 'Auto'}
          </Button>
        </Tip>
      </div>
    )
  }

  if (!loading) {return null}

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-(--message-text-indent) pb-1" data-slot="assistant-follow-up-suggestions" />
  )
}
