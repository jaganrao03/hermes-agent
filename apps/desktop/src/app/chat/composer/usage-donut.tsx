import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useSessionView } from '@/app/chat/session-view'
import { donutFor, type LimitTone } from '@/app/chat/usage-limits-model'
import { UsageLimitsPanel } from '@/app/chat/usage-limits-panel'
import { Button } from '@/components/ui/button'
import { menuSurfaceClass } from '@/components/ui/menu'
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

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // Own the placement instead of leaving it to a popper: the panel sits directly above the ring
  // (8px gap), right edges aligned, clamped inside the viewport.
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect()

    if (!a) {
      return
    }

    const width = panel.current?.offsetWidth || 288
    const left = Math.max(8, Math.min(a.right - width, window.innerWidth - width - 8))

    setPos({ bottom: Math.max(8, window.innerHeight - a.top + 8), left })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)

      return
    }

    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)

    if (panel.current) {
      observer?.observe(panel.current)
    }

    const close = (event: Event) => {
      const target = event.target as Node

      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) {
        setOpen(false)
      }
    }

    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)

    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open, place])

  // The selected MODEL is the truth: the provider string can lag a model switch (it still said
  // codex while Sonnet was selected), so a recognisable model family wins over it.
  const m = (model || '').trim().toLowerCase()

  const modelHint = /^(claude|sonnet|opus|haiku|fable|astra)/.test(m) || m.includes('claude')
    ? 'anthropic'
    : /codex|^gpt-/.test(m)
      ? 'openai-codex'
      : /deepseek/.test(m)
        ? 'deepseek'
        : ''

  const lookup = modelHint || provider

  const donut =
    state.status === 'ready' && lookup
      ? (donutFor(state.providers, lookup) ?? (modelHint ? donutFor(state.providers, provider) : null))
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
    <>
      <Tip label={label} side="top">
        <Button
          aria-expanded={open}
          aria-label={`${t.composer.usageLimits}: ${label}`}
          className="size-(--composer-control-size) shrink-0 rounded-md p-0 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)"
          data-testid={donut ? 'usage-donut' : 'usage-donut-empty'}
          onClick={() => setOpen(v => !v)}
          ref={anchor}
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
      </Tip>
      {open &&
        createPortal(
          <div
            className={cn(menuSurfaceClass, 'fixed z-[200] max-h-[70vh] w-72 overflow-y-auto p-2.5 text-xs')}
            data-testid="usage-popover"
            ref={panel}
            role="dialog"
            style={pos ?? { visibility: 'hidden' }}
          >
            <UsageLimitsPanel />
          </div>,
          document.body
        )}
    </>
  )
}
