import { describe, expect, it } from 'vitest'

import { isOffPeak, providerOfModel } from './provider-offpeak'

// 2026-11-09 is a Monday. Times below are UTC.
const at = (iso: string) => new Date(iso)

describe('providerOfModel', () => {
  it('reads the provider off a bare model id', () => {
    expect(providerOfModel('deepseek-v4-flash')).toBe('deepseek')
  })

  it('reads the provider off a namespaced model id', () => {
    expect(providerOfModel('deepseek/deepseek-v4-pro')).toBe('deepseek')
    expect(providerOfModel('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4'.split('-')[0])
  })

  it('has no opinion about a missing model', () => {
    expect(providerOfModel(null)).toBeNull()
    expect(providerOfModel('')).toBeNull()
  })
})

describe('isOffPeak on DeepSeek', () => {
  it('is peak inside the morning window', () => {
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-09T01:00:00Z'))).toBe(false)
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-09T03:59:00Z'))).toBe(false)
  })

  it('is off-peak the minute the morning window closes', () => {
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-09T04:00:00Z'))).toBe(true)
  })

  it('is peak inside the afternoon window', () => {
    expect(isOffPeak('deepseek-v4-pro', at('2026-11-09T06:00:00Z'))).toBe(false)
    expect(isOffPeak('deepseek-v4-pro', at('2026-11-09T09:59:00Z'))).toBe(false)
  })

  it('is off-peak from 10:00 UTC on a weekday', () => {
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-09T10:00:00Z'))).toBe(true)
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-09T23:30:00Z'))).toBe(true)
  })

  it('is off-peak all weekend, peak hours or not', () => {
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-07T02:00:00Z'))).toBe(true)
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-08T08:00:00Z'))).toBe(true)
  })

  it('is off-peak on a Friday afternoon and stays off-peak into Saturday', () => {
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-13T12:00:00Z'))).toBe(true)
    expect(isOffPeak('deepseek-v4-flash', at('2026-11-14T02:00:00Z'))).toBe(true)
  })
})

describe('isOffPeak elsewhere', () => {
  it('never claims a discount for a provider it has no schedule for', () => {
    expect(isOffPeak('claude-sonnet-4', at('2026-11-09T02:00:00Z'))).toBe(false)
    expect(isOffPeak(null, at('2026-11-09T02:00:00Z'))).toBe(false)
  })
})
