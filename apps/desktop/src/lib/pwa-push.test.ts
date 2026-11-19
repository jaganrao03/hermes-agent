import { afterEach, describe, expect, it, vi } from 'vitest'

import { enablePwaPush, pushDeviceCount, sendTestPwaPush, stopPresence } from './pwa-push'

describe('push API URLs', () => {
  afterEach(() => {
    stopPresence()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetches the key endpoint under the webapp prefix without a double slash', async () => {
    vi.spyOn(document, 'baseURI', 'get').mockReturnValue('https://example.test/hermes/')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ devices: 2 }) }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await pushDeviceCount()).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/hermes/api/plugins/pwa-push/key', expect.anything())
  })

  it.each(['/', '/hermes/'])('subscribes, sends presence and tests push at base %s', async base => {
    vi.spyOn(document, 'baseURI', 'get').mockReturnValue(`https://example.test${base}`)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    const subscription = { toJSON: () => ({ endpoint: 'https://push.example.test/device', keys: { auth: 'a', p256dh: 'b' } }) }
    const registration = { active: true, pushManager: { getSubscription: vi.fn(async () => subscription) } }
    vi.stubGlobal('navigator', { userAgent: 'test browser', serviceWorker: { getRegistration: vi.fn(async () => registration) } })

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => (url.endsWith('/key') ? { publicKey: 'AA' } : { ok: true })
    }))

    vi.stubGlobal('fetch', fetchMock)

    expect(await enablePwaPush()).toBe('on')
    expect(await sendTestPwaPush()).toBe(true)
    const root = `https://example.test${base}api/plugins/pwa-push`
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${root}/key`, `${root}/subscribe`, `${root}/presence`, `${root}/test`
    ])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'POST' })
  })
})
