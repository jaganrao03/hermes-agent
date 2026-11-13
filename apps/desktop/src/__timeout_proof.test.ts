import { expect, test } from 'vitest'

// 21s sits between the old 15s budget and the new 45s one, so this passes only
// if the ui project's testTimeout really was raised.
test('ui project grants a 45s test timeout', async () => {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 21_000))
  expect(Date.now() - started).toBeGreaterThanOrEqual(20_500)
})
