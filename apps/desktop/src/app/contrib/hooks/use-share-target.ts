import { type RefObject, useEffect } from 'react'

import { takePendingShare } from '@/lib/share-target'
import { appendComposerDraft } from '@/store/composer'

import { requestComposerFocus } from '../../chat/composer/focus'
import { NEW_CHAT_ROUTE } from '../../routes'

interface ShareTargetParams {
  navigate: (to: string, options?: { replace?: boolean }) => void
  profileReady: boolean
  /** The cold-start restore latch of `useDesktopIntegrations`. A share names its own destination
   *  (a fresh chat), so it must claim the latch before the remembered-session restore runs. */
  restoredRef: RefObject<boolean>
}

/**
 * Hand text shared into the installed Webapp (Android share sheet) to a fresh chat's composer. It
 * only fills the draft: nothing is sent until the user reads it and presses send.
 *
 * Must be called before the restore effect of `useDesktopIntegrations` so its effect runs first.
 */
export function useShareTarget({ navigate, profileReady, restoredRef }: ShareTargetParams): void {
  // The ref is a one-time lifecycle latch shared with the restore effect, not a mirror of atom state.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!profileReady) {
      return
    }

    const text = takePendingShare()

    if (!text) {
      return
    }

    restoredRef.current = true
    navigate(NEW_CHAT_ROUTE, { replace: true })
    appendComposerDraft(text)
    requestComposerFocus('main')
  }, [navigate, profileReady, restoredRef])
}
