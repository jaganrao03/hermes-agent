import { describe, expect, it } from 'vitest'

import { buildFollowupContext, parseFollowupSuggestions } from './follow-up-suggestions'

describe('buildFollowupContext', () => {
  it('keeps recent user and assistant text while excluding tool messages', () => {
    expect(buildFollowupContext([
      { role: 'user', content: [{ type: 'text', text: 'Explain this' }] },
      { role: 'tool', content: [{ type: 'text', text: 'internal result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the explanation.' }] }
    ])).toBe('user: Explain this\nassistant: Here is the explanation.')
  })
})

describe('parseFollowupSuggestions', () => {
  it('keeps up to three distinct, trimmed, bounded strings from a JSON array', () => {
    expect(parseFollowupSuggestions(JSON.stringify(['  Explain this  ', 'Show an example', 'Explain this', '', 4, 'x'.repeat(121)]))).toEqual([
      'Explain this',
      'Show an example'
    ])
  })

  it('fails closed for malformed or non-array output', () => {
    expect(parseFollowupSuggestions('not json')).toEqual([])
    expect(parseFollowupSuggestions('{"suggestions":["one"]}')).toEqual([])
  })
})
