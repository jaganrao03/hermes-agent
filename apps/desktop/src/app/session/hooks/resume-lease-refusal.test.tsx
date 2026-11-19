import { JsonRpcGatewayError } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { getLatestSessionMessages } from '@/hermes'
import { en } from '@/i18n/en'
import { $notifications, clearNotifications } from '@/store/notifications'
import {
  $activeSessionId,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $resumeReattachSessionId,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setResumeExhaustedSessionId,
  setResumeFailedSessionId,
  setResumeReattachSessionId,
  setSelectedStoredSessionId
} from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'

import { useSessionActions } from './use-session-actions'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn(),
  getSession: vi.fn(),
  listAllProfileSessions: vi.fn(),
  setApiRequestProfile: vi.fn()
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureGatewayAgent: vi.fn().mockResolvedValue(undefined),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn(),
  requestGatewayForProfile: vi.fn(),
  retainGatewayForAgent: vi.fn(async () => () => undefined)
}))

type Resume = ReturnType<typeof useSessionActions>['resumeSession']

function leaseRefusal() {
  return new JsonRpcGatewayError('runtime_coordination_required', {
    code: 4090,
    data: { reason: 'runtime_coordination_required' }
  })
}

function Harness({ onReady }: { onReady: (resume: Resume) => void }) {
  const activeSessionId = useStore($activeSessionId)
  const busyRef = useRef(false)

  const cache = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId: null,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const actions = useSessionActions({
    ...cache,
    activeSessionId,
    busyRef,
    creatingSessionRef: useRef(false),
    getRouteToken: () => 'lease-refusal',
    getRoutedStoredSessionId: () => null,
    navigate: vi.fn() as never,
    requestGateway: async () => {
      throw leaseRefusal()
    },
    routedSessionId: null,
    selectedStoredSessionId: null
  })

  useEffect(() => {
    onReady(actions.resumeSession)
  }, [actions.resumeSession, onReady])

  return null
}

afterEach(() => {
  cleanup()
  clearNotifications()
  clearAllSessionStates()
  setResumeFailedSessionId(null)
  setResumeExhaustedSessionId(null)
  setResumeReattachSessionId(null)
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setMessages([])
  vi.clearAllMocks()
})

async function mountResume(): Promise<Resume> {
  let resume: null | Resume = null
  render(<Harness onReady={r => (resume = r)} />)
  await waitFor(() => expect(resume).not.toBeNull())

  return resume!
}

// A held lease does not clear on its own, so the 1s..8s auto-retry (4 attempts) would only repeat the
// refusal. The window goes straight to the exhausted overlay (Start new session + manual Retry).
it('a lease refusal on an empty window skips the auto-retry and shows the explained toast', async () => {
  vi.mocked(getLatestSessionMessages).mockRejectedValue(new Error('rest fallback failed'))

  const resume = await mountResume()
  await resume('stored-held', true)

  expect($resumeFailedSessionId.get()).toBeNull()
  expect($resumeExhaustedSessionId.get()).toBe('stored-held')

  const toast = $notifications.get().find(n => n.id === 'resume-failed:stored-held')
  expect(toast?.message).toBe(en.notifications.errors.runtimeCoordinationRequired)
  expect(toast?.action?.label).toBe(en.assistant.thread.errorStartNewSession)
})

// The history already paints, so the quiet re-attach would retry a refusal that cannot clear.
it('a lease refusal on a readable window does not arm the quiet re-attach', async () => {
  vi.mocked(getLatestSessionMessages).mockResolvedValue({
    messages: [
      { content: 'run the long job', role: 'user', timestamp: 1 },
      { content: 'started it', role: 'assistant', timestamp: 2 }
    ],
    session_id: 'stored-held'
  } as never)

  const resume = await mountResume()
  await resume('stored-held', true)

  expect($resumeReattachSessionId.get()).toBeNull()
  expect($resumeFailedSessionId.get()).toBeNull()
  expect($resumeExhaustedSessionId.get()).toBeNull()
  expect($notifications.get()[0]?.message).toBe(en.notifications.errors.runtimeCoordinationRequired)
})
