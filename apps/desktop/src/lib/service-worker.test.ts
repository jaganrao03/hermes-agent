import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerNotificationWorker } from './service-worker'

describe('registerNotificationWorker', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves null and touches nothing where service workers are unavailable', async () => {
    // jsdom exposes no navigator.serviceWorker.
    await expect(registerNotificationWorker()).resolves.toBeNull()
  })
})

describe('worker focus relay', () => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const register = vi.fn(async () => ({ scope: 'https://h.example/' }))

  beforeEach(async () => {
    vi.resetModules()
    listeners.clear()
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
        register
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('registers sw.js beside the page and relays only well-formed focus messages', async () => {
    const mod = await import('./service-worker')
    const seen: string[] = []
    mod.onNotificationWorkerFocus(id => seen.push(id))

    await mod.registerNotificationWorker()
    expect(register).toHaveBeenCalledWith(new URL('sw.js', document.baseURI).href)
    expect(mod.notificationWorkerRegistration()).not.toBeNull()

    const send = (data: unknown) => [...listeners].forEach(fn => fn({ data } as MessageEvent))
    send({ sessionId: 'stored-1', type: 'hermes:focus-session' })
    send({ sessionId: 'stored-2', type: 'something-else' })
    send({ sessionId: 42, type: 'hermes:focus-session' })
    send({ sessionId: 'x'.repeat(300), type: 'hermes:focus-session' })
    send(null)

    expect(seen).toEqual(['stored-1'])
  })
})

// public/sw.js is a classic script, so run it against a fake worker scope.
describe('public/sw.js notificationclick', () => {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')

  function boot(windows: { focus: () => Promise<void>; postMessage: (m: unknown) => void; url: string }[]) {
    const handlers: Record<string, (event: unknown) => void> = {}
    const openWindow = vi.fn(async () => undefined)

    const scope = {
      addEventListener: (type: string, fn: (event: unknown) => void) => (handlers[type] = fn),
      clients: { claim: vi.fn(), matchAll: async () => windows, openWindow },
      registration: { scope: 'https://h.example/app/' },
      skipWaiting: vi.fn()
    }

    new Function('self', source)(scope)

    return { handlers, openWindow }
  }

  async function click(handlers: Record<string, (event: unknown) => void>, data: unknown) {
    let work: Promise<unknown> = Promise.resolve()
    const close = vi.fn()
    handlers.notificationclick({ notification: { close, data }, waitUntil: (p: Promise<unknown>) => (work = p) })
    await work

    return close
  }

  it('focuses the open app window and tells it which chat to show', async () => {
    const focus = vi.fn(async () => undefined)
    const postMessage = vi.fn()

    const { handlers, openWindow } = boot([
      { focus: vi.fn(), postMessage: vi.fn(), url: 'https://other.example/' },
      { focus, postMessage, url: 'https://h.example/app/#/abc' }
    ])

    const close = await click(handlers, { sessionId: 'stored-1' })

    expect(close).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({ sessionId: 'stored-1', type: 'hermes:focus-session' })
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('cold-starts the app on the chat route when no window is open', async () => {
    const { handlers, openWindow } = boot([])

    await click(handlers, { sessionId: 'a b/c' })

    expect(openWindow).toHaveBeenCalledWith('https://h.example/app/#/a%20b%2Fc')
  })

  it('opens the app root, and posts nothing, when the notification names no valid chat', async () => {
    const postMessage = vi.fn()
    const { handlers, openWindow } = boot([])
    await click(handlers, { sessionId: { evil: true } })
    expect(openWindow).toHaveBeenCalledWith('https://h.example/app/')

    const second = boot([{ focus: vi.fn(async () => undefined), postMessage, url: 'https://h.example/app/' }])
    await click(second.handlers, undefined)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

