import { describe, expect, it } from 'vitest'

import { parseFollowupSuggestions } from './follow-up-suggestions'

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
