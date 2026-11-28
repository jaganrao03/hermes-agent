import { afterEach, describe, expect, it } from 'vitest'

import { bindDrawerDragTarget, drawerDragProgress, publishDrawerDrag, releaseDrawerDrag } from './drawer-drag'

const root = document.documentElement
const drawer = () => document.createElement('div')
const value = (el: HTMLElement) => el.style.getPropertyValue('--drawer-drag') || null

afterEach(() => {
  releaseDrawerDrag()
})

describe('drawer drag progress', () => {
  it('writes to bound drawers and never to :root, so a drag does not restyle the page', () => {
    const el = drawer()
    const unbind = bindDrawerDragTarget(el)

    publishDrawerDrag(0.25)

    expect(value(el)).toBe('0.250')
    expect(root.style.getPropertyValue('--drawer-drag')).toBe('')
    unbind()
  })

  it('applies a drag already in flight when a drawer mounts late', () => {
    // The gesture dispatches "open" and publishes in the same handler; React mounts the drawer afterwards.
    publishDrawerDrag(0.4)

    const el = drawer()
    const unbind = bindDrawerDragTarget(el)

    expect(value(el)).toBe('0.400')
    unbind()
  })

  it('marks the document only while a drag is live', () => {
    publishDrawerDrag(0.1)
    expect(root.hasAttribute('data-drawer-drag')).toBe(true)

    releaseDrawerDrag()
    expect(root.hasAttribute('data-drawer-drag')).toBe(false)
  })

  it('does not rewrite the document attribute on every move', () => {
    publishDrawerDrag(0.1)

    let writes = 0

    const watcher = new MutationObserver(records => {
      writes += records.length
    })

    watcher.observe(root, { attributes: true, attributeFilter: ['data-drawer-drag'] })
    publishDrawerDrag(0.2)
    publishDrawerDrag(0.3)

    expect(watcher.takeRecords()).toHaveLength(0)
    expect(writes).toBe(0)
    watcher.disconnect()
  })

  it('clears every drawer and forgets the progress on release', () => {
    const a = drawer()
    const b = drawer()
    const unbindA = bindDrawerDragTarget(a)
    const unbindB = bindDrawerDragTarget(b)

    publishDrawerDrag(0.6)
    releaseDrawerDrag()

    expect(value(a)).toBeNull()
    expect(value(b)).toBeNull()
    expect(drawerDragProgress()).toBeNull()

    // A drawer mounting after release must not inherit the old value.
    const late = drawer()
    const unbindLate = bindDrawerDragTarget(late)

    expect(value(late)).toBeNull()
    unbindA()
    unbindB()
    unbindLate()
  })

  it('stops writing to a drawer once it unbinds', () => {
    const el = drawer()
    const unbind = bindDrawerDragTarget(el)

    publishDrawerDrag(0.5)
    unbind()
    publishDrawerDrag(0.9)

    expect(value(el)).toBeNull()
  })

  it('ignores a null target', () => {
    expect(() => bindDrawerDragTarget(null)()).not.toThrow()
  })
})
