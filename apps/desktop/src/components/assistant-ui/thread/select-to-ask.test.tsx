import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { en } from '@/i18n/en'

import { SelectToAsk } from './select-to-ask'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerFocus: vi.fn(), requestComposerInsert: vi.fn() }))

function select(node: Node, text: string) {
  const start = node.textContent!.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

beforeEach(() => {
  // jsdom has no layout; a rect is all the popover positioning reads.
  Range.prototype.getBoundingClientRect = () => ({ bottom: 120, height: 20, left: 40, right: 140, top: 100, width: 100, x: 40, y: 100, toJSON: () => ({}) })
  vi.mocked(requestComposerInsert).mockReset()
  vi.mocked(requestComposerFocus).mockReset()
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

function Reply() {
  return (
    <div>
      <p data-testid="inside">Use a mutex around the shared counter.</p>
      <SelectToAsk />
    </div>
  )
}

it('offers Ask about this for text selected inside the reply and seeds the composer with a quote', () => {
  render(
    <>
      <Reply />
      <p data-testid="outside">Unrelated page text.</p>
    </>
  )

  expect(screen.queryByRole('button', { name: en.assistant.thread.askAboutThis })).toBeNull()

  select(screen.getByTestId('inside').firstChild!, 'a mutex')
  fireEvent.click(screen.getByRole('button', { name: en.assistant.thread.askAboutThis }))

  expect(requestComposerInsert).toHaveBeenCalledWith('> a mutex', { mode: 'block', target: 'main' })
  expect(requestComposerFocus).toHaveBeenCalledWith('main')
  expect(screen.queryByRole('button', { name: en.assistant.thread.askAboutThis })).toBeNull()
})

it('ignores a selection that lives outside the reply', () => {
  render(
    <>
      <Reply />
      <p data-testid="outside">Unrelated page text.</p>
    </>
  )

  select(screen.getByTestId('outside').firstChild!, 'Unrelated')

  expect(screen.queryByRole('button', { name: en.assistant.thread.askAboutThis })).toBeNull()
})

it('hides again once the selection collapses', () => {
  render(<Reply />)

  select(screen.getByTestId('inside').firstChild!, 'mutex')
  expect(screen.getByRole('button', { name: en.assistant.thread.askAboutThis })).toBeTruthy()

  window.getSelection()!.removeAllRanges()
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })

  expect(screen.queryByRole('button', { name: en.assistant.thread.askAboutThis })).toBeNull()
})
