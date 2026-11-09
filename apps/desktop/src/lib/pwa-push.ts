/**
 * Real Web Push for the installed webapp/PWA.
 *
 * Everything else in this app alerts through `new Notification(...)`, which only
 * exists while a tab is open — and which Android Chrome/Brave do not implement
 * for pages at all. iPhone and Android both deliver Web Push to a service
 * worker instead, with the app closed, through the browser's push service.
 *
 * The worker is served by the `pwa-push` plugin at /api/plugins/pwa-push/sw.js
 * with `Service-Worker-Allowed: /`, so one script under /api still controls the
 * whole app. The same plugin holds the VAPID key and the subscriptions, and it
 * decides after each turn whether to push (it skips while this client is on
 * screen: see the presence heartbeat below).
 */

const PLUGIN = 'api/plugins/pwa-push'

/**
 * Every URL is resolved against the page, never the origin: the webapp may be
 * served under a prefix, and a root-absolute path would then miss the API and
 * the worker entirely.
 */
function pushUrl(path: string): string {
  return new URL(`${PLUGIN}/${path}`, document.baseURI).href
}

/**
 * Two homes for the same worker: the build ships a copy beside the app (no
 * Service-Worker-Allowed needed), and the plugin serves one under /api as a
 * fallback for an older app build. Whichever answers first registers.
 */
function swCandidates(): { scope: string; url: string }[] {
  const beside = new URL('pwa-sw.js', document.baseURI)
  const viaApi = new URL(`${PLUGIN}/sw.js`, document.baseURI)

  return [
    { scope: new URL('./', document.baseURI).pathname, url: beside.href },
    { scope: '/', url: viaApi.href }
  ]
}

const CLIENT_KEY = 'hermes.pwa-push.client'

export type PwaPushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on' | 'error'

interface PushKeyResponse {
  devices?: number
  enabled?: boolean
  publicKey?: string
}

export function pwaPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function clientId(): string {
  try {
    const stored = window.localStorage.getItem(CLIENT_KEY)

    if (stored) {
      return stored
    }

    const made = `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

    window.localStorage.setItem(CLIENT_KEY, made)

    return made
  } catch {
    return `web-${Date.now().toString(36)}`
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pushUrl(path), {
    headers: { 'content-type': 'application/json' },
    ...init
  })

  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`)
  }

  return (await response.json()) as T
}

/** The VAPID key arrives base64url; PushManager wants bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = window.atob(padded)
  // A fresh ArrayBuffer-backed view: applicationServerKey rejects a
  // SharedArrayBuffer-backed one.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }

  return bytes
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')

  if (existing?.active) {
    return existing
  }

  let lastError: unknown

  for (const { scope, url } of swCandidates()) {
    try {
      const created = await navigator.serviceWorker.register(url, { scope })

      await navigator.serviceWorker.ready

      return created
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('service worker registration failed')
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pwaPushSupported()) {
    return null
  }

  try {
    const reg = await navigator.serviceWorker.getRegistration('/')

    return (await reg?.pushManager.getSubscription()) ?? null
  } catch {
    return null
  }
}

export async function pwaPushState(): Promise<PwaPushState> {
  if (!pwaPushSupported()) {
    return typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'unsupported'
  }

  if (Notification.permission === 'denied') {
    return 'denied'
  }

  return (await currentPushSubscription()) ? 'on' : 'off'
}

/** Must run inside a click: the permission prompt needs a gesture. */
export async function enablePwaPush(): Promise<PwaPushState> {
  if (!pwaPushSupported()) {
    return typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'unsupported'
  }

  const reg = await registration()
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()

  if (permission !== 'granted') {
    return 'denied'
  }

  const key = await call<PushKeyResponse>('/key')

  if (!key.publicKey) {
    return 'error'
  }

  const existing = await reg.pushManager.getSubscription()

  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      applicationServerKey: keyBytes(key.publicKey),
      userVisibleOnly: true
    }))

  await call('/subscribe', {
    body: JSON.stringify({ ...subscription.toJSON(), userAgent: navigator.userAgent }),
    method: 'POST'
  })

  startPresence()

  return 'on'
}

export async function disablePwaPush(): Promise<PwaPushState> {
  const subscription = await currentPushSubscription()

  if (subscription) {
    try {
      await call('/unsubscribe', {
        body: JSON.stringify({ clientId: clientId(), endpoint: subscription.endpoint }),
        method: 'POST'
      })
    } finally {
      await subscription.unsubscribe().catch(() => undefined)
    }
  }

  stopPresence()

  return 'off'
}

export async function sendTestPwaPush(): Promise<boolean> {
  try {
    const result = await call<{ ok?: boolean }>('/test', { body: '{}', method: 'POST' })

    return Boolean(result.ok)
  } catch {
    return false
  }
}

export async function pushDeviceCount(): Promise<number> {
  try {
    return (await call<PushKeyResponse>('/key')).devices ?? 0
  } catch {
    return 0
  }
}

let heartbeat: ReturnType<typeof setInterval> | undefined

/** While this app is on screen the plugin stays quiet; stop beating when hidden
 *  so a reply that lands after you leave still reaches the lock screen. */
function beat(): void {
  if (document.visibilityState !== 'visible') {
    return
  }

  void call('/presence', { body: JSON.stringify({ clientId: clientId() }), method: 'POST' }).catch(() => undefined)
}

export function startPresence(): void {
  if (heartbeat !== undefined) {
    return
  }

  beat()
  heartbeat = setInterval(beat, 45_000)
  document.addEventListener('visibilitychange', beat)
}

export function stopPresence(): void {
  if (heartbeat !== undefined) {
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  document.removeEventListener('visibilitychange', beat)
  void call('/leave', { body: JSON.stringify({ clientId: clientId() }), method: 'POST' }).catch(() => undefined)
}

/**
 * Webapp boot: repair a rotated subscription, route a notification click to the
 * session it names, and resume the presence heartbeat when push is already on.
 */
export function installPwaPushBridge(onFocusSession?: (sessionId: string) => void): void {
  if (!pwaPushSupported()) {
    return
  }

  navigator.serviceWorker.addEventListener('message', event => {
    const data = (event.data ?? {}) as { sessionId?: string; type?: string }

    if (data.type === 'hermes-push-open' && data.sessionId) {
      onFocusSession?.(data.sessionId)
    }

    if (data.type === 'hermes-push-resubscribe') {
      void enablePwaPush().catch(() => undefined)
    }
  })

  void currentPushSubscription().then(subscription => {
    if (subscription) {
      startPresence()
    }
  })
}
