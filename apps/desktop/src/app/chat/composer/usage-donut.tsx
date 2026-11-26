import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { donutFor, type LimitTone } from '@/app/chat/usage-limits-model'
import { UsageLimitsPanel } from '@/app/chat/usage-limits-panel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $usageLimits, loadUsageLimits } from '@/store/usage-limits'

const R = 6
const C = 2 * Math.PI * R

const TONE_STROKE: Record<LimitTone, string> = {
  ok: 'stroke-emerald-500',
  notice: 'stroke-amber-500',
  warn: 'stroke-destructive'
}

/**
 * A small donut beside the model pill: the arc is how much of the CURRENT provider's tightest
 * window is left, colored green → amber (≤20%) → red (≤10%). Click for every provider's windows,
 * reset times and API-key balances. Draws nothing when the provider reports no limits.
 */
export function UsageDonut({ model, provider: snapshotProvider }: { disabled?: boolean; model?: string; provider: string }) {
  const { t } = useI18n()
  const state = useStore($usageLimits)
  // The model pill falls back to the live session provider when the chat-bar snapshot has none yet;
  // the donut must resolve the same provider or it vanishes exactly when the pill still shows one.
  const viewProvider = useStore(useSessionView().$provider)
  const provider = (snapshotProvider || viewProvider || '').trim()

  useEffect(() => {
    void loadUsageLimits()
  }, [provider])

  const modelHint = /^claude/i.test((model || '').trim()) ? 'anthropic' : ''

  const donut =
    state.status === 'ready' && provider
      ? (donutFor(state.providers, provider) ?? (modelHint ? donutFor(state.providers, modelHint) : null))
      : null

  if (!donut) {
    // Never vanish silently: a failed or empty read shows a muted ring so the control is findable.
    if (!provider || state.status === 'idle' || state.status === 'loading') {
      return null
    }

    const label = `${state.status === 'error' ? t.composer.usageLimitsError : t.composer.usageLimitsNone} (${provider}${model ? ` / ${model}` : ''})`

    return (
      <DropdownMenu>
        <Tip label={label} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`${t.composer.usageLimits}: ${label}`}
              className="size-(--composer-control-size) shrink-0 rounded-md p-0 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)"
              data-testid="usage-donut-empty"
              type="button"
              variant="ghost"
            >
              <svg aria-hidden className="size-4" viewBox="0 0 16 16">
                <circle className="stroke-current opacity-60" cx="8" cy="8" fill="none" r={R} strokeDasharray="2 2" strokeWidth="2" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="max-h-[70vh] w-72 overflow-y-auto p-2.5 text-xs" side="top" sideOffset={8}>
          <UsageLimitsPanel />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const arc = donut.fraction === null ? C : C * donut.fraction

  return (
    <DropdownMenu>
      <Tip label={donut.label} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${t.composer.usageLimits}: ${donut.label}`}
            className="size-(--composer-control-size) shrink-0 rounded-md p-0 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)"
            data-testid="usage-donut"
            type="button"
            variant="ghost"
          >
            <svg aria-hidden className="size-4 -rotate-90" viewBox="0 0 16 16">
              <circle className="stroke-current opacity-20" cx="8" cy="8" fill="none" r={R} strokeWidth="2.5" />
              <circle
                className={cn('transition-[stroke-dasharray]', TONE_STROKE[donut.tone])}
                cx="8"
                cy="8"
                fill="none"
                r={R}
                strokeDasharray={`${arc} ${C}`}
                strokeLinecap="round"
                strokeWidth="2.5"
              />
            </svg>
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-72 overflow-y-auto p-2.5 text-xs" side="top" sideOffset={8}>
        <UsageLimitsPanel />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
