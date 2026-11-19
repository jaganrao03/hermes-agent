/**
 * The Webapp's half of `hermesDesktop.notify`: what Electron's notification IPC
 * does in main, done with the browser's Notification API.
 *
 * Permission is asked only from a click in Settings (browsers ignore or
 * penalise prompts that no gesture started), so an event arriving before the
 * user opted in shows nothing here and the tab-title flash carries it alone.
 * The API needs a secure context: Tailscale serve (https) and localhost have
 * it, a plain-http LAN address does not.
 */

import { translateNow } from '@/i18n'
import { notificationWorkerRegistration, onNotificationWorkerFocus } from '@/lib/service-worker'
import { flagTabAttention } from '@/store/browser-tab-attention'

export type BrowserNotificationPermission = 'default' | 'denied' | 'granted' | 'insecure' | 'unsupported'

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined') {
    return 'unsupported'
  }

  if (!window.isSecureContext) {
    return 'insecure'
  }

  return 'Notification' in window ? Notification.permission : 'unsupported'
}

/** Call from a click handler only. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (browserNotificationPermission() === 'default') {
    await Notification.requestPermission()
  }

  return browserNotificationPermission()
}

type FocusSessionListener = (sessionId: string) => void

const focusSessionListeners = new Set<FocusSessionListener>()

/** Same contract as Electron's `onFocusSession`: a notification click names the session to open. A
 *  click on a service-worker notification reaches the page through the worker's message. */
export function onBrowserFocusSession(callback: FocusSessionListener): () => void {
  focusSessionListeners.add(callback)
  const offWorker = onNotificationWorkerFocus(callback)

  return () => {
    focusSessionListeners.delete(callback)
    offWorker()
  }
}

export interface BrowserNotifyPayload {
  body?: string
  focusSessionId?: string
  kind?: string
  sessionId?: string
  tag?: string
  title?: string
}

interface GenericContent {
  body?: string
  title: string
}

/** What an OS notification may say. A notification outlives the tab: it shows on a lock screen, in a
 *  shared screen or a notification shade. The payload's own title (it names the chat) and body (a reply
 *  preview, an error message) stay in the app; the notification says only what happened, and the tap
 *  opens the chat to read the rest. */
function genericContent(kind: string | undefined): GenericContent {
  const t = (key: string) => translateNow(`notifications.native.${key}`)

  switch (kind) {
    case 'approval':
      return { title: t('approvalTitle') }

    case 'input':
      return { body: t('inputBody'), title: t('inputTitle') }

    case 'turnDone':
      return { body: t('turnDoneBody'), title: t('turnDoneTitle') }

    case 'turnError':
      return { title: t('turnErrorTitle') }

    case 'backgroundDone':
      return { title: t('backgroundDoneTitle') }

    case 'credits':
      return { title: t('creditsTitle') }

    default:
      return { title: 'Hermes' }
  }
}

function showPageNotification(content: GenericContent, tag: string, focusSessionId: string | undefined) {
  const notification = new Notification(content.title, { body: content.body, tag })

  notification.onclick = () => {
    // A click on our own notification is the user's request to come back.
    window.focus()
    notification.close()

    if (focusSessionId) {
      focusSessionListeners.forEach(listener => listener(focusSessionId))
    }
  }
}

/** Flash the tab, then show a browser notification when the user allowed it. */
export function showBrowserNotification(payload: BrowserNotifyPayload): boolean {
  flagTabAttention(payload.title || 'Hermes')

  if (browserNotificationPermission() !== 'granted') {
    return false
  }

  const focusSessionId = payload.focusSessionId || payload.sessionId
  const content = genericContent(payload.kind)
  // One OS entry per session+kind: a replayed event replaces, never stacks.
  const tag = `hermes:${payload.kind ?? ''}:${focusSessionId ?? payload.tag ?? ''}`
  const worker = notificationWorkerRegistration()

  if (worker) {
    // Android Chrome only allows worker notifications (`new Notification` throws there). The worker's
    // click handler routes the tap; the data carries a stored session id and nothing else.
    worker
      .showNotification(content.title, { body: content.body, data: { sessionId: focusSessionId }, tag })
      .catch(() => {
        // No active worker yet (just registered). Desktop browsers still take the page path; Android
        // throws on the constructor, so that one notification is skipped rather than raised unhandled.
        try {
          showPageNotification(content, tag, focusSessionId)
        } catch {
          // Illegal constructor: worker-only platform.
        }
      })

    return true
  }

  showPageNotification(content, tag, focusSessionId)

  return true
}
