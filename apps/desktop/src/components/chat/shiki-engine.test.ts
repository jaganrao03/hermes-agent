import { describe, expect, it } from 'vitest'

import { highlightToTokens, resolveLanguage } from '@/components/chat/shiki-engine'

describe('resolveLanguage', () => {
  it('resolves curated ids and aliases case-insensitively', () => {
    expect(resolveLanguage('typescript')).toBe('typescript')
    expect(resolveLanguage('TS')).toBe('typescript')
    expect(resolveLanguage('zsh')).toBe('bash')
  })

  it('falls back to text for unknown languages, including prototype keys', () => {
    expect(resolveLanguage('brainfuck')).toBe('text')
    expect(resolveLanguage('')).toBe('text')
    expect(resolveLanguage('constructor')).toBe('text')
  })
})

describe('highlightToTokens', () => {
  it('returns one plain token row per line for an unknown language', async () => {
    const rows = await highlightToTokens('a\nb', 'brainfuck', 'github-dark-dimmed')

    expect(rows.map(row => row.map(t => t.content).join(''))).toEqual(['a', 'b'])
  })

  it('tokenizes a curated language with the real engine', async () => {
    const rows = await highlightToTokens('const x = 1', 'ts', 'github-dark-dimmed')

    expect(rows).toHaveLength(1)
    expect(rows[0].map(t => t.content).join('')).toBe('const x = 1')
    expect(rows[0].length).toBeGreaterThan(1)
  })
})
