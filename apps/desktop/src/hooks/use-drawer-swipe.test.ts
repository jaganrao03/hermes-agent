import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { $narrowOverlayPaneIds } from '@/components/pane-shell/narrow-overlay-state'
import { $narrowViewport } from '@/components/pane-shell/tree/store'

import { useDrawerSwipe } from './use-drawer-swipe'

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
function touch(type: 'touchstart' | 'touchend', x: number, y: number, target: EventTarget = document.body): void {
  const event = new Event(type, { bubbles: true })
  const point = { clientX: x, clientY: y }
  const list = [point]

  Object.defineProperties(event, {
    touches: { value: type === 'touchstart' ? list : [] },
    changedTouches: { value: type === 'touchstart' ? [] : list }
  })

  target.dispatchEvent(event)
}

function drag(from: [number, number], to: [number, number], target: EventTarget = document.body): void {
  touch('touchstart', ...from, target)
  touch('touchend', ...to, target)
}

function capture(): { seen: ReturnType<typeof vi.fn>; stop: () => void } {
  const seen = vi.fn()
  window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)

  return { seen, stop: () => window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen) }
}

describe('useDrawerSwipe', () => {
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
    document.body.innerHTML = ''
  })

  it('opens the drawer from the middle of the conversation', () => {
    // The left edge is Android's back gesture; the middle is the only free zone.
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([180, 420], [280, 424])

    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'sessions', mode: 'open' })
    stop()
  })

  it('opens the drawer from blank space low on the page', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([300, 700], [420, 706])

    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('ignores a mostly vertical drag, so scrolling never opens the drawer', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([200, 300], [240, 470])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('ignores a short nudge so a sloppy tap stays a tap', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([200, 300], [230, 302])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('leaves the composer its own drag', () => {
    const composer = document.createElement('div')
    composer.dataset.slot = 'composer-root'
    document.body.appendChild(composer)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([200, 600], [320, 604], composer)

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('leaves a sideways-scrolling code block its own drag', () => {
    const pre = document.createElement('pre')
    Object.defineProperty(pre, 'scrollWidth', { value: 900 })
    Object.defineProperty(pre, 'clientWidth', { value: 320 })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ overflowX: 'auto' } as CSSStyleDeclaration)
    document.body.appendChild(pre)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([200, 300], [320, 304], pre)

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('flicks the open drawer away to the left', () => {
    const { seen, stop } = capture()
    $narrowOverlayPaneIds.set(new Set(['sessions', 'chat-sidebar']))
    renderHook(() => useDrawerSwipe())

    drag([280, 500], [180, 505])

    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'sessions', mode: 'close' })
    stop()
  })

  it('does not re-open a drawer that is already out', () => {
    const { seen, stop } = capture()
    $narrowOverlayPaneIds.set(new Set(['sessions']))
    renderHook(() => useDrawerSwipe())

    drag([120, 500], [240, 504])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('does nothing on a fine pointer', () => {
    withCoarsePointer(false)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([180, 420], [300, 424])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('does nothing while the layout is wide', () => {
    $narrowViewport.set(false)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([180, 420], [300, 424])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })
})
