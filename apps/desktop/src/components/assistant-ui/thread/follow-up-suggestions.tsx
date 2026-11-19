import { type FC, useEffect, useState } from 'react'

import { pluginRest } from '@/api/plugins'
import { requestComposerInsert } from '@/app/chat/composer/focus'
import { useComposerScope } from '@/app/chat/composer/scope'
import { Button } from '@/components/ui/button'

type NextPromptResponse = { suggestion?: null | { text?: string }; error?: unknown }

export const parseNextPromptSuggestion = (value: unknown): string => {
  if (!value || typeof value !== 'object') {
    return ''
  }

  const suggestion = (value as NextPromptResponse).suggestion
  const text = typeof suggestion?.text === 'string' ? suggestion.text.trim() : ''

  return text.length > 0 && text.length <= 120 ? text : ''
}

export const FollowUpSuggestions: FC<{ sessionId: string }> = ({ sessionId }) => {
  const scope = useComposerScope()
  const [suggestion, setSuggestion] = useState('')

  useEffect(() => {
    if (!sessionId) {
      return
    }

    let current = true
    setSuggestion('')
    void pluginRest<NextPromptResponse>('next-prompt', `/suggestion?session_id=${encodeURIComponent(sessionId)}`, { timeoutMs: 3_000 }).then(result => {
      if (current) {
        setSuggestion(parseNextPromptSuggestion(result))
      }
    }).catch(() => {
      if (current) {
        setSuggestion('')
      }
    })

    return () => {
      current = false
    }
  }, [sessionId])

  if (!suggestion) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-(--message-text-indent) pb-1" data-slot="assistant-follow-up-suggestions">
      <Button onClick={() => requestComposerInsert(suggestion, { mode: 'block', target: scope.target })} size="xs" type="button" variant="outline">
        {suggestion}
      </Button>
    </div>
  )
}
