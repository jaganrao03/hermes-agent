import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { turnAwaitsUser, turnLooksDone } from './turn-completion-gate'

const user = (text = 'do the thing'): ChatMessage => ({
  id: `u-${text}`,
  parts: [{ text, type: 'text' }],
  role: 'user'
})

const assistant = (text: string): ChatMessage => ({
  id: `a-${text}`,
  parts: [{ text, type: 'text' }],
  role: 'assistant'
})

describe('turnLooksDone', () => {
  it('lights for a normal reply', () => {
    expect(turnLooksDone({ messages: [user(), assistant('done — two files edited')] })).toBe(true)
  })

  it('lights for an artifact-only reply (no text, but something to open)', () => {
    const media: ChatMessage = { id: 'a-media', parts: [{ type: 'image' } as never], role: 'assistant' }

    expect(turnLooksDone({ messages: [user(), media] })).toBe(true)
  })

  it('stays quiet when the user cancelled the turn themselves', () => {
    expect(turnLooksDone({ interrupted: true, messages: [user(), assistant('partial')] })).toBe(false)
  })

  it('stays quiet when a clarify/approval is parked — the amber dot owns the row', () => {
    expect(turnLooksDone({ messages: [user(), assistant('Which account?')], needsInput: true })).toBe(false)
  })

  it('stays quiet when the turn ended with a prompt row and no reply at all', () => {
    expect(turnLooksDone({ messages: [user('please run the audit')] })).toBe(false)
  })

  it('stays quiet for a failure card with no readable content', () => {
    const failed: ChatMessage = { error: 'HTTP 500', id: 'a-fail', parts: [], role: 'assistant' }

    expect(turnLooksDone({ messages: [user(), failed] })).toBe(false)
  })

  it('still lights when a failed turn left a partial answer to read', () => {
    const failed: ChatMessage = { error: 'HTTP 500', id: 'a-fail', parts: [{ text: 'half an answer', type: 'text' }], role: 'assistant' }

    expect(turnLooksDone({ messages: [user(), failed] })).toBe(true)
  })

  it('keeps the old behaviour when there is no transcript to judge', () => {
    expect(turnLooksDone({ messages: [] })).toBe(true)
    expect(turnLooksDone({})).toBe(true)
  })

  it('ignores hidden rows when looking for the reply', () => {
    const hidden: ChatMessage = { id: 'a-hidden', parts: [{ text: 'internal', type: 'text' }], role: 'assistant' }
    Object.assign(hidden, { hidden: true })

    expect(turnLooksDone({ messages: [user(), hidden] })).toBe(false)
  })

  it('reads only the LAST turn — an older answered turn does not cover an empty one', () => {
    expect(turnLooksDone({ messages: [user('first'), assistant('reply'), user('second')] })).toBe(false)
  })
})

describe('turnAwaitsUser', () => {
  it('is true only while a prompt is parked', () => {
    expect(turnAwaitsUser({ needsInput: true })).toBe(true)
    expect(turnAwaitsUser({})).toBe(false)
  })
})
