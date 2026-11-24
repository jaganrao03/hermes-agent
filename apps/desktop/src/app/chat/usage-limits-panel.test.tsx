import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UsageLimitsPanel } from './usage-limits-panel'

const api = vi.fn()

beforeEach(() => {
  api.mockReset()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api }
})

afterEach(cleanup)

const row = (over = {}) => ({
  provider: 'x', name: 'X', title: null, plan: null, source: null, fetched_at: null,
  windows: [], details: [], unavailable_reason: null, state: 'ready', ...over
})

describe('UsageLimitsPanel', () => {
  it('renders a window bar and a dollar balance', async () => {
    api.mockResolvedValue({
      providers: [
        row({ provider: 'openai-codex', name: 'Codex', plan: 'Plus', windows: [
          { label: 'Weekly', used_percent: 30, remaining_percent: 70, resets_at: null, detail: null, scope: 'account' }] }),
        row({ provider: 'deepseek', name: 'DeepSeek', details: ['Balance: $12.50'] })
      ]
    })
    render(<UsageLimitsPanel />)
    expect(await screen.findByText('70% left')).toBeTruthy()
    expect(screen.getByText('Balance: $12.50')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: /Codex Weekly: 70% left/ })).toBeTruthy()
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/usage/limits' }))
  })

  it('says so when nothing reports, and when the request fails', async () => {
    api.mockResolvedValueOnce({ providers: [row({ state: 'unavailable', unavailable_reason: 'no usage data' })] })
    render(<UsageLimitsPanel />)
    expect(await screen.findByText(/No provider is reporting/)).toBeTruthy()
    cleanup()
    api.mockRejectedValueOnce(new Error('down'))
    render(<UsageLimitsPanel />)
    expect(await screen.findByText(/Could not read limits/)).toBeTruthy()
  })

  it('refresh button asks the server to bypass its cache', async () => {
    api.mockResolvedValue({ providers: [] })
    render(<UsageLimitsPanel />)
    await screen.findByText(/No provider is reporting/)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh limits' }))
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/api/usage/limits?refresh=1' }))
    )
  })
})
