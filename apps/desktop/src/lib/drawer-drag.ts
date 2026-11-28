/**
 * Live progress of the phone drawer drag (0 = closed, 1 = open), written to the
 * drawer elements themselves.
 *
 * It used to live on `:root`. A custom property inherits, so every touchmove
 * then restyled every node under the document — and the sidebar is part of that
 * tree, so the cost grew with the session list. Measured on the e2e sandbox at
 * 4x CPU with 1,600 sessions: 77-105 ms of style recalc per frame from `:root`,
 * 35 ms from the overlay (the var still inherits into its rows), ~2 ms once the
 * property is also registered `inherits: false` (styles.css). A drag has to fit
 * in 16 ms, so only the last one tracks the finger.
 *
 * The overlay mounts a render AFTER the gesture starts, so the latest progress is
 * kept here and applied when an element binds — before its first paint, so it
 * never flashes fully open under the thumb.
 */
const DRAG_VAR = '--drawer-drag'
const DRAG_ATTR = 'data-drawer-drag'

const targets = new Set<HTMLElement>()
let current: string | null = null

/** Publish the thumb's progress to every bound drawer. */
export function publishDrawerDrag(progress: number): void {
  current = progress.toFixed(3)

  const root = document.documentElement

  // Once per gesture: it switches the settle transition off, and re-setting an
  // attribute to the same value still costs an invalidation.
  if (!root.hasAttribute(DRAG_ATTR)) {
    root.setAttribute(DRAG_ATTR, '')
  }

  for (const el of targets) {
    el.style.setProperty(DRAG_VAR, current)
  }
}

/** Drop the progress so the drawer settles at rest, animated by its transition. */
export function releaseDrawerDrag(): void {
  current = null
  document.documentElement.removeAttribute(DRAG_ATTR)

  for (const el of targets) {
    el.style.removeProperty(DRAG_VAR)
  }
}

/** Bind a mounted drawer element; returns the unbind. A drag already in flight is applied at once. */
export function bindDrawerDragTarget(el: HTMLElement | null): () => void {
  if (!el) {
    return () => {}
  }

  targets.add(el)

  if (current !== null) {
    el.style.setProperty(DRAG_VAR, current)
  }

  return () => {
    targets.delete(el)
    el.style.removeProperty(DRAG_VAR)
  }
}

/** The progress currently published, or null at rest. */
export function drawerDragProgress(): string | null {
  return current
}
