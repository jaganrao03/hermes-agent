import { describe, expect, it } from 'vitest'

import type { UsageLimitProvider } from '@/api/usage-limits'

import { limitTone, toProviderLimitsView, visibleLimitProviders } from './usage-limits-model'

const NOW = Date.parse('2026-11-24T12:00:00Z')

function provider(over: Partial<UsageLimitProvider> = {}): UsageLimitProvider {
  return {
    provider: 'openai-codex',
    name: 'Codex',
    title: null,
    plan: 'Plus',
    source: 't',
    fetched_at: null,
    windows: [],
    details: [],
    unavailable_reason: null,
    state: 'ready',
    ...over
  }
}

const win = (label: string, remaining: null | number, resets: null | string = null) => ({
  label,
  used_percent: remaining === null ? null : 100 - remaining,
  remaining_percent: remaining,
  resets_at: resets,
  detail: null,
  scope: 'account'
})

describe('limitTone', () => {
  it('turns amber at 20% left and red at 10%', () => {
    expect(limitTone(50)).toBe('ok')
    expect(limitTone(20)).toBe('notice')
    expect(limitTone(10)).toBe('warn')
    expect(limitTone(0)).toBe('warn')
  })
})

describe('toProviderLimitsView', () => {
  it('shows what is LEFT and leads with the tightest window', () => {
    const view = toProviderLimitsView(
      provider({ windows: [win('Weekly', 80), win('5 hour', 15, '2026-11-24T15:00:00Z')] }),
      NOW
    )

    expect(view.rows.map(r => r.label)).toEqual(['5 hour', 'Weekly'])
    expect(view.rows[0]).toMatchObject({ fraction: 0.15, remainingText: '15% left', tone: 'notice' })
    expect(view.rows[0].resetText).toMatch(/^resets /)
    expect(view.rows[1].resetText).toBeNull()
  })

  it('drops windows with no percentage and past reset times', () => {
    const view = toProviderLimitsView(
      provider({ windows: [win('Unknown', null), win('Old', 40, '2026-11-24T10:00:00Z')] }),
      NOW
    )

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].resetText).toBeNull()
  })

  it('clamps out-of-range percentages', () => {
    const view = toProviderLimitsView(provider({ windows: [win('Odd', 140)] }), NOW)

    expect(view.rows[0].fraction).toBe(1)
  })
})

describe('visibleLimitProviders', () => {
  it('keeps balance-only providers and drops unreadable ones', () => {
    const views = visibleLimitProviders(
      [
        provider({ provider: 'deepseek', name: 'DeepSeek', plan: null, details: ['Balance: $12.50'] }),
        provider({ provider: 'broken', name: 'Broken', state: 'unavailable', unavailable_reason: 'fetch failed' }),
        provider({ windows: [win('Weekly', 60)] })
      ],
      NOW
    )

    expect(views.map(v => v.provider)).toEqual(['deepseek', 'openai-codex'])
    expect(views[0].details).toEqual(['Balance: $12.50'])
  })
})
