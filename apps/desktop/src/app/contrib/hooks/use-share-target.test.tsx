import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { resetPendingShareForTests } from '@/lib/share-target'
import { $composerDraft, clearComposerDraft } from '@/store/composer'

import { useShareTarget } from './use-share-target'

beforeEach(() => {
  resetPendingShareForTests()
  clearComposerDraft()
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

function mount(profileReady = true) {
  const navigate = vi.fn()
  const restoredRef = { current: false }
  renderHook(() => useShareTarget({ navigate, profileReady, restoredRef }))

  return { navigate, restoredRef }
}

it('drops shared text into a fresh chat draft, claims the restore latch and strips the params', () => {
  window.history.replaceState(null, '', '/?win=main&share-target=1&title=Notes&text=Read%20this#/')

  const { navigate, restoredRef } = mount()

  expect(navigate).toHaveBeenCalledWith('/', { replace: true })
  expect($composerDraft.get()).toBe('Notes\nRead this')
  expect(restoredRef.current).toBe(true)
  expect(window.location.search).toBe('?win=main')
  expect(window.location.hash).toBe('#/')
})

it('waits for the profile before taking the share', () => {
  window.history.replaceState(null, '', '/?share-target=1&text=hello#/')

  const { navigate } = mount(false)

  expect(navigate).not.toHaveBeenCalled()
  expect($composerDraft.get()).toBe('')
  expect(window.location.search).toBe('?share-target=1&text=hello')
})

it('does nothing on an ordinary launch', () => {
  const { navigate, restoredRef } = mount()

  expect(navigate).not.toHaveBeenCalled()
  expect(restoredRef.current).toBe(false)
  expect($composerDraft.get()).toBe('')
})
