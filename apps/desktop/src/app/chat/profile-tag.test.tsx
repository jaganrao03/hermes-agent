import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProfileTag } from './profile-tag'

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { sidebar: { row: { ownedByProfile: (profile: string) => `Owned by ${profile}` } } }
  })
}))

afterEach(cleanup)

describe('ProfileTag', () => {
  it.each([
    ['default', 'default'],
    ['worker', 'worker'],
    [null, 'default'],
    [undefined, 'default']
  ])('renders the real profile glyph for %s as %s', (profile, expected) => {
    render(<ProfileTag profile={profile} />)

    expect(screen.getByRole('img', { name: `Owned by ${expected}` })).toBeTruthy()

    if (expected === 'default') {
      expect(window.document.querySelector('.codicon-home')).not.toBeNull()
    } else {
      expect(window.document.querySelector('.codicon-home')).toBeNull()
      expect(screen.getByRole('img', { name: `Owned by ${expected}` }).textContent).toBe('w')
    }
  })
})
