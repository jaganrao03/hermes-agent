import { describe, expect, it } from 'vitest'

import { MAX_QUOTE_CHARS, quoteSelection } from './selection-quote'

describe('quoteSelection', () => {
  it('turns a selection into a markdown blockquote', () => {
    expect(quoteSelection('use a mutex')).toBe('> use a mutex')
  })

  it('quotes every line of a multi-line selection and drops blank edges', () => {
    expect(quoteSelection('\n  first line\n\nsecond line  \n')).toBe('> first line\n>\n> second line')
  })

  it('returns an empty string for a blank selection', () => {
    expect(quoteSelection('  \n\t ')).toBe('')
  })

  it('caps a very long selection with an ellipsis', () => {
    const quoted = quoteSelection('x'.repeat(MAX_QUOTE_CHARS + 500))

    expect(quoted.startsWith('> ')).toBe(true)
    expect(quoted.endsWith('…')).toBe(true)
    expect(quoted.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 3)
  })
})
