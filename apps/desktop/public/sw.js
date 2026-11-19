/* global self */
// Hermes Webapp service worker. Deliberately tiny: it exists so a notification can be shown from
// the worker (the only form Android Chrome allows) and so tapping it lands on the right chat.
//
// It does NOT cache or intercept fetches (the app must never serve a stale shell), and it has no
// `push` handler: this repo has no push subscription endpoint, so there is nothing to deliver yet.
// Notification payloads carry only a stored session id, never message content.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function sessionIdOf(notification) {
  const id = notification && notification.data && notification.data.sessionId

  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : ''
}

async function openChat(sessionId) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find(client => client.url.startsWith(self.registration.scope))

  if (open) {
    await open.focus()

    if (sessionId) {
      open.postMessage({ sessionId, type: 'hermes:focus-session' })
    }

    return
  }

  // Cold start: the hash route is the same one the sidebar uses for this chat.
  const hash = sessionId ? `#/${encodeURIComponent(sessionId)}` : ''
  await self.clients.openWindow(new URL(hash, self.registration.scope).href)
}

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(openChat(sessionIdOf(event.notification)))
})
