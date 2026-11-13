import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $pendingApprovalCount } from '@/store/prompts'

/** Installed-PWA icon badge. Chromium/Android exposes it; Safari and the Electron
 *  shell leave the methods undefined, which is why every call is optional. */
export function setAppBadgeCount(count: number): void {
  if (typeof navigator === 'undefined') {
    return
  }

  const badge = navigator as Navigator & {
    clearAppBadge?: () => Promise<void>
    setAppBadge?: (contents?: number) => Promise<void>
  }

  try {
    if (count <= 0) {
      void badge.clearAppBadge?.()
    } else {
      void badge.setAppBadge?.(count)
    }
  } catch {
    // A refused badge (permission, unsupported platform) is not worth a notice.
  }
}

/**
 * Keeps the home-screen icon showing how many approvals are waiting. Renders
 * nothing: a waiting money-gate decision is the one thing worth surfacing while
 * the app is closed, and the push notification already carries the text.
 */
export function AppBadgeSync() {
  const pending = useStore($pendingApprovalCount)

  useEffect(() => {
    setAppBadgeCount(pending)
  }, [pending])

  return null
}
