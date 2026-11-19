/**
 * Webapp service worker plumbing: registers `sw.js` and relays its notification-click messages.
 *
 * The worker is a notification-click bridge only (see `public/sw.js`): no caching, no push. Everything
 * here degrades to a no-op where service workers are unavailable (Electron, insecure LAN http, old
 * browsers), and the page-level `Notification` path in `browser-notifications.ts` keeps working.
 */

const FOCUS_MESSAGE = 'hermes:focus-session'
const MAX_SESSION_ID_CHARS = 256

export function serviceWorkerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.protocol === 'http:')
  )
}

const focusListeners = new Set<(sessionId: string) => void>()

/** A tapped notification asked the page to open this chat (the page was already running). */
export function onNotificationWorkerFocus(callback: (sessionId: string) => void): () => void {
  focusListeners.add(callback)

  return () => focusListeners.delete(callback)
}

/** The page is the only trusted consumer: ignore anything that is not our worker's focus message. */
function onWorkerMessage(event: MessageEvent) {
  const data = event.data as { sessionId?: unknown; type?: unknown } | null

  if (
    data?.type === FOCUS_MESSAGE &&
    typeof data.sessionId === 'string' &&
    data.sessionId &&
    data.sessionId.length <= MAX_SESSION_ID_CHARS
  ) {
    const sessionId = data.sessionId
    focusListeners.forEach(listener => listener(sessionId))
  }
}

let registration: null | Promise<null | ServiceWorkerRegistration> = null
let active: null | ServiceWorkerRegistration = null

/** Register once; resolves null (never rejects) when unsupported or registration fails. */
export function registerNotificationWorker(): Promise<null | ServiceWorkerRegistration> {
  if (!registration) {
    registration = serviceWorkerSupported()
      ? (navigator.serviceWorker.addEventListener('message', onWorkerMessage),
        navigator.serviceWorker
          .register(new URL('sw.js', document.baseURI).href)
          .then(reg => (active = reg))
          .catch(() => null))
      : Promise.resolve(null)
  }

  return registration
}

/** The registration once `registerNotificationWorker` has resolved with one; never triggers it. */
export const notificationWorkerRegistration = (): null | ServiceWorkerRegistration => active
