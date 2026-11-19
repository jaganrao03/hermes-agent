import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { useComposerScope } from '@/app/chat/composer/scope'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { quoteSelection } from '@/lib/selection-quote'

interface Anchor {
  text: string
  x: number
  y: number
}

// Distance from the selection to the pill, and the room it needs above before flipping below.
const GAP_PX = 8
const PILL_HEIGHT_PX = 32

/**
 * "Ask about this" for text selected inside one assistant reply. Mount it inside the reply's content
 * element: it scopes itself to its parent, so a selection anywhere else (another reply, the composer,
 * the sidebar) never offers it. The pill portals to `document.body`, which keeps it clear of the reply's
 * `overflow-hidden`, and clicking it seeds the composer with a blockquote of the selection.
 */
export const SelectToAsk: FC = () => {
  const { t } = useI18n()
  const { target } = useComposerScope()
  const markerRef = useRef<HTMLSpanElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => {
    const scope = markerRef.current?.parentElement

    if (!scope) {
      return
    }

    const read = () => {
      const selection = window.getSelection()
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
      const text = range && scope.contains(range.commonAncestorContainer) ? selection!.toString() : ''

      if (!range || !quoteSelection(text)) {
        setAnchor(null)

        return
      }

      const rect = range.getBoundingClientRect()
      const below = rect.top < PILL_HEIGHT_PX + GAP_PX

      setAnchor({ text, x: rect.left + rect.width / 2, y: below ? rect.bottom + GAP_PX : rect.top - GAP_PX - PILL_HEIGHT_PX })
    }

    document.addEventListener('selectionchange', read)

    return () => document.removeEventListener('selectionchange', read)
  }, [])

  const ask = useCallback(() => {
    if (!anchor) {
      return
    }

    triggerHaptic('selection')
    requestComposerInsert(quoteSelection(anchor.text), { mode: 'block', target })
    requestComposerFocus(target)
    window.getSelection()?.removeAllRanges()
    setAnchor(null)
  }, [anchor, target])

  return (
    <>
      <span aria-hidden className="hidden" ref={markerRef} />
      {anchor &&
        createPortal(
          <Button
            className="fixed z-50 -translate-x-1/2 shadow-md"
            data-slot="aui_select-to-ask"
            onClick={ask}
            // Keep the selection alive through the press; clearing it is what ask() does on purpose.
            onMouseDown={event => event.preventDefault()}
            size="xs"
            style={{ left: anchor.x, top: anchor.y }}
            type="button"
            variant="outline"
          >
            {t.assistant.thread.askAboutThis}
          </Button>,
          document.body
        )}
    </>
  )
}
