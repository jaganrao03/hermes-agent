import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
})
