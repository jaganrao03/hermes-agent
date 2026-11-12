import { describe, expect, it } from 'vitest'

import { parseNextPromptSuggestions } from './follow-up-suggestions'

describe('parseNextPromptSuggestions', () => {
  it('returns distinct, trimmed, bounded suggestions from the plugin response', () => {
    expect(parseNextPromptSuggestions({ suggestions: [
      { text: '  Show an example  ' },
      { text: 'Explain the tradeoffs' },
      { text: 'Show an example' },
      { text: 'x'.repeat(121) }
    ] })).toEqual(['Show an example', 'Explain the tradeoffs'])
  })

  it('uses the singular field for older plugin versions and handles invalid responses', () => {
    expect(parseNextPromptSuggestions({ suggestion: { text: '  Show an example  ' } })).toEqual(['Show an example'])
    expect(parseNextPromptSuggestions({ suggestions: [], suggestion: null })).toEqual([])
    expect(parseNextPromptSuggestions({})).toEqual([])
    expect(parseNextPromptSuggestions(null)).toEqual([])
  })

  it('drops a cached row generated before the latest user turn', () => {
    expect(parseNextPromptSuggestions({
      suggestions: [
        { text: 'From the previous turn', timestamp: 1_700_000_000 },
        { text: 'From this turn', timestamp: 1_700_000_120 }
      ]
    }, 1_700_000_100)).toEqual(['From this turn'])
  })

  it('drops a previous turn row even when it is only seconds old', () => {
    // Production shape: the stored row is always recent, so a "younger than a
    // day" allowance made every new reply show the previous reply's chips.
    const now = Math.floor(Date.now() / 1000)

    expect(parseNextPromptSuggestions({
      suggestions: [{ text: 'Chips from the reply above', timestamp: now - 60 }]
    }, now)).toEqual([])
  })

  it('keeps a row written after the latest user turn but drops the older one beside it', () => {
    const now = Math.floor(Date.now() / 1000)

    expect(parseNextPromptSuggestions({
      suggestions: [
        { text: 'Stale chips', timestamp: now - 60 },
        { text: 'This turn chips', timestamp: now + 5 }
      ]
    }, now)).toEqual(['This turn chips'])
  })

  it('fails closed on a timestamp-less row when the turn time is known', () => {
    expect(parseNextPromptSuggestions({ suggestions: [{ text: 'No timestamp' }] }, 1_700_000_100)).toEqual([])
  })

  it('keeps every row when the turn time is unknown', () => {
    expect(parseNextPromptSuggestions({ suggestions: [{ text: 'No turn time' }] })).toEqual(['No turn time'])
  })
})
