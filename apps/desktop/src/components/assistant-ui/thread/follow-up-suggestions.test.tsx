import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pluginRest } from '@/api/plugins'
import { requestComposerInsert, requestComposerSubmit } from '@/app/chat/composer/focus'

import { FollowUpSuggestions } from './follow-up-suggestions'

vi.mock('@/api/plugins', () => ({ pluginRest: vi.fn() }))
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: vi.fn(), requestComposerSubmit: vi.fn() }))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(pluginRest).mockReset()
  vi.mocked(pluginRest).mockImplementation(async () => ({
    suggestion: { text: 'Show an example', session_id: 'session-1', timestamp: 1 },
    error: null
  } as never))
  vi.mocked(requestComposerInsert).mockReset()
  vi.mocked(requestComposerSubmit).mockReset()
})

describe('FollowUpSuggestions', () => {
  it('loads the cached session suggestion immediately and inserts it without submitting', async () => {
    render(<FollowUpSuggestions sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    const suggestion = await screen.findByRole('button', { name: 'Show an example' })
    expect(suggestion.getAttribute('type')).toBe('button')
    fireEvent.click(suggestion)

    expect(requestComposerInsert).toHaveBeenCalledWith('Show an example', { mode: 'block', target: 'main' })
    expect(requestComposerSubmit).not.toHaveBeenCalled()
  })

  it('renders no suggestion when the gateway has none for this session', async () => {
    vi.mocked(pluginRest).mockResolvedValue({ suggestion: null, error: null } as never)
    render(<FollowUpSuggestions sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
