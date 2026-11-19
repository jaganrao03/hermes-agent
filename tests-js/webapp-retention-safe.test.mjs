import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preserveWebappAssets } from '../scripts/build/webapp.mjs'

const root = mkdtempSync(join(tmpdir(), 'webapp-retention-safe-'))
process.chdir(root) // Preserve every test artifact; no cleanup or deletion.
const put = (dir, name, data) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), data) }

test('retains inherited assets across multiple generations without a receipt', () => {
  const first = join(root, 'first'); const second = join(root, 'second'); const third = join(root, 'third')
  put(first, 'assets/old/chunk.js', 'old'); put(first, 'assets/first.css', 'first')
  put(second, 'assets/new.js', 'new'); put(third, 'assets/third.js', 'third')
  preserveWebappAssets(first, second); preserveWebappAssets(second, third)
  assert.equal(readFileSync(join(third, 'assets/old/chunk.js'), 'utf8'), 'old')
  assert.equal(readFileSync(join(third, 'assets/first.css'), 'utf8'), 'first')
  assert.equal(readFileSync(join(third, 'assets/new.js'), 'utf8'), 'new')
})

test('refuses a conflicting asset rather than replacing either version', () => {
  const old = join(root, 'conflict-old'); const next = join(root, 'conflict-next')
  put(old, 'assets/same.js', 'old'); put(next, 'assets/same.js', 'new')
  assert.throws(() => preserveWebappAssets(old, next), /conflict/i)
  assert.equal(readFileSync(join(old, 'assets/same.js'), 'utf8'), 'old')
  assert.equal(readFileSync(join(next, 'assets/same.js'), 'utf8'), 'new')
})

test('refuses symbolic links instead of following them', () => {
  const old = join(root, 'link-old'); const next = join(root, 'link-next')
  put(old, 'assets/target.js', 'safe'); mkdirSync(join(next, 'assets'), { recursive: true })
  symlinkSync(join(old, 'assets/target.js'), join(old, 'assets/link.js'))
  assert.throws(() => preserveWebappAssets(old, next), /symlink/i)
})
