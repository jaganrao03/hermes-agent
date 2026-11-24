import { capabilityScoped, type ProfileScope } from './client'

/** One plan window (5h / weekly / monthly...). `remaining_percent` is what is LEFT. */
export interface UsageLimitWindow {
  label: string
  used_percent: null | number
  remaining_percent: null | number
  resets_at: null | string
  detail: null | string
  scope: string
}

export interface UsageLimitProvider {
  provider: string
  name: string
  title: null | string
  plan: null | string
  source: null | string
  fetched_at: null | string
  windows: UsageLimitWindow[]
  /** Display text, e.g. `Balance: $12.50 • $12.50 topped up`. */
  details: string[]
  unavailable_reason: null | string
  state: 'ready' | 'unavailable'
}

export interface UsageLimitsResponse {
  providers: UsageLimitProvider[]
}

export function getUsageLimits(opts?: { refresh?: boolean }, profile?: ProfileScope): Promise<UsageLimitsResponse> {
  return window.hermesDesktop.api<UsageLimitsResponse>({
    ...capabilityScoped(profile),
    path: opts?.refresh ? '/api/usage/limits?refresh=1' : '/api/usage/limits'
  })
}
