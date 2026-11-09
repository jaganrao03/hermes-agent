import { type FC, useEffect, useState } from 'react'

import { pluginRest } from '@/api/plugins'
import { requestComposerInsert } from '@/app/chat/composer/focus'
import { useComposerScope } from '@/app/chat/composer/scope'
import { Button } from '@/components/ui/button'

type NextPromptSuggestion = { text?: string; timestamp?: number }
type NextPromptResponse = {
  suggestion?: null | NextPromptSuggestion
  suggestions?: null | NextPromptSuggestion[]
  error?: unknown
}

export const parseNextPromptSuggestions = (value: unknown, freshAfter?: number): string[] => {
  if (!value || typeof value !== 'object') {
    return []
  }

  const response = value as NextPromptResponse
  const candidates = Array.isArray(response.suggestions) ? response.suggestions : [response.suggestion]
  const suggestions: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const text = typeof candidate?.text === 'string' ? candidate.text.trim() : ''

    const timestamp = typeof candidate?.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? candidate.timestamp
      : undefined

    const key = text.toLowerCase()

    // The stable stored ID can retain a previous turn's row after a runtime
    // ID rotates. Only show suggestions generated after the latest user turn.
    if (
      text.length === 0 ||
      text.length > 120 ||
      seen.has(key) ||
      (freshAfter !== undefined && (timestamp === undefined || timestamp < freshAfter))
    ) {
      continue
    }

    suggestions.push(text)

    seen.add(key)

    if (suggestions.length >= 3) {
      break
    }
  }

  return suggestions
}

export const FollowUpSuggestions: FC<{ sessionId: string; fallbackSessionId?: string; freshAfter?: number }> = ({
  fallbackSessionId,
  freshAfter,
  sessionId
}) => {
  const scope = useComposerScope()
  const [suggestions, setSuggestions] = useState<string[]>([])

  useEffect(() => {
    let current = true
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const sessionIds = [...new Set([sessionId, fallbackSessionId].filter((id): id is string => Boolean(id)))]

    const poll = async (): Promise<void> => {
      for (const candidateSessionId of sessionIds) {
        try {
          const result = await pluginRest<NextPromptResponse>(
            'next-prompt',
            `/suggestion?session_id=${encodeURIComponent(candidateSessionId)}`,
            { timeoutMs: 3_000 }
          )

          if (!current) {
            return
          }

          const next = parseNextPromptSuggestions(result, freshAfter)

          if (next.length > 0) {
            setSuggestions(next)

            return
          }
        } catch {
          if (!current) {
            return
          }
        }
      }

      if (!current) {
        return
      }

      attempts += 1

      if (attempts < 60) {
        timer = setTimeout(() => { void poll() }, 1_000)
      }
    }

    setSuggestions([])

    if (sessionIds.length > 0) {
      void poll()
    }

    return () => {
      current = false

      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }, [fallbackSessionId, freshAfter, sessionId])

  if (suggestions.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-(--message-text-indent) pb-1" data-slot="assistant-follow-up-suggestions">
      {suggestions.map((suggestion, index) => (
        <Button key={`${index}-${suggestion}`} onClick={() => requestComposerInsert(suggestion, { mode: 'block', target: scope.target })} size="xs" type="button" variant="outline">
          {suggestion}
        </Button>
      ))}
    </div>
  )
}
