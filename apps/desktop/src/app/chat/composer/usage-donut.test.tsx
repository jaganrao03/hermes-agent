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
    screen.getByTestId('usage-donut-group').getBoundingClientRect = () => ({ top: 400, bottom: 424, left: 650, right: 674, width: 24, height: 24, x: 650, y: 400, toJSON: () => ({}) })
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

describe('UsageDonut provider precedence', () => {
  it('follows a Claude model even when the provider snapshot still says codex', async () => {
    api.mockResolvedValue({
      providers: [
        row('openai-codex', 'OpenAI Codex', { windows: [win('Weekly', 0)] }),
        row('anthropic', 'Anthropic', { windows: [win('Session', 94)] })
      ]
    })
    render(<UsageDonut model="claude-sonnet-5-5" provider="openai-codex" />)
    const button = await screen.findByTestId('usage-donut')

    expect(button.getAttribute('aria-label')).toMatch(/Anthropic: 94% left/)
  })
})

describe('UsageDonut model wins over a stale provider', () => {
  it('shows Anthropic when the model is Sonnet even though the provider still says codex', async () => {
    api.mockResolvedValue({
      providers: [
        row('openai-codex', 'OpenAI Codex', { windows: [win('Weekly', 0)] }),
        row('anthropic', 'Anthropic', { windows: [win('Session', 94)] })
      ]
    })
    render(<UsageDonut model="claude-sonnet-5-5" provider="openai-codex" />)
    const button = await screen.findByTestId('usage-donut')
    expect(button.getAttribute('aria-label')).toMatch(/Anthropic: 94% left/)
  })
})

describe('UsageDonut one ring per provider', () => {
  const two = () =>
    api.mockResolvedValue({
      providers: [
        row('openai-codex', 'OpenAI Codex', { windows: [win('Weekly', 0)] }),
        row('anthropic', 'Anthropic', { windows: [win('Session', 91), win('Week', 98)] })
      ]
    })

  it('draws both providers side by side with distinct tones', async () => {
    two()
    render(<UsageDonut model="claude-sonnet-5-5" provider="anthropic" />)
    const cur = await screen.findByTestId('usage-donut')
    const other = await screen.findByTestId('usage-donut-other')

    expect(cur.getAttribute('aria-label')).toMatch(/Anthropic: 91% left/)
    expect(other.getAttribute('aria-label')).toMatch(/OpenAI Codex: 0% left/)
    expect(cur.querySelectorAll('circle')[1].getAttribute('class')).toContain('stroke-emerald-500')
    expect(other.querySelectorAll('circle')[1].getAttribute('class')).toContain('stroke-destructive')
  })

  it('emphasises only the current provider and follows a switch', async () => {
    two()
    render(<UsageDonut model="gpt-6-luna" provider="openai-codex" />)
    const cur = await screen.findByTestId('usage-donut')

    expect(cur.getAttribute('aria-label')).toMatch(/OpenAI Codex/)
    expect(cur.getAttribute('data-current')).toBe('true')
    expect(screen.getByTestId('usage-donut-other').getAttribute('data-current')).toBeNull()
  })

  it('shows an amber ring at 20% left', async () => {
    api.mockResolvedValue({
      providers: [
        row('anthropic', 'Anthropic', { windows: [win('Week', 18)] }),
        row('openai-codex', 'OpenAI Codex', { windows: [win('Weekly', 80)] })
      ]
    })
    render(<UsageDonut provider="anthropic" />)
    const cur = await screen.findByTestId('usage-donut')

    expect(cur.querySelectorAll('circle')[1].getAttribute('class')).toContain('stroke-amber-500')
  })

  it('shows other providers even when the current one reports nothing', async () => {
    two()
    render(<UsageDonut provider="gemini" />)
    expect(await screen.findAllByTestId('usage-donut-other')).toHaveLength(2)
    expect(screen.queryByTestId('usage-donut')).toBeNull()
  })
})

