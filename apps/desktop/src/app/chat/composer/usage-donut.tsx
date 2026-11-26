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

  if (!provider) {
    return null
  }

  // ONE tree for every state: swapping between two trees remounts the menu while it is open
  // (usage arrives after the click), which drops its anchor and opens it away from the ring.
  const base =
    state.status === 'error'
      ? t.composer.usageLimitsError
      : state.status === 'idle' || state.status === 'loading'
        ? t.composer.usageLimitsLoading
        : t.composer.usageLimitsNone

  const label = donut ? donut.label : `${base} (${provider}${model ? ` / ${model}` : ''})`
  const arc = !donut || donut.fraction === null ? C : C * donut.fraction

  return (
    <DropdownMenu>
      <Tip label={label} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${t.composer.usageLimits}: ${label}`}
            className="size-(--composer-control-size) shrink-0 rounded-md p-0 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)"
            data-testid={donut ? 'usage-donut' : 'usage-donut-empty'}
            type="button"
            variant="ghost"
          >
            <svg aria-hidden className="size-4 -rotate-90" viewBox="0 0 16 16">
              <circle className="stroke-current opacity-20" cx="8" cy="8" fill="none" r={R} strokeWidth="2.5" />
              <circle
                className={cn('transition-[stroke-dasharray]', donut ? TONE_STROKE[donut.tone] : 'stroke-current opacity-60')}
                cx="8"
                cy="8"
                fill="none"
                r={R}
                strokeDasharray={donut ? `${arc} ${C}` : '2 2'}
                strokeLinecap={donut ? 'round' : 'butt'}
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
