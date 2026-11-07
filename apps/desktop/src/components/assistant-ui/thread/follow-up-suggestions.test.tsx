import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { requestGatewayForAgent } from '@/store/gateway'

import { FollowUpSuggestions } from './follow-up-suggestions'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerSubmit: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: vi.fn() }))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(requestComposerSubmit).mockReset()
  vi.mocked(requestGatewayForAgent).mockReset()
  vi.mocked(requestGatewayForAgent).mockImplementation(async () => ({
    text: JSON.stringify(['Show an example', 'Explain the tradeoffs', 'Suggest a next step'])
  } as never))
})

describe('FollowUpSuggestions', () => {
  it('renders generated suggestions and submits the selected prompt to its composer', async () => {
    render(<FollowUpSuggestions context="user: Explain this\nassistant: Here is the answer." responseId="reply-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show an example' }))

    expect(requestComposerSubmit).toHaveBeenCalledWith('Show an example', { target: 'main' })
  })
})
