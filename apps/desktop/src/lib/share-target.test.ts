import { describe, expect, it } from 'vitest'

import { MAX_SHARED_CHARS, parseShareTarget } from './share-target'

describe('parseShareTarget', () => {
  it('joins title, text and url the way Android fills them', () => {
    const shared = parseShareTarget('?share-target=1&title=Release%20notes&text=Worth%20a%20read&url=https%3A%2F%2Fexample.com%2Fn')

    expect(shared?.text).toBe('Release notes\nWorth a read\nhttps://example.com/n')
  })

  it('does not repeat a url Android already put in the text', () => {
    const shared = parseShareTarget('?share-target=1&text=See%20https%3A%2F%2Fexample.com%2Fn&url=https%3A%2F%2Fexample.com%2Fn')

    expect(shared?.text).toBe('See https://example.com/n')
  })

  it('ignores a query that did not come from the share sheet', () => {
    expect(parseShareTarget('?text=hello')).toBeNull()
    expect(parseShareTarget('')).toBeNull()
  })

  it('treats an empty share as nothing to hand off', () => {
    expect(parseShareTarget('?share-target=1&title=%20&text=')).toBeNull()
  })

  it('caps what one share can drop into the composer', () => {
    const shared = parseShareTarget(`?share-target=1&text=${'a'.repeat(MAX_SHARED_CHARS + 50)}`)

    expect(shared?.text).toHaveLength(MAX_SHARED_CHARS)
  })

  it('reports the remaining query so the caller can strip only the share params', () => {
    const shared = parseShareTarget('?win=main&share-target=1&text=hi')

    expect(shared?.rest).toBe('?win=main')
  })
})
