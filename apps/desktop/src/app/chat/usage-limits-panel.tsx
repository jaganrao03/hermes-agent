import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $usageLimits, loadUsageLimits } from '@/store/usage-limits'

import { type LimitTone, visibleLimitProviders } from './usage-limits-model'

const TONE_FILL: Record<LimitTone, string> = {
  ok: 'bg-primary',
  notice: 'bg-amber-500',
  warn: 'bg-destructive'
}

/**
 * Plan windows (how much is left, when it resets) and API-key balances for every signed-in
 * provider. Shares one cached fetch with the composer donut; the refresh button bypasses it.
 */
export function UsageLimitsPanel() {
  const { t } = useI18n()
  const c = t.composer
  const state = useStore($usageLimits)

  useEffect(() => {
    void loadUsageLimits()
  }, [])

  const views = state.status === 'ready' ? visibleLimitProviders(state.providers) : []

  return (
    <section aria-label={c.usageLimits} className="mt-2 border-t border-border/50 pt-2 first:mt-0 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">{c.usageLimits}</h3>
        <button
          aria-label={c.usageLimitsRefresh}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => void loadUsageLimits({ refresh: true })}
          type="button"
        >
          <RefreshCw className={cn('size-3', (state.status === 'loading' || state.status === 'idle') && 'animate-spin')} />
        </button>
      </div>

      {(state.status === 'loading' || state.status === 'idle') && <p className="text-[0.68rem] text-muted-foreground">{c.usageLimitsLoading}</p>}
      {state.status === 'error' && <p className="text-[0.68rem] text-destructive">{c.usageLimitsError}</p>}
      {state.status === 'ready' && views.length === 0 && (
        <p className="text-[0.68rem] text-muted-foreground">{c.usageLimitsNone}</p>
      )}

      <div className="grid gap-2.5">
        {views.map(view => (
          <div className="grid gap-1" key={view.provider}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{view.name}</span>
              {view.plan && <span className="text-[0.62rem] text-muted-foreground">{view.plan}</span>}
            </div>

            {view.rows.map(row => (
              <div className="grid gap-0.5" key={row.label}>
                <div className="flex justify-between gap-2 text-[0.68rem]">
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="tabular-nums">{row.remainingText}</span>
                </div>
                <Progress
                  aria-label={`${view.name} ${row.label}: ${row.remainingText}`}
                  fillClassName={TONE_FILL[row.tone]}
                  size="sm"
                  value={row.fraction}
                />
                {row.resetText && <span className="text-[0.62rem] text-muted-foreground">{row.resetText}</span>}
              </div>
            ))}

            {view.details.map(line => (
              <span className="text-[0.68rem] tabular-nums text-muted-foreground" key={line}>
                {line}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
