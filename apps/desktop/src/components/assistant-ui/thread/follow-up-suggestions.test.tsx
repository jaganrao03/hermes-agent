import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pluginRest } from '@/api/plugins'
import { requestComposerInsert, requestComposerSubmit } from '@/app/chat/composer/focus'

import { FollowUpSuggestions } from './follow-up-suggestions'

vi.mock('@/api/plugins', () => ({ pluginRest: vi.fn() }))
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: vi.fn(), requestComposerSubmit: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.mocked(pluginRest).mockReset()
  vi.mocked(pluginRest).mockImplementation(async () => ({
    suggestion: { text: 'Show an example', session_id: 'session-1', timestamp: 1 },
    suggestions: [
      { text: 'Show an example', session_id: 'session-1', timestamp: 1 },
      { text: 'Explain the tradeoffs', session_id: 'session-1', timestamp: 1 },
      { text: 'Suggest a next step', session_id: 'session-1', timestamp: 1 }
    ],
    error: null
  } as never))
  vi.mocked(requestComposerInsert).mockReset()
  vi.mocked(requestComposerSubmit).mockReset()
})

describe('FollowUpSuggestions', () => {
  it('loads cached session suggestions as chips and inserts only the selected prompt', async () => {
    render(<FollowUpSuggestions sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    const first = await screen.findByRole('button', { name: 'Show an example' })
    expect(first.getAttribute('type')).toBe('button')
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Explain the tradeoffs' }))

    expect(requestComposerInsert).toHaveBeenCalledWith('Explain the tradeoffs', { mode: 'block', target: 'main' })
    expect(requestComposerSubmit).not.toHaveBeenCalled()
  })

  it('retries while suggestions are being generated and renders them when they become available', async () => {
    vi.useFakeTimers()
    vi.mocked(pluginRest)
      .mockResolvedValueOnce({ suggestion: null, suggestions: [], error: null } as never)
      .mockResolvedValue({
        suggestion: { text: 'Show an example' },
        suggestions: [{ text: 'Show an example' }, { text: 'Explain the tradeoffs' }, { text: 'Suggest a next step' }],
        error: null
      } as never)

    render(<FollowUpSuggestions sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByRole('button')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('checks the stored session first and falls back to the runtime id on load', async () => {
    vi.mocked(pluginRest)
      .mockResolvedValueOnce({ suggestion: null, suggestions: [], error: null } as never)
      .mockResolvedValueOnce({
        suggestion: { text: 'Show an example' },
        suggestions: [{ text: 'Show an example' }, { text: 'Explain the tradeoffs' }, { text: 'Suggest a next step' }],
        error: null
      } as never)

    render(<FollowUpSuggestions fallbackSessionId="runtime-session" sessionId="stored-session" />)

    expect(await screen.findAllByRole('button')).toHaveLength(3)
    expect(pluginRest).toHaveBeenNthCalledWith(
      1,
      'next-prompt',
      '/suggestion?session_id=stored-session',
      { timeoutMs: 3_000 }
    )
    expect(pluginRest).toHaveBeenNthCalledWith(
      2,
      'next-prompt',
      '/suggestion?session_id=runtime-session',
      { timeoutMs: 3_000 }
    )
  })

  it('ignores cached suggestions older than the latest user message before checking the runtime id', async () => {
    vi.mocked(pluginRest)
      .mockResolvedValueOnce({
        suggestion: { text: 'Old prompt', timestamp: 99 },
        suggestions: [{ text: 'Old prompt', timestamp: 99 }],
        error: null
      } as never)
      .mockResolvedValueOnce({
        suggestion: { text: 'Fresh prompt', timestamp: 101 },
        suggestions: [{ text: 'Fresh prompt', timestamp: 101 }],
        error: null
      } as never)

    render(<FollowUpSuggestions fallbackSessionId="runtime-session" freshAfter={100} sessionId="stored-session" />)

    expect(await screen.findByRole('button', { name: 'Fresh prompt' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Old prompt' })).toBeNull()
    expect(pluginRest).toHaveBeenCalledTimes(2)
  })

  it('renders no suggestion when the gateway has none for this session', async () => {
    vi.mocked(pluginRest).mockResolvedValue({ suggestion: null, suggestions: [], error: null } as never)
    render(<FollowUpSuggestions sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
