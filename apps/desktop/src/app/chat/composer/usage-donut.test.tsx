import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import { resetUsageLimits } from '@/store/usage-limits'

import { UsageDonut } from './usage-donut'

const api = vi.fn()

beforeEach(() => {
  api.mockReset()
  resetUsageLimits()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api }
})

afterEach(cleanup)

const win = (label: string, remaining: number) => ({
  label, used_percent: 100 - remaining, remaining_percent: remaining, resets_at: null, detail: null, scope: 'account'
})

const row = (provider: string, name: string, over = {}) => ({
  provider, name, title: null, plan: null, source: null, fetched_at: null,
  windows: [], details: [], unavailable_reason: null, state: 'ready', ...over
})

describe('UsageDonut', () => {
  it('draws an arc for the current provider and fetches once', async () => {
    api.mockResolvedValue({ providers: [row('anthropic', 'Anthropic', { windows: [win('Current week', 17)] })] })
    render(<UsageDonut provider="anthropic" />)

    const button = await screen.findByTestId('usage-donut')

    expect(button.getAttribute('aria-label')).toMatch(/Anthropic: 17% left \(Current week\)/)
    expect(button.querySelectorAll('circle')[1].getAttribute('class')).toContain('stroke-amber-500')
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when the provider reports no limits', async () => {
    api.mockResolvedValue({ providers: [row('anthropic', 'Anthropic', { windows: [win('Week', 50)] })] })
    render(<UsageDonut provider="gemini" />)
    await vi.waitFor(() => expect(api).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId('usage-donut')).toBeNull()
  })

  it('renders nothing when the request fails', async () => {
    api.mockRejectedValue(new Error('down'))
    render(<UsageDonut provider="anthropic" />)
    await vi.waitFor(() => expect(api).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId('usage-donut')).toBeNull()
  })

  it('falls back to the live session provider when the chat-bar snapshot has none', async () => {
    api.mockResolvedValue({ providers: [row('openai-codex', 'OpenAI Codex', { windows: [win('Weekly', 0)] })] })
    render(
      <SessionViewProvider value={{ ...PRIMARY_SESSION_VIEW, $provider: atom('openai-codex') }}>
        <UsageDonut provider="" />
      </SessionViewProvider>
    )

    const button = await screen.findByTestId('usage-donut')

    expect(button.getAttribute('aria-label')).toMatch(/OpenAI Codex: 0% left/)
  })
})

describe('UsageDonut click', () => {
  it('opens the limits panel when clicked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.mockResolvedValue({ providers: [row('anthropic', 'Anthropic', { windows: [win('Current week', 17)] })] })
    render(<UsageDonut model="claude-haiku-4-5" provider="anthropic" />)
    const button = await screen.findByTestId('usage-donut')
    fireEvent.click(button)
    expect(await screen.findByTestId('usage-build-id')).toBeTruthy()
  })
})

describe('UsageDonut after a failed read', () => {
  it('keeps the menu open while opening it reloads usage', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ providers: [] })
    render(<UsageDonut model="claude-haiku-4-5" provider="anthropic" />)
    const button = await screen.findByTestId('usage-donut-empty')
    fireEvent.click(button)
    expect(await screen.findByTestId('usage-build-id')).toBeTruthy()
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTestId('usage-build-id')).toBeTruthy()
  })
})

describe('UsageDonut placement', () => {
  it('sits directly above the ring, right-aligned, whatever the content does', async () => {
    const { fireEvent } = await import('@testing-library/react')
    api.mockResolvedValue({ providers: [row('anthropic', 'Anthropic', { windows: [win('Week', 40)] })] })
    render(<UsageDonut model="claude-haiku-4-5" provider="anthropic" />)
    const button = await screen.findByTestId('usage-donut')
    button.getBoundingClientRect = () => ({ top: 400, bottom: 424, left: 650, right: 674, width: 24, height: 24, x: 650, y: 400, toJSON: () => ({}) })
    Object.defineProperty(window, 'innerHeight', { value: 456, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 887, configurable: true })
    fireEvent.click(button)
    const pop = await screen.findByTestId('usage-popover')
    await vi.waitFor(() => expect(pop.style.bottom).toBe('64px')) // 456 - 400 + 8
    expect(pop.style.left).toBe('386px') // right edge 674 - width 288
    expect(pop.style.visibility).not.toBe('hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('usage-popover')).toBeNull()
  })
})
