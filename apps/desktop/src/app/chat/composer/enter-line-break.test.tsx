import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composerEnterIntent } from './enter-intent'
import { insertComposerContentsAtCaret } from './rich-editor'

afterEach(cleanup)

// Faithful mirror of the plain-Enter path in index.tsx: the newline is the
// browser's own contentEditable default, repaired after a tick only when
// nothing landed.
//
// Regression repro (Brave/Android over the Webapp): the soft keyboard's return
// key can arrive as an IME action with no insertion, so plain Enter and
// Shift+Enter did nothing while Ctrl+Enter still submitted. The repair inserts
// the break itself, and must never stack a second one on a browser that already
// inserted one.
function Harness({ onFlush }: { onFlush: (text: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null)

  const ensureLineBreak = (editor: HTMLDivElement) => {
    const before = editor.innerHTML

    window.setTimeout(() => {
      if (editorRef.current !== editor || !editor.isConnected) {
        return
      }

      if (editor.innerHTML !== before) {
        return
      }

      insertComposerContentsAtCaret(editor, '\n')
      onFlush(editor.textContent ?? '')
    }, 60)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (composerEnterIntent(event.nativeEvent) === 'newline') {
      event.stopPropagation()
      ensureLineBreak(event.currentTarget)
    }
  }

  return (
    <div
      contentEditable
      data-testid="editor"
      onKeyDown={handleKeyDown}
      ref={editorRef}
      role="textbox"
      suppressContentEditableWarning
    />
  )
}

describe('composer Enter — plain Enter always leaves a line break', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('inserts the break when the keyboard delivered Enter with no insertion', async () => {
    const onFlush = vi.fn()
    const { getByTestId } = render(<Harness onFlush={onFlush} />)
    const editor = getByTestId('editor')

    await act(async () => {
      editor.textContent = 'first line'
      fireEvent.keyDown(editor, { key: 'Enter' })
      vi.advanceTimersByTime(60)
    })

    // The insert lands as a <br>, which is how the editor stores a break (and
    // how its serializer reads one back as "\n").
    expect(editor.querySelectorAll('br')).toHaveLength(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toContain('first line')
  })

  it('lets the browser insert the break and never doubles it', async () => {
    const onFlush = vi.fn()
    const { getByTestId } = render(<Harness onFlush={onFlush} />)
    const editor = getByTestId('editor')

    await act(async () => {
      editor.textContent = 'first line'
      // A browser that honours the default inserts a <br> before the key
      // handler's timer runs.
      fireEvent.keyDown(editor, { key: 'Enter' })
      editor.append(editor.ownerDocument.createElement('br'))
      vi.advanceTimersByTime(60)
    })

    expect(editor.textContent).toBe('first line')
    expect(editor.querySelectorAll('br')).toHaveLength(1)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('Shift+Enter takes the same newline path, not the submit one', () => {
    expect(composerEnterIntent({ key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBe(
      'newline'
    )
  })
})
