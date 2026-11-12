import { useEffect } from 'react'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $narrowOverlayPaneIds } from '@/components/pane-shell/narrow-overlay-state'
import { $narrowViewport } from '@/components/pane-shell/tree/store'

/** Travel that proves the thumb is dragging, not just landing. */
const INTENT_PX = 12
/** Travel that commits the drawer open (or dismissed) when the thumb lifts. */
const OPEN_PX = 56
const CLOSE_PX = 64
/** Horizontal drags are only gestures when they clearly outrun the vertical. */
const AXIS_RATIO = 1.4
/** Thumb travel that maps to a full reveal, so the panel tracks the finger. */
const TRAVEL_PX = 260
/** Must outlast the settle transition in styles.css. */
const SETTLE_MS = 200

const DRAG_VAR = '--drawer-drag'
const DRAG_ATTR = 'data-drawer-drag'

/** The pane a rightward pull reveals: the session sidebar's real id. */
const SIDEBAR_PANE_ID = 'sessions'

/** Elements whose own horizontal drag belongs to them, not to the drawer. */
const OWN_GESTURE = "input, textarea, select, pre, [contenteditable='true'], [data-slot='composer-root']"

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
}

function scrollsSideways(element: Element): boolean {
  if (element.scrollWidth <= element.clientWidth + 4) {
    return false
  }

  const overflow = getComputedStyle(element).overflowX

  return overflow === 'auto' || overflow === 'scroll'
}

/**
 * True when the drag started somewhere that consumes horizontal movement itself:
 * the composer, a field, a code block, or a table that scrolls. Opening the
 * drawer out of those would fight the control.
 */
function ownsHorizontalDrag(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null

  while (node && node !== document.body) {
    if (node.matches(OWN_GESTURE) || scrollsSideways(node)) {
      return true
    }

    node = node.parentElement
  }

  return false
}

function dispatchReveal(mode: 'close' | 'open'): void {
  window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id: SIDEBAR_PANE_ID, mode } }))
}

/** Publish the drag's progress so the panel can sit under the thumb. */
function setProgress(progress: number): void {
  document.documentElement.setAttribute(DRAG_ATTR, '')
  document.documentElement.style.setProperty(DRAG_VAR, progress.toFixed(3))
}

/** Drop the progress so the panel settles at rest, animated by its transition. */
function releaseProgress(): void {
  document.documentElement.removeAttribute(DRAG_ATTR)
  document.documentElement.style.removeProperty(DRAG_VAR)
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Phone drawer gestures for the narrow layout.
 *
 * On a phone the session sidebar leaves the grid and becomes an overlay. This
 * adds the two gestures every app of this shape has: pull the conversation to
 * the right to bring the drawer out, flick it back to the left to dismiss it.
 *
 * The panel follows the thumb instead of snapping open on release: progress is
 * published as `--drawer-drag` on the document — never as React state, so a
 * drag costs no renders — and styles.css turns it into a transform. When the
 * thumb lifts the same progress decides where it settles, and the browser
 * animates the rest on the compositor.
 *
 * Deliberately blind about where the drag starts. Android's back gesture owns
 * the left edge, so an edge-only trigger is the one zone the system steals —
 * opening from the middle of the transcript is what actually works on a phone.
 *
 * Guards, because a swipe shares the surface with scrolling and selection:
 * - only on a coarse pointer and only while the layout is narrow;
 * - the drag must be horizontal by `AXIS_RATIO`, so a scrolling thumb never
 *   opens the drawer, and a tap never counts (`INTENT_PX`, then `OPEN_PX`);
 * - a drag that starts in the composer, a field, a code block or anything that
 *   scrolls sideways is that control's own gesture, not the drawer's;
 * - it dispatches the app's existing pane-reveal event rather than owning any
 *   state, which keeps Escape, the titlebar Hide and ⌘B in charge of the same
 *   overlay.
 */
export function useDrawerSwipe(): void {
  useEffect(() => {
    if (!isCoarsePointer()) {
      return
    }

    let startX = 0
    let startY = 0
    let tracking = false
    let dragging = false
    let mode: 'close' | 'open' = 'open'
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const clearSettle = () => {
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer)
        settleTimer = undefined
      }
    }

    const onTouchStart = (event: TouchEvent) => {
      clearSettle()

      if (!$narrowViewport.get() || event.touches.length !== 1) {
        tracking = false

        return
      }

      const touch = event.touches[0]

      startX = touch.clientX
      startY = touch.clientY
      dragging = false

      const open = $narrowOverlayPaneIds.get().size > 0

      mode = open ? 'close' : 'open'
      // A drawer already on screen is dismissed from anywhere on it; the
      // conversation opens it only from its own canvas.
      tracking = open || !ownsHorizontalDrag(event.target)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) {
        return
      }

      const touch = event.touches[0]

      if (!touch) {
        return
      }

      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      if (!dragging) {
        if (Math.abs(dx) < INTENT_PX || Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
          return
        }

        dragging = true

        if (mode === 'open' && dx > 0) {
          // Mount the panel now so it can be carried by the thumb; on this
          // frame the progress below puts it just off the edge.
          dispatchReveal('open')
        }
      }

      setProgress(mode === 'open' ? clamp01(dx / TRAVEL_PX) : clamp01(1 + dx / TRAVEL_PX))
    }

    const settleClosed = () => {
      setProgress(0)
      settleTimer = setTimeout(() => {
        dispatchReveal('close')
        releaseProgress()
      }, SETTLE_MS)
    }

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) {
        return
      }

      tracking = false

      if (!dragging) {
        return
      }

      dragging = false

      const touch = event.changedTouches[0]

      if (!touch) {
        releaseProgress()

        return
      }

      const dx = touch.clientX - startX

      if (mode === 'open') {
        if (dx >= OPEN_PX) {
          releaseProgress()

          return
        }

        settleClosed()

        return
      }

      if (dx <= -CLOSE_PX) {
        settleClosed()

        return
      }

      // Not far enough to dismiss: snap back under the thumb.
      releaseProgress()
    }

    const cancel = () => {
      tracking = false
      dragging = false
      releaseProgress()
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', cancel, { passive: true })

    return () => {
      clearSettle()
      releaseProgress()
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', cancel)
    }
  }, [])
}
