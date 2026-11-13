// Unit tests for the Webapp bundle budget.
//
//   node --test scripts/build/check-webapp-budget.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkWebappBudget } from './check-webapp-budget.mjs'

const MB = 1024 * 1024

/**
 * Build a product: ``files`` are written at the given sizes; ``manifest`` is the renderer manifest
 * (default: one entry naming every ``assets/*`` file in ``files`` as its ``file``).
 */
function product(files, manifest, html = '<html></html>') {
  const root = mkdtempSync(join(tmpdir(), 'webapp-budget-'))
  mkdirSync(join(root, 'assets'))
  for (const [name, size] of Object.entries(files)) writeFileSync(join(root, name), Buffer.alloc(size))
  const named = Object.keys(files).filter(name => name.startsWith('assets/'))
  const entries = manifest ?? Object.fromEntries(named.map(name => [`src/${name}`, { file: name }]))
  writeFileSync(join(root, 'renderer-manifest.json'), JSON.stringify(entries))
  writeFileSync(join(root, 'index.html'), html)
  return root
}

function check(files, { limits, manifest, html } = {}) {
  const root = product(files, manifest, html)
  try {
    return checkWebappBudget({ product: root, limits })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a small product has no violations', () => {
  assert.deepEqual(check({ 'assets/app.js': MB, 'assets/app.css': 1000 }), [])
})

test('a single referenced asset over 4 MB is named', () => {
  const violations = check({ 'assets/shiki-abc.js': 5 * MB })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /assets\/shiki-abc\.js .*per-file limit/)
})

test('a referenced asset of exactly 4 MB passes', () => {
  assert.deepEqual(check({ 'assets/edge.js': 4 * MB }), [])
})

test('a retained orphan the manifest does not name is not counted', () => {
  const files = { 'assets/app.js': MB, 'assets/old-shiki.js': 19 * MB }
  const manifest = { 'src/app.ts': { file: 'assets/app.js' } }
  assert.deepEqual(check(files, { manifest }), [])
})

test('files named only through css/assets/imports/dynamicImports are counted', () => {
  const files = {
    'assets/entry.js': 100,
    'assets/lazy.js': 100,
    'assets/style.css': 5 * MB,
    'assets/font.woff2': 5 * MB,
    'assets/dep.js': 5 * MB
  }
  const manifest = {
    'src/entry.ts': {
      file: 'assets/entry.js',
      css: ['assets/style.css'],
      assets: ['assets/font.woff2'],
      imports: ['src/dep.ts'],
      dynamicImports: ['src/lazy.ts']
    },
    'src/dep.ts': { file: 'assets/dep.js' },
    'src/lazy.ts': { file: 'assets/lazy.js' }
  }
  const violations = check(files, { manifest })
  assert.deepEqual(
    violations.filter(v => v.includes('per-file')).map(v => v.split(' ')[0]).sort(),
    ['assets/dep.js', 'assets/font.woff2', 'assets/style.css']
  )
})

test('many referenced scripts over 14 MB in total violate the js budget', () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`assets/c${i}.js`, 1.9 * MB]))
  const violations = check(files)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /referenced js total/)
})

test('non-js assets do not count toward the js budget', () => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`assets/f${i}.woff2`, 1.9 * MB]))
  assert.deepEqual(check(files), [])
})

test('files index.html links count toward the product total', () => {
  const html = '<link href="./big.bin"><link href="https://cdn.example/x.js">'
  const violations = check({ 'big.bin': 3 * MB }, { html, limits: { maxAssetBytes: 4 * MB, maxAssetsJsBytes: 12 * MB, maxProductBytes: 2 * MB } })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /product total/)
})

test('unreferenced top-level files are ignored', () => {
  assert.deepEqual(check({ 'big.bin': 21 * MB }), [])
})

test('a missing product directory throws', () => {
  assert.throws(() => checkWebappBudget({ product: join(tmpdir(), 'webapp-budget-nope') }), /No built product/)
})
