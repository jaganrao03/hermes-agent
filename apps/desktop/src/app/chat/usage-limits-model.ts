import type { UsageLimitProvider, UsageLimitWindow } from '@/api/usage-limits'
import { formatReset, USAGE_NOTICE_PERCENT, USAGE_WARN_PERCENT } from '@/lib/provider-limit'

export type LimitTone = 'ok' | 'notice' | 'warn'

export interface LimitRowView {
  label: string
  /** 0–1 fraction REMAINING, for the bar. */
  fraction: number
  /** `70% left`. */
  remainingText: string
  /** `resets 4:30 PM`, or null when the provider gave no reset time. */
  resetText: null | string
  tone: LimitTone
}

export interface ProviderLimitsView {
  provider: string
  name: string
  plan: null | string
  rows: LimitRowView[]
  /** Dollar balances and other free-text lines, verbatim from the provider. */
  details: string[]
  unavailableReason: null | string
}

export function limitTone(remainingPercent: number): LimitTone {
  if (remainingPercent <= USAGE_WARN_PERCENT) {
    return 'warn'
  }

  return remainingPercent <= USAGE_NOTICE_PERCENT ? 'notice' : 'ok'
}

function rowView(window: UsageLimitWindow, nowMs: number): LimitRowView | null {
  if (window.remaining_percent === null || !Number.isFinite(window.remaining_percent)) {
    return null
  }

  const remaining = Math.min(100, Math.max(0, window.remaining_percent))
  const resetMs = window.resets_at ? Date.parse(window.resets_at) : Number.NaN
  const reset = Number.isFinite(resetMs) && resetMs > nowMs ? formatReset(resetMs, nowMs) : null

  return {
    label: window.label,
    fraction: remaining / 100,
    remainingText: `${Math.round(remaining)}% left`,
    resetText: reset ? `resets ${reset}` : null,
    tone: limitTone(remaining)
  }
}

/** Tightest window first — the one you will hit first leads the list. */
export function toProviderLimitsView(provider: UsageLimitProvider, nowMs = Date.now()): ProviderLimitsView {
  const rows = provider.windows
    .map(window => rowView(window, nowMs))
    .filter((row): row is LimitRowView => row !== null)
    .sort((a, b) => a.fraction - b.fraction)

  return {
    provider: provider.provider,
    name: provider.name,
    plan: provider.plan,
    rows,
    details: provider.details,
    unavailableReason: provider.state === 'unavailable' ? provider.unavailable_reason : null
  }
}

/** Providers worth a section: anything with a bar or a balance line. Unreadable ones are dropped
 *  from the list rather than shown as noise; the caller decides how to report "none readable". */
export function visibleLimitProviders(providers: readonly UsageLimitProvider[], nowMs = Date.now()): ProviderLimitsView[] {
  return providers
    .map(provider => toProviderLimitsView(provider, nowMs))
    .filter(view => view.rows.length > 0 || view.details.length > 0)
}
