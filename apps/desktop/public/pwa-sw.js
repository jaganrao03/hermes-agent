/* global self */
/* Hermes webapp service worker: push notifications only — it caches nothing and
   never intercepts fetches, so an update to the app is picked up as usual. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function payload(event) {
  const fallback = { title: 'Hermes', body: '', tag: 'hermes', url: '/', sessionId: '' };
  try {
    return event.data ? Object.assign(fallback, event.data.json()) : fallback;
  } catch {
    return Object.assign(fallback, { body: event.data ? event.data.text() : '' });
  }
}

self.addEventListener('push', event => {
  const m = payload(event);
  event.waitUntil(
    self.registration.showNotification(m.title || 'Hermes', {
      body: m.body || '',
      tag: m.tag || 'hermes',
      renotify: true,
      icon: '/hermes-pwa-192.png',
      badge: '/hermes-pwa-192.png',
      data: { url: m.url || '/', sessionId: m.sessionId || '' },
      vibrate: [90, 40, 90],
      timestamp: Date.now()
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          client.postMessage({ type: 'hermes-push-open', sessionId: data.sessionId || '', url: target });
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

/* A browser may rotate a subscription on its own; tell the open app so it can
   re-register, and let the next app visit repair it if nothing is open. */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) client.postMessage({ type: 'hermes-push-resubscribe' });
    })()
  );
});