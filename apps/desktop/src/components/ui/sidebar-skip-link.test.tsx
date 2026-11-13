import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAIN_CONTENT_ID, SidebarProvider } from './sidebar'

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

afterEach(cleanup)

// Mirrors the real shell in `app/contrib/controller.tsx`: the skip target is the
// once-per-window shell div, not a per-session `<main>` (split view can render
// several chat surfaces, so an id there would collide).
function Shell() {
  return (
    <SidebarProvider>
      <div id={MAIN_CONTENT_ID} role="main" tabIndex={-1}>
        <button>chrome</button>
        <p>conversation</p>
      </div>
    </SidebarProvider>
  )
}

describe('skip to conversation link', () => {
  it('is the first focusable element and targets an existing main landmark', () => {
    const { container } = render(<Shell />)
    const link = screen.getByRole('link', { name: 'Skip to conversation' })
    const focusable = container.querySelector<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"])')

    expect(focusable).toBe(link)

    const id = link.getAttribute('href')!.slice(1)
    const target = document.getElementById(id)

    expect(target).not.toBeNull()
    expect(target?.getAttribute('role')).toBe('main')
    expect(target?.getAttribute('tabindex')).toBe('-1')
  })

  it('stays in the accessibility tree via the sr-only clip pattern', () => {
    render(<Shell />)
    const link = screen.getByRole('link', { name: 'Skip to conversation' })

    expect(link.className).toContain('sr-only')
    expect(link.className).toContain('focus-visible:not-sr-only')
  })

  it('moves focus to the main landmark on activation', () => {
    render(<Shell />)
    fireEvent.click(screen.getByRole('link', { name: 'Skip to conversation' }))

    expect(document.activeElement).toBe(document.getElementById(MAIN_CONTENT_ID))
  })
})
