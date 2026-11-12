import { useEffect } from 'react'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $narrowOverlayPaneIds } from '@/components/pane-shell/narrow-overlay-state'
import { $narrowViewport } from '@/components/pane-shell/tree/store'

/** How far a drag must travel before it fires, so a wobble does not open a pane. */
const OPEN_PX = 56
const CLOSE_PX = 64
/** Horizontal drags are only gestures when they clearly outrun the vertical. */
const AXIS_RATIO = 1.4

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
 * the composer, a field, a code block, a table that scrolls, or a chat canvas
 * that pans. Opening the drawer out of those would fight the control.
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

function dispatchReveal(id: string, mode: 'close' | 'open'): void {
  window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode } }))
}

/**
 * Phone drawer gestures for the narrow layout.
 *
 * On a phone the session sidebar leaves the grid and becomes an overlay. This
 * adds the two gestures every app of this shape has: drag the conversation to
 * the right to bring the drawer out, drag it back to the left to dismiss it.
 *
 * Deliberately blind about where the drag starts. Android's back gesture owns
 * the left edge, so an edge-only trigger is the one zone the system steals —
 * opening from the middle of the transcript is what actually works on a phone.
 *
 * Guards, because a swipe shares the surface with scrolling and selection:
 * - only on a coarse pointer and only while the layout is narrow;
 * - the drag must be horizontal by `AXIS_RATIO`, so a scrolling thumb never
 *   opens the drawer, and a tap never counts (56px of travel);
 * - a drag that starts in the composer, a field, a code block or anything that
 *   scrolls sideways is that control's own gesture, not the drawer's;
 * - it dispatches the app's existing pane-reveal event rather than owning any
 *   state, which keeps Escape, the titlebar Hide, and ⌘B in charge of the same
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

    const onTouchStart = (event: TouchEvent) => {
      if (!$narrowViewport.get() || event.touches.length !== 1) {
        tracking = false

        return
      }

      const touch = event.touches[0]

      startX = touch.clientX
      startY = touch.clientY
      // The drawer's own content is a legitimate place to start a dismiss
      // flick; the conversation opens it only from its own canvas.
      tracking = $narrowOverlayPaneIds.get().size > 0 || !ownsHorizontalDrag(event.target)
    }

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) {
        return
      }

      tracking = false

      const touch = event.changedTouches[0]

      if (!touch) {
        return
      }

      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
        return
      }

      if ($narrowOverlayPaneIds.get().size > 0) {
        if (dx <= -CLOSE_PX) {
          dispatchReveal(SIDEBAR_PANE_ID, 'close')
        }

        return
      }

      if (dx >= OPEN_PX) {
        dispatchReveal(SIDEBAR_PANE_ID, 'open')
      }
    }

    const cancel = () => {
      tracking = false
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', cancel, { passive: true })

    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', cancel)
    }
  }, [])
}
