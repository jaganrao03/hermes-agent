import { useEffect } from 'react'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $narrowOverlayPaneIds } from '@/components/pane-shell/narrow-overlay-state'
import { $narrowViewport } from '@/components/pane-shell/tree/store'

/** How close to the left edge a drag must start to count as "pull the drawer". */
const EDGE_PX = 28
/** How far it must travel before it fires, so a wobble does not open a pane. */
const OPEN_PX = 56
const CLOSE_PX = 64
/** Horizontal drags are only gestures when they clearly outrun the vertical. */
const AXIS_RATIO = 1.4

/** The pane a left-edge pull reveals: the session sidebar's real id. */
const SIDEBAR_PANE_ID = 'sessions'

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
}

function dispatchReveal(id: string, mode: 'close' | 'open'): void {
  window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode } }))
}

/**
 * Phone drawer gestures for the narrow layout.
 *
 * On a phone the session sidebar leaves the grid and becomes an edge overlay.
 * Reaching its tab in the strip is a stretch for a thumb, so this adds the two
 * gestures every phone app of this shape has: pull from the left edge to bring
 * the drawer out, flick it back to the left to dismiss it.
 *
 * Deliberately narrow in scope:
 * - only on a coarse pointer and only while the layout is narrow, so a mouse
 *   and a wide window keep the tab strip as the single way in;
 * - a drag must be horizontal by `AXIS_RATIO` before it counts, so scrolling
 *   the transcript with a slightly diagonal thumb never opens the drawer;
 * - it dispatches the app's existing pane-reveal event rather than owning any
 *   state, which keeps Escape, the titlebar Hide, and ⌘B in charge of the same
 *   overlay.
 */
export function useNarrowEdgeSwipe(): void {
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
      // flick; a closed drawer can only be pulled from the edge itself.
      const drawerOpen = $narrowOverlayPaneIds.get().size > 0
      tracking = drawerOpen || startX <= EDGE_PX
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

      const drawerOpen = $narrowOverlayPaneIds.get().size > 0

      if (drawerOpen) {
        if (dx <= -CLOSE_PX) {
          dispatchReveal(SIDEBAR_PANE_ID, 'close')
        }

        return
      }

      if (dx >= OPEN_PX && startX <= EDGE_PX) {
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
