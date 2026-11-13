import { describe, expect, it, vi } from 'vitest'

function freshStore() {
  vi.resetModules()

  return import('./session-multi-select')
}

describe('session-multi-select', () => {
  it('starts empty', async () => {
    const m = await freshStore()
    expect(m.hasSessionMultiSelect()).toBe(false)
    expect(m.getSessionMultiSelectIds()).toEqual([])
    expect(m.$sessionMultiSelectMode.get()).toBe(false)
  })

  it('toggles a single session in', async () => {
    const m = await freshStore()
    m.toggleSessionMultiSelect('s1')
    expect(m.hasSessionMultiSelect()).toBe(true)
    expect(m.getSessionMultiSelectIds()).toEqual(['s1'])
    expect(m.$sessionMultiSelectMode.get()).toBe(true)
  })

  it('toggles the same session out', async () => {
    const m = await freshStore()
    m.toggleSessionMultiSelect('s1')
    m.toggleSessionMultiSelect('s1')
    expect(m.hasSessionMultiSelect()).toBe(false)
    expect(m.getSessionMultiSelectIds()).toEqual([])
    expect(m.$sessionMultiSelectMode.get()).toBe(false)
  })

  it('selects many sessions', async () => {
    const m = await freshStore()
    m.setSessionMultiSelectIds(['a', 'b', 'c'])
    expect(m.getSessionMultiSelectIds()).toEqual(['a', 'b', 'c'])
  })

  it('clears the selection', async () => {
    const m = await freshStore()
    m.toggleSessionMultiSelect('s1')
    m.clearSessionMultiSelect()
    expect(m.hasSessionMultiSelect()).toBe(false)
    expect(m.$sessionMultiSelectMode.get()).toBe(false)
  })

  it('mode flag reflects selection state', async () => {
    const m = await freshStore()
    m.toggleSessionMultiSelect('a')
    expect(m.$sessionMultiSelectMode.get()).toBe(true)
    m.toggleSessionMultiSelect('b')
    expect(m.$sessionMultiSelectMode.get()).toBe(true)
    m.toggleSessionMultiSelect('b')
    expect(m.$sessionMultiSelectMode.get()).toBe(true)
    m.toggleSessionMultiSelect('a')
    expect(m.$sessionMultiSelectMode.get()).toBe(false)
  })
})
