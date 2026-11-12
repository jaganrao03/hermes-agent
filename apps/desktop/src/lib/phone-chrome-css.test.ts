import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The phone rules live in plain CSS, which no unit test executes, so a cleanup
 * pass can delete a notch inset or the only reachable Archive affordance and
 * nothing goes red. These read the two files that carry the contract.
 */
function read(...segments: string[]): string {
  // vitest runs with the package as cwd, but a root-level run does not.
  for (const base of [process.cwd(), resolve(process.cwd(), 'apps/desktop')]) {
    const file = resolve(base, ...segments)

    if (existsSync(file)) {
      return readFileSync(file, 'utf8')
    }
  }

  throw new Error(`not found from ${dirname(process.cwd())}: ${segments.join('/')}`)
}

const phoneCss = read('src', 'styles.css')
const bootHtml = read('index.html')

describe('phone chrome', () => {
  it('lets the page paint under a notch and insets itself again', () => {
    expect(bootHtml).toContain('viewport-fit=cover')
    expect(phoneCss).toContain('env(safe-area-inset-bottom')
    expect(phoneCss).toContain("[data-slot='composer-dock']")
  })

  it('kills the tap flash and keeps overscroll inside the app', () => {
    expect(phoneCss).toContain('-webkit-tap-highlight-color: transparent')
    expect(phoneCss).toContain('overscroll-behavior-y: none')
  })

  it('leaves the session actions visible and thumb-sized without hover', () => {
    expect(phoneCss).toMatch(/\[data-session-actions\]\s*\{[^}]*width: 2\.25rem/)
  })

  it('moves the narrow drawer with a transform, never with layout', () => {
    // Animating left/width would relayout the transcript on every frame — the
    // thing that made the drawer feel like it snapped.
    expect(phoneCss).toMatch(/\[data-narrow-overlay\]\[data-narrow-overlay-side='left'\]\s*\{[^}]*translate3d/)
    expect(phoneCss).toMatch(/\[data-narrow-overlay\]\[data-narrow-overlay-side='right'\]\s*\{[^}]*translate3d/)
    expect(phoneCss).toContain('--drawer-drag')
    expect(phoneCss).toContain(':root:not([data-drawer-drag]) [data-narrow-overlay]')
  })

  it('drops the drawer motion for anyone who asked for less of it', () => {
    expect(phoneCss).toContain('prefers-reduced-motion: reduce')
  })
})
