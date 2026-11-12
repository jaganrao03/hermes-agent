import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pluginRest } from '@/api/plugins'
import { requestComposerGetDraft, requestComposerInsert, requestComposerSubmit } from '@/app/chat/composer/focus'
import { canAutoContinue, resetAutoContinueChains, setAutoContinue } from '@/store/auto-continue'

import { FollowUpSuggestions } from './follow-up-suggestions'

vi.mock('@/api/plugins', () => ({ pluginRest: vi.fn() }))
vi.mock('@/app/chat/composer/focus', () => ({
  requestComposerGetDraft: vi.fn(),
  requestComposerInsert: vi.fn(),
  requestComposerSubmit: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  localStorage.clear()
  resetAutoContinueChains()
  setAutoContinue(false)
  vi.mocked(pluginRest).mockReset()
  vi.mocked(requestComposerGetDraft).mockReset()
  vi.mocked(requestComposerGetDraft).mockImplementation(async () => ({ text: '' }))
  // Production returns true once the send is accepted; a falsy return ends the chain.
  vi.mocked(requestComposerSubmit).mockReturnValue(true)
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
  // Production returns true once the send is accepted; a falsy return ends the chain.
  vi.mocked(requestComposerSubmit).mockReturnValue(true)
})

describe('FollowUpSuggestions', () => {
  /** Every chip button; the auto-continue control shares the row but is not a prompt. */
  const chips = () => screen.getAllByRole('button').filter(button => button.dataset.slot !== 'follow-up-auto-continue')

  const messages = [
    { role: 'user' as const, content: 'Fix the parser' },
    { role: 'assistant' as const, content: 'Fixed the null check in parser.py.' }
  ]

  it('renders nothing at all when the request fails', async () => {
    vi.useFakeTimers()
    vi.mocked(pluginRest).mockRejectedValue(new Error('HTTP 503'))
    const { container } = render(<FollowUpSuggestions messages={messages} sessionId="session-1" />)

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('stays silent when the backend reports an error for generation', async () => {
    vi.useFakeTimers()
    vi.mocked(pluginRest).mockResolvedValue({ suggestion: null, suggestions: [], error: { kind: 'auth', timestamp: 101 } } as never)
    const { container } = render(<FollowUpSuggestions freshAfter={100} messages={messages} sessionId="session-1" />)

    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })

    expect(container.textContent).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries generation quietly after a failed attempt and then shows the chips', async () => {
    vi.useFakeTimers()
    let generates = 0
    vi.mocked(pluginRest).mockImplementation(async (_plugin: string, path: string) => {
      if (path !== '/generate') {return { suggestion: null, suggestions: [], error: null } as never}
      generates += 1

      if (generates === 1) {throw new Error('HTTP 500')}

      return { suggestions: [{ text: 'Test the parser', timestamp: 101 }], error: null } as never
    })

    render(<FollowUpSuggestions freshAfter={100} messages={messages} sessionId="old-session" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })

    expect(screen.getByRole('button', { name: 'Test the parser' })).toBeTruthy()
    expect(generates).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('generates suggestions for an opened historical session with no cached row', async () => {
    vi.useFakeTimers()
    let generates = 0
    vi.mocked(pluginRest).mockImplementation(async (_plugin: string, path: string) => {
      if (path !== '/generate') {return { suggestion: null, suggestions: [], error: null } as never}
      generates += 1

      return { suggestions: [{ text: 'Test the parser', timestamp: 101 }], error: null } as never
    })

    render(<FollowUpSuggestions freshAfter={100} messages={messages} sessionId="old-session" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })

    expect(screen.getByRole('button', { name: 'Test the parser' })).toBeTruthy()
    expect(generates).toBe(1)
    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/generate', {
      method: 'POST', timeoutMs: 90_000,
      body: { session_id: 'old-session', messages, fresh_after: 100 }
    })
  })

  it('does not let a failed stored-id request hide valid runtime suggestions', async () => {
    vi.mocked(pluginRest).mockRejectedValueOnce(new Error('HTTP 503'))
    render(<FollowUpSuggestions fallbackSessionId="runtime-session" messages={[]} sessionId="stored-session" />)

    expect(await screen.findByRole('button', { name: 'Show an example' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not publish a late response after switching sessions', async () => {
    let finish!: (value: never) => void
    vi.mocked(pluginRest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { rerender } = render(<FollowUpSuggestions messages={[]} sessionId="old-session" />)
    rerender(<FollowUpSuggestions messages={[]} sessionId="new-session" />)
    expect(await screen.findByRole('button', { name: 'Show an example' })).toBeTruthy()
    await act(async () => { finish({ suggestions: [{ text: 'Wrong old session' }] } as never) })
    expect(screen.queryByRole('button', { name: 'Wrong old session' })).toBeNull()
  })

  it('gives up without any visible message when polling is exhausted', async () => {
    vi.useFakeTimers()
    vi.mocked(pluginRest).mockResolvedValue({ suggestion: null, suggestions: [], error: null } as never)
    const { container } = render(<FollowUpSuggestions messages={[]} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000) })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('loads cached session suggestions as chips and inserts only the selected prompt', async () => {
    render(<FollowUpSuggestions messages={[]} sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    const first = await screen.findByRole('button', { name: 'Show an example' })
    expect(first.getAttribute('type')).toBe('button')
    expect(chips()).toHaveLength(3)
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

    render(<FollowUpSuggestions messages={[]} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByRole('button')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(chips()).toHaveLength(3)
  })

  it('checks the stored session first and falls back to the runtime id on load', async () => {
    vi.mocked(pluginRest)
      .mockResolvedValueOnce({ suggestion: null, suggestions: [], error: null } as never)
      .mockResolvedValueOnce({
        suggestion: { text: 'Show an example' },
        suggestions: [{ text: 'Show an example' }, { text: 'Explain the tradeoffs' }, { text: 'Suggest a next step' }],
        error: null
      } as never)

    render(<FollowUpSuggestions fallbackSessionId="runtime-session" messages={[]} sessionId="stored-session" />)

    expect((await screen.findAllByRole('button')).filter(button => button.dataset.slot !== 'follow-up-auto-continue')).toHaveLength(3)
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

    render(<FollowUpSuggestions fallbackSessionId="runtime-session" freshAfter={100} messages={[]} sessionId="stored-session" />)

    expect(await screen.findByRole('button', { name: 'Fresh prompt' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Old prompt' })).toBeNull()
    expect(pluginRest).toHaveBeenCalledTimes(2)
  })

  it('never strands the previous turn\'s chips under a newer reply', async () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    // The stored row is only seconds old, yet it predates the user's message:
    // it belongs to the reply above, so this reply must not show it.
    vi.mocked(pluginRest).mockResolvedValue({
      suggestion: { text: 'Persisted prompt', timestamp: now - 300 },
      suggestions: [{ text: 'Persisted prompt', timestamp: now - 300 }],
      error: null,
      status: 'empty',
      timestamp: now + 1
    } as never)

    const { container } = render(<FollowUpSuggestions fallbackSessionId="runtime-session" freshAfter={now} messages={[]} sessionId="stored-session" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000) })

    expect(screen.queryByRole('button', { name: 'Persisted prompt' })).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('drops a stored row once it is older than a day', async () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    vi.mocked(pluginRest).mockResolvedValue({
      suggestion: { text: 'Ancient prompt', timestamp: now - 90_000 },
      suggestions: [{ text: 'Ancient prompt', timestamp: now - 90_000 }],
      error: null
    } as never)

    const { container } = render(<FollowUpSuggestions freshAfter={now} messages={[]} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000) })

    expect(screen.queryByRole('button', { name: 'Ancient prompt' })).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('leaves auto-continue off by default and never sends by itself', async () => {
    vi.useFakeTimers()
    render(<FollowUpSuggestions messages={messages} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })

    expect(requestComposerSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('sends the first chip once when auto-continue is on', async () => {
    vi.useFakeTimers()
    setAutoContinue(true)
    render(<FollowUpSuggestions messages={messages} sessionId="session-1" />)
    // The chips land first; the auto-send timer is armed by the commit after them.
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(requestComposerSubmit).toHaveBeenCalledTimes(1)
    expect(requestComposerSubmit).toHaveBeenCalledWith('Show an example', expect.anything())
    expect(screen.getByRole('button', { name: 'Auto 1/3' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('stops the chain rather than overwrite a draft the user is writing', async () => {
    vi.useFakeTimers()
    setAutoContinue(true)
    vi.mocked(requestComposerGetDraft).mockResolvedValue({ text: 'half-typed question' })
    render(<FollowUpSuggestions messages={messages} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(requestComposerSubmit).not.toHaveBeenCalled()
    expect(canAutoContinue('session-1')).toBe(false)
  })

  it('ends the chain instead of sending the same suggestion a second time', async () => {
    vi.useFakeTimers()
    setAutoContinue(true)
    const { rerender } = render(<FollowUpSuggestions messages={messages} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(requestComposerSubmit).toHaveBeenCalledTimes(1)

    // A new turn settles and the plugin hands back the same trio: no progress.
    const nextTurn = [...messages, { role: 'assistant' as const, content: 'Anything else?' }]
    rerender(<FollowUpSuggestions messages={nextTurn} sessionId="session-1" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(requestComposerSubmit).toHaveBeenCalledTimes(1)
    expect(canAutoContinue('session-1')).toBe(false)
  })

  it('renders no suggestion when the gateway has none for this session', async () => {
    vi.mocked(pluginRest).mockResolvedValue({ suggestion: null, suggestions: [], error: null } as never)
    render(<FollowUpSuggestions messages={[]} sessionId="session-1" />)

    expect(pluginRest).toHaveBeenCalledWith('next-prompt', '/suggestion?session_id=session-1', { timeoutMs: 3_000 })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button')).toBeNull()
  })
})