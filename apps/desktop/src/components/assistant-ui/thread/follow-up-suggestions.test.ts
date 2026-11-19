import { describe, expect, it } from 'vitest'

import { parseNextPromptSuggestion } from './follow-up-suggestions'

describe('parseNextPromptSuggestion', () => {
  it('returns a trimmed, bounded cached suggestion from the plugin response', () => {
    expect(parseNextPromptSuggestion({ suggestion: { text: '  Show an example  ' } })).toBe('Show an example')
    expect(parseNextPromptSuggestion({ suggestion: { text: 'x'.repeat(121) } })).toBe('')
  })

  it('returns empty when the plugin has no suggestion or an invalid response', () => {
    expect(parseNextPromptSuggestion({ suggestion: null })).toBe('')
    expect(parseNextPromptSuggestion({})).toBe('')
    expect(parseNextPromptSuggestion(null)).toBe('')
  })
})
