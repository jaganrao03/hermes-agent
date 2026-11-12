import { afterEach, describe, expect, it } from 'vitest'

import { currentThemeColor, syncThemeColor } from './mobile-chrome'

const meta = () => document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach(node => node.remove())
})

describe('syncThemeColor', () => {
  it('rewrites the boot constant to the painted chrome colour', () => {
    const boot = document.createElement('meta')
    boot.name = 'theme-color'
    boot.content = '#0a0a0a'
    document.head.appendChild(boot)

    syncThemeColor('#f7f7f7')

    // A light theme under the dark boot constant is the bug this fixes.
    expect(meta()?.content).toBe('#f7f7f7')
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
    expect(currentThemeColor()).toBe('#f7f7f7')
  })

  it('creates the meta when the document ships without one', () => {
    expect(meta()).toBeNull()

    syncThemeColor('#111111')

    expect(meta()?.content).toBe('#111111')
  })

  it('ignores an empty colour rather than painting the status bar blank', () => {
    syncThemeColor('#123456')
    syncThemeColor('')

    expect(meta()?.content).toBe('#123456')
  })
})
