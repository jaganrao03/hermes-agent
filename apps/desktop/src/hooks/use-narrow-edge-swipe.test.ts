import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $narrowOverlayPaneIds } from '@/components/pane-shell/narrow-overlay-state'
import { $narrowViewport } from '@/components/pane-shell/tree/store'

import { useNarrowEdgeSwipe } from './use-narrow-edge-swipe'

const realMatchMedia = window.matchMedia

function withCoarsePointer(coarse: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

/** jsdom has no TouchEvent constructor; the hook only reads clientX/clientY. */
function touch(type: 'touchstart' | 'touchend', x: number, y: number): void {
  const event = new Event(type, { bubbles: true })
  const point = { clientX: x, clientY: y }
  const list = [point]

  Object.defineProperties(event, {
    touches: { value: type === 'touchstart' ? list : [] },
    changedTouches: { value: type === 'touchstart' ? [] : list }
  })

  window.dispatchEvent(event)
}

function drag(from: [number, number], to: [number, number]): void {
  touch('touchstart', ...from)
  touch('touchend', ...to)
}

describe('useNarrowEdgeSwipe', () => {
  beforeEach(() => {
    withCoarsePointer(true)
    $narrowViewport.set(true)
    $narrowOverlayPaneIds.set(new Set())
  })

  afterEach(() => {
    window.matchMedia = realMatchMedia
    $narrowViewport.set(false)
    $narrowOverlayPaneIds.set(new Set())
    vi.restoreAllMocks()
  })

  it('opens the session drawer when the drag starts at the left edge', () => {
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    renderHook(() => useNarrowEdgeSwipe())

    drag([6, 400], [96, 406])

    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'sessions', mode: 'open' })
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })

  it('ignores a drag that begins away from the edge', () => {
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    renderHook(() => useNarrowEdgeSwipe())

    drag([200, 400], [300, 402])

    expect(seen).not.toHaveBeenCalled()
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })

  it('ignores a mostly vertical drag, so scrolling never opens the drawer', () => {
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    renderHook(() => useNarrowEdgeSwipe())

    drag([6, 300], [40, 460])

    expect(seen).not.toHaveBeenCalled()
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })

  it('flicks the open drawer away to the left', () => {
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    $narrowOverlayPaneIds.set(new Set(['sessions', 'chat-sidebar']))
    renderHook(() => useNarrowEdgeSwipe())

    drag([280, 500], [180, 505])

    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'sessions', mode: 'close' })
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })

  it('does nothing on a fine pointer', () => {
    withCoarsePointer(false)
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    renderHook(() => useNarrowEdgeSwipe())

    drag([6, 400], [120, 404])

    expect(seen).not.toHaveBeenCalled()
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })

  it('does nothing while the layout is wide', () => {
    $narrowViewport.set(false)
    const seen = vi.fn()
    window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
    renderHook(() => useNarrowEdgeSwipe())

    drag([6, 400], [120, 404])

    expect(seen).not.toHaveBeenCalled()
    window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)
  })
})
