import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onBrowserFocusSession, showBrowserNotification } from './browser-notifications'

const created: { body?: string; onclick: (() => void) | null; title: string }[] = []

class FakeNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  onclick: (() => void) | null = null
  body?: string
  constructor(public title: string, options?: { body?: string }) {
    this.body = options?.body
    created.push(this)
  }
  close() {}
}

describe('showBrowserNotification', () => {
  beforeEach(() => {
    created.length = 0
    FakeNotification.requestPermission.mockClear()
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('isSecureContext', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never asks for permission from an event (only a click in Settings may)', () => {
    FakeNotification.permission = 'default'

    expect(showBrowserNotification({ kind: 'approval', sessionId: 's1', title: 'Approval needed' })).toBe(false)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('opens the notified session through onFocusSession when clicked', () => {
    FakeNotification.permission = 'granted'
    const opened: string[] = []
    const off = onBrowserFocusSession(id => opened.push(id))
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)

    expect(
      showBrowserNotification({ focusSessionId: 'stored-1', kind: 'approval', sessionId: 'rt-1', title: 'Approval needed' })
    ).toBe(true)
    created[0].onclick?.()

    expect(focus).toHaveBeenCalled()
    expect(opened).toEqual(['stored-1'])
    off()
  })

  it('never puts chat names or reply text into an OS notification', () => {
    FakeNotification.permission = 'granted'

    showBrowserNotification({
      body: 'The production password is hunter2',
      focusSessionId: 'stored-1',
      kind: 'turnDone',
      sessionId: 'rt-1',
      title: 'Fix payroll leak — Hermes finished'
    })

    expect(created[0].title).toBe('Hermes finished')
    expect(created[0].body).toBe('Message complete.')
    expect(JSON.stringify(created)).not.toMatch(/hunter2|payroll/)
  })

  it('routes through the service worker when one is registered, carrying only the session id', async () => {
    FakeNotification.permission = 'granted'
    const showNotification = vi.fn(async () => undefined)
    const registerWorker = await import('./service-worker')
    vi.spyOn(registerWorker, 'notificationWorkerRegistration').mockReturnValue({ showNotification } as never)

    expect(
      showBrowserNotification({ body: 'secret preview', focusSessionId: 'stored-9', kind: 'approval', title: 'Approval needed — Private chat' })
    ).toBe(true)

    expect(created).toHaveLength(0)
    expect(showNotification).toHaveBeenCalledWith('Approval needed', {
      body: undefined,
      data: { sessionId: 'stored-9' },
      tag: 'hermes:approval:stored-9'
    })
    vi.restoreAllMocks()
  })
})
