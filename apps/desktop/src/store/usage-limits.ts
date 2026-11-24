import { atom } from 'nanostores'

import { getUsageLimits, type UsageLimitProvider } from '@/api/usage-limits'

export type UsageLimitsState =
  | { status: 'error' }
  | { status: 'idle' }
  | { status: 'loading' }
  | { providers: UsageLimitProvider[]; status: 'ready' }

// The backend caches for 60 s; matching it here means the donut and the popover share one fetch
// instead of each mount asking again.
const STALE_MS = 60_000

export const $usageLimits = atom<UsageLimitsState>({ status: 'idle' })

let fetchedAt = 0
let inflight: null | Promise<void> = null

/** Load limits unless a fresh copy is held. `refresh` bypasses both caches (the refresh button). */
export function loadUsageLimits({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
  if (inflight) {
    return inflight
  }

  if (!refresh && fetchedAt && Date.now() - fetchedAt < STALE_MS) {
    return Promise.resolve()
  }

  // Keep showing the last good data while refreshing; only a first load shows "loading".
  if ($usageLimits.get().status !== 'ready') {
    $usageLimits.set({ status: 'loading' })
  }

  // Deferred so a missing bridge (tests, a half-loaded shell) is a rejected fetch, not a throw.
  inflight = Promise.resolve()
    .then(() => getUsageLimits({ refresh }))
    .then(res => {
      fetchedAt = Date.now()
      $usageLimits.set({ providers: res.providers, status: 'ready' })
    })
    .catch(() => {
      if ($usageLimits.get().status !== 'ready') {
        $usageLimits.set({ status: 'error' })
      }
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** Test seam. */
export function resetUsageLimits(): void {
  fetchedAt = 0
  inflight = null
  $usageLimits.set({ status: 'idle' })
}
