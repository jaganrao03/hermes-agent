import { beforeEach, describe, expect, it } from 'vitest'

import {
  $autoContinue,
  AUTO_CONTINUE_MAX,
  autoContinueSteps,
  bumpAutoContinue,
  canAutoContinue,
  endAutoContinueChain,
  normalizeSuggestion,
  repeatReason,
  resetAutoContinueChains,
  setAutoContinue,
  trioSignature
} from './auto-continue'

const TRIO_A = ['Run the tests', 'Show the diff', 'Commit the change']
const TRIO_B = ['Fix the failure', 'Re-run the suite', 'Commit the change']

beforeEach(() => {
  localStorage.clear()
  resetAutoContinueChains()
  setAutoContinue(false)
})

describe('auto-continue', () => {
  it('stays off until the user turns it on, and arms nothing across a reload', () => {
    expect($autoContinue.get()).toBe(false)
    expect(canAutoContinue('session-1')).toBe(false)

    setAutoContinue(true)
    expect($autoContinue.get()).toBe(true)
    expect(canAutoContinue('session-1')).toBe(true)
    // Nothing is written down: a reload must come back unarmed.
    expect(localStorage.getItem('hermes:auto-continue')).toBeNull()
  })

  it('stops a chain at the cap and disarms, so the next run takes a click', () => {
    setAutoContinue(true)

    for (let step = 1; step <= AUTO_CONTINUE_MAX; step += 1) {
      expect(canAutoContinue('session-1')).toBe(true)
      expect(bumpAutoContinue('session-1')).toBe(step)
    }

    expect(canAutoContinue('session-1')).toBe(false)
    expect(autoContinueSteps('session-1')).toBe(AUTO_CONTINUE_MAX)
    // The cap disarmed the switch, so no session continues on a spent chain.
    expect($autoContinue.get()).toBe(false)
    expect(canAutoContinue('session-2')).toBe(false)

    setAutoContinue(true)
    expect(canAutoContinue('session-1')).toBe(true)
    expect(autoContinueSteps('session-1')).toBe(0)
  })

  it('disarms when a chain ends, so continuing always takes another click', () => {
    setAutoContinue(true)
    bumpAutoContinue('session-1')
    endAutoContinueChain('session-1')

    expect(canAutoContinue('session-1')).toBe(false)
    expect($autoContinue.get()).toBe(false)
    expect(canAutoContinue('session-2')).toBe(false)
  })
})

describe('repeat-stop guard', () => {
  it('lets a step that moves forward through, then blocks the same step twice', () => {
    setAutoContinue(true)

    expect(repeatReason('session-1', TRIO_A[0], TRIO_A)).toBeNull()
    bumpAutoContinue('session-1', { text: TRIO_A[0], suggestions: TRIO_A })

    // Next turn offers a fresh trio whose first chip is new work.
    expect(repeatReason('session-1', TRIO_B[0], TRIO_B)).toBeNull()
  })

  it('stops when the suggestion text comes back, however it is punctuated', () => {
    setAutoContinue(true)
    bumpAutoContinue('session-1', { text: 'Run the tests', suggestions: TRIO_A })

    expect(repeatReason('session-1', 'run the tests.', TRIO_B)).toBe('same-step')
    expect(repeatReason('session-1', '  RUN   the tests!  ', TRIO_B)).toBe('same-step')
    expect(repeatReason('session-1', '"Run the tests"', TRIO_B)).toBe('same-step')
  })

  it('stops when the trio itself is unchanged, even if the chip wording differs from the last one sent', () => {
    setAutoContinue(true)
    bumpAutoContinue('session-1', { text: 'Something else entirely', suggestions: TRIO_A })

    expect(repeatReason('session-1', 'Show the diff', TRIO_A)).toBe('same-suggestions')
  })

  it('keeps separate chains per session and starts clean after the preference toggles', () => {
    setAutoContinue(true)
    bumpAutoContinue('session-1', { text: TRIO_A[0], suggestions: TRIO_A })

    expect(repeatReason('session-2', TRIO_A[0], TRIO_A)).toBeNull()

    setAutoContinue(false)
    setAutoContinue(true)
    expect(repeatReason('session-1', TRIO_A[0], TRIO_A)).toBeNull()
  })

  it('normalises only what means the same thing', () => {
    expect(normalizeSuggestion('  Commit   the change.  ')).toBe('commit the change')
    expect(normalizeSuggestion('“Ship it!”')).toBe('ship it')
    expect(normalizeSuggestion('Ship it later')).toBe('ship it later')
    expect(trioSignature(TRIO_A)).toBe('run the tests | show the diff | commit the change')
  })

  it('records each step once, so a chain cannot pass the guard by re-sending', () => {
    setAutoContinue(true)

    // The first send is new work; every later attempt at the same chip is a repeat.
    expect(repeatReason('session-1', TRIO_A[0], TRIO_A)).toBeNull()
    bumpAutoContinue('session-1', { text: TRIO_A[0], suggestions: TRIO_A })

    for (let step = 1; step < AUTO_CONTINUE_MAX; step += 1) {
      expect(repeatReason('session-1', TRIO_A[0], TRIO_A)).toBe('same-step')
      bumpAutoContinue('session-1', { text: TRIO_A[0], suggestions: TRIO_A })
    }

    expect(autoContinueSteps('session-1')).toBe(AUTO_CONTINUE_MAX)
    expect(canAutoContinue('session-1')).toBe(false)
  })
})
