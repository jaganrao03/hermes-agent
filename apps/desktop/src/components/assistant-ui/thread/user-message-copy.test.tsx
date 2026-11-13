// A sent prompt had no Copy affordance: only the assistant reply did. The user
// bubble's hover/touch cluster now carries one, and it must copy exactly the
// prompt text the operator sent (not the attachments, the transcript, or the
// assistant's answer).
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import { $touchPointer } from '@/lib/touch-interaction'
import type { SessionMessage } from '@/types/hermes'

import { stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

beforeEach(stubThreadEnvironment)
afterEach(() => {
  cleanup()
  $touchPointer.set(false)
  vi.unstubAllGlobals()
})

const prompt = 'Refactor parser.ts and re-run the tests.'

const stored: SessionMessage[] = [
  { role: 'user', content: prompt, timestamp: 1 },
  { role: 'assistant', content: 'Refactored; 42 tests pass.', timestamp: 2 }
]

function renderThread() {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })

  const rendered = render(
    <ThreadRuntime messages={toChatMessages(stored).map(toRuntimeMessage)}>
      <Thread />
    </ThreadRuntime>
  )

  return { clipboard, ...rendered }
}

it.each(['desktop', 'touch'])('the user bubble exposes Copy on %s and copies the prompt text', async surface => {
  $touchPointer.set(surface === 'touch')
  const { clipboard, container } = renderThread()

  await waitFor(() => expect(container.textContent).toContain(prompt))

  const actions = container.querySelector('[data-slot="aui_user-bubble-actions"]') as HTMLElement
  expect(actions).toBeTruthy()

  const copyButton = actions.querySelector('button[aria-label="Copy"]') as HTMLButtonElement
  expect(copyButton).toBeTruthy()

  fireEvent.click(copyButton)

  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(prompt))
})
