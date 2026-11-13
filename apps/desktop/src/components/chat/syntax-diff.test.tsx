import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import SyntaxDiff from '@/components/chat/syntax-diff'

afterEach(cleanup)

describe('SyntaxDiff', () => {
  it('renders a dual-theme pre with a diff-tinted row per line and the code intact', async () => {
    const lines = [
      { kind: 'context' as const, text: 'const a = 1' },
      { kind: 'remove' as const, text: 'const b = 2' },
      { kind: 'add' as const, text: 'const b = 3' }
    ]

    const { container } = render(<SyntaxDiff language="ts" lines={lines} />)

    await waitFor(() => expect(container.querySelector('span.line')).not.toBeNull())

    const rows = container.querySelectorAll('span.line')

    expect(rows).toHaveLength(3)
    expect(Array.from(rows).map(row => row.textContent)).toEqual(lines.map(line => line.text))
    expect(rows[1].className).not.toBe(rows[2].className)
    expect(container.querySelector('span[style*="light-dark("]')).not.toBeNull()
  })

  it('still tints rows for an unknown language', async () => {
    const { container } = render(<SyntaxDiff language="brainfuck" lines={[{ kind: 'add', text: '+++' }]} />)

    await waitFor(() => expect(container.querySelector('span.line')).not.toBeNull())
    expect(container.querySelector('span.line')?.textContent).toBe('+++')
  })
})
