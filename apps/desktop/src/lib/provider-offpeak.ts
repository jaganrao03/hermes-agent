/**
 * Providers that sell a cheaper tier outside a published peak window.
 *
 * DeepSeek (api-docs.deepseek.com/quick_start/pricing): off-peak rates are exactly
 * half of peak; peak is Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, everything
 * else — weekends included — is off-peak. Windows are UTC because that is how the
 * provider states them; local clocks only ever decide whether "now" is inside one.
 *
 * A provider we have no schedule for is never reported off-peak: a discount badge
 * we cannot justify is worse than no badge.
 */
const PEAK_WINDOWS_UTC: Record<string, ReadonlyArray<readonly [number, number]>> = {
  deepseek: [
    [1, 4],
    [6, 10]
  ]
}

/** Provider id from a model id: `deepseek-v4-flash` → `deepseek`, `anthropic/claude` → `anthropic`. */
export function providerOfModel(model: null | string | undefined): null | string {
  if (!model) {
    return null
  }

  const bare = model.trim().toLowerCase().split('/').pop() || ''

  if (!bare) {
    return null
  }

  for (const provider of Object.keys(PEAK_WINDOWS_UTC)) {
    if (bare.startsWith(provider)) {
      return provider
    }
  }

  // Providers whose schedule we know nothing about still answer for the caller
  // that asks "who is this?", without claiming a discount.
  return bare.split('-')[0] || null
}

/** True when `model`'s provider is billing its discounted tier at `now`. */
export function isOffPeak(model: null | string | undefined, now: Date = new Date()): boolean {
  const provider = providerOfModel(model)
  const windows = provider ? PEAK_WINDOWS_UTC[provider] : undefined

  if (!windows) {
    return false
  }

  const day = now.getUTCDay()

  // Saturday and Sunday are off-peak all day, before any window is considered.
  if (day === 0 || day === 6) {
    return true
  }

  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()

  for (const [startHour, endHour] of windows) {
    if (minutes >= startHour * 60 && minutes < endHour * 60) {
      return false
    }
  }

  return true
}
