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
function touch(
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
  target: EventTarget = document.body
): void {
  const event = new Event(type, { bubbles: true })
  const point = { clientX: x, clientY: y }
  const list = [point]

  Object.defineProperties(event, {
    touches: { value: type === 'touchend' ? [] : list },
    changedTouches: { value: type === 'touchend' ? list : [] }
  })

  target.dispatchEvent(event)
}

/** A whole gesture: press, carry the thumb along a path, lift at the last point. */
function drag(path: Array<[number, number]>, target: EventTarget = document.body): void {
  touch('touchstart', ...path[0], target)

  for (const point of path.slice(1, -1)) {
    touch('touchmove', ...point)
  }

  touch('touchend', ...path[path.length - 1])
}

function progress(): string | null {
  return document.documentElement.style.getPropertyValue('--drawer-drag') || null
}

function capture(): { seen: ReturnType<typeof vi.fn>; stop: () => void } {
  const seen = vi.fn()
  window.addEventListener(PANE_TOGGLE_REVEAL_EVENT, seen)

  return { seen, stop: () => window.removeEventListener(PANE_TOGGLE_REVEAL_EVENT, seen) }
}

const detailOf = (seen: ReturnType<typeof vi.fn>, index = 0) => (seen.mock.calls[index][0] as CustomEvent).detail

describe('useDrawerSwipe', () => {
  beforeEach(() => {
    withCoarsePointer(true)
    $narrowViewport.set(true)
    $narrowOverlayPaneIds.set(new Set())
    document.documentElement.removeAttribute('data-drawer-drag')
    document.documentElement.style.removeProperty('--drawer-drag')
  })

  afterEach(() => {
    vi.useRealTimers()
    window.matchMedia = realMatchMedia
    $narrowViewport.set(false)
    $narrowOverlayPaneIds.set(new Set())
    document.documentElement.removeAttribute('data-drawer-drag')
    document.documentElement.style.removeProperty('--drawer-drag')
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('reveals the drawer as soon as the thumb heads right, so it can follow', () => {
    // The left edge is Android's back gesture; the middle is the only free zone.
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[180, 420], [220, 424], [280, 428]])

    expect(detailOf(seen)).toEqual({ id: 'sessions', mode: 'open' })
    stop()
  })

  it('tracks the thumb and settles open past the commit distance', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    touch('touchstart', 180, 420)
    touch('touchmove', 220, 422)

    // Carried 40px of the 260px that means a full reveal: the panel is a sixth
    // of the way out, not waiting for release.
    expect(progress()).toBe('0.154')
    expect(seen).toHaveBeenCalledTimes(1)

    touch('touchend', 260, 424)

    expect(progress()).toBeNull()
    expect(document.documentElement.hasAttribute('data-drawer-drag')).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('slides the panel back and closes when the thumb gives up', () => {
    vi.useFakeTimers()
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[180, 420], [196, 421], [200, 422]])

    expect(detailOf(seen)).toEqual({ id: 'sessions', mode: 'open' })
    expect(progress()).toBe('0.000')

    vi.advanceTimersByTime(220)

    expect(detailOf(seen, 1)).toEqual({ id: 'sessions', mode: 'close' })
    expect(progress()).toBeNull()
    stop()
  })

  it('ignores a mostly vertical drag, so scrolling never opens the drawer', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[200, 300], [230, 340], [240, 470]])

    expect(seen).not.toHaveBeenCalled()
    expect(progress()).toBeNull()
    stop()
  })

  it('ignores a short nudge so a sloppy tap stays a tap', () => {
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[200, 300], [206, 301], [208, 302]])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('leaves the composer its own drag', () => {
    const composer = document.createElement('div')
    composer.dataset.slot = 'composer-root'
    document.body.appendChild(composer)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[200, 600], [260, 602], [320, 604]], composer)

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

    drag([[200, 300], [260, 302], [320, 304]], pre)

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('carries an open drawer away to the left and dismisses it', () => {
    vi.useFakeTimers()
    const { seen, stop } = capture()
    $narrowOverlayPaneIds.set(new Set(['sessions', 'chat-sidebar']))
    renderHook(() => useDrawerSwipe())

    touch('touchstart', 280, 500)
    touch('touchmove', 210, 502)

    // Dragged back left from fully open: the panel is already three quarters
    // of the way out under the thumb.
    expect(progress()).toBe('0.731')
    expect(seen).not.toHaveBeenCalled()

    touch('touchend', 200, 503)
    vi.advanceTimersByTime(220)

    expect(detailOf(seen)).toEqual({ id: 'sessions', mode: 'close' })
    stop()
  })

  it('snaps an open drawer back when the thumb barely moves', () => {
    const { seen, stop } = capture()
    $narrowOverlayPaneIds.set(new Set(['sessions']))
    renderHook(() => useDrawerSwipe())

    drag([[280, 500], [250, 502], [240, 503]])

    expect(seen).not.toHaveBeenCalled()
    expect(progress()).toBeNull()
    stop()
  })

  it('does not re-reveal a drawer that is already out', () => {
    const { seen, stop } = capture()
    $narrowOverlayPaneIds.set(new Set(['sessions']))
    renderHook(() => useDrawerSwipe())

    drag([[120, 500], [180, 502], [240, 504]])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('does nothing on a fine pointer', () => {
    withCoarsePointer(false)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[180, 420], [240, 422], [300, 424]])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it('does nothing while the layout is wide', () => {
    $narrowViewport.set(false)
    const { seen, stop } = capture()
    renderHook(() => useDrawerSwipe())

    drag([[180, 420], [240, 422], [300, 424]])

    expect(seen).not.toHaveBeenCalled()
    stop()
  })
})
