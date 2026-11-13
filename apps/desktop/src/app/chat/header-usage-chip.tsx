import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { Zap } from '@/lib/icons'
import { isOffPeak, providerOfModel } from '@/lib/provider-offpeak'
import { cn } from '@/lib/utils'
import { $sessions } from '@/store/session'
import { sessionCostUsd } from '@/store/sidebar-archive'
import type { SessionInfo } from '@/types/hermes'

/** Local midnight of `now`, in epoch seconds — the same clock the rows use. */
function startOfTodaySeconds(now: Date = new Date()): number {
  const midnight = new Date(now)

  midnight.setHours(0, 0, 0, 0)

  return Math.floor(midnight.getTime() / 1000)
}

/** Spend across the loaded session page since local midnight. */
export function spendToday(sessions: readonly SessionInfo[], now: Date = new Date()): number {
  const since = startOfTodaySeconds(now)

  return sessions.reduce(
    (total, session) => (session.last_active >= since ? total + sessionCostUsd(session) : total),
    0
  )
}

function usd(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`
}

/**
 * What this conversation has cost, in the title bar — one glanceable number, with
 * the day's total and the provider's discount state one tap away.
 *
 * Stored per-session spend only (the `sessions` row the sidebar already sums), so
 * it moves at turn boundaries, not per token. Renders nothing when the backend
 * quotes no price at all — subscription auth has no dollar figure to show, and a
 * permanent `$0.00` would read as a bug.
 */
export function HeaderUsageChip({ session }: { session: SessionInfo | null }) {
  const { t } = useI18n()
  const c = t.composer
  const sessions = useStore($sessions)

  const sessionCost = session ? sessionCostUsd(session) : 0
  const todayCost = useMemo(() => spendToday(sessions), [sessions])

  if (sessionCost <= 0 && todayCost <= 0) {
    return null
  }

  const discount = isOffPeak(session?.model)
  const provider = providerOfModel(session?.model)
  const headline = sessionCost > 0 ? usd(sessionCost) : usd(todayCost)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={c.usageSession}
          className={cn(
            'pointer-events-auto flex shrink-0 items-center gap-1 rounded-full border border-border/50 px-2 py-0.5 text-[0.68rem] font-medium tabular-nums text-muted-foreground transition-colors hover:border-border hover:text-foreground data-[state=open]:border-border data-[state=open]:text-foreground',
            discount && 'text-(--ui-accent,currentColor)'
          )}
          type="button"
        >
          {discount && <Zap className="size-2.5" />}
          {headline}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2.5 text-xs" sideOffset={8}>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">{c.usageSession}</dt>
          <dd className="text-right font-medium tabular-nums">{usd(sessionCost)}</dd>
          <dt className="text-muted-foreground">{c.usageToday}</dt>
          <dd className="text-right font-medium tabular-nums">{usd(todayCost)}</dd>
        </dl>
        {discount && (
          <p className="mt-2 flex items-center gap-1.5 border-t border-border/50 pt-2 text-[0.68rem] text-muted-foreground">
            <Zap className="size-2.5 shrink-0" />
            {c.usageOffPeak}
            {provider ? ` · ${provider}` : ''}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
