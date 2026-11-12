import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { manifestFiles, pruneStaleAssets } from '../scripts/build/prune-webapp-assets.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'webapp-prune-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a product: index.html, the manifest, and the assets a test names. */
function product(assets, manifest) {
  writeFileSync(join(root, 'index.html'), '')
  mkdirSync(join(root, 'assets'), { recursive: true })
  for (const name of assets) writeFileSync(join(root, 'assets', name), '')
  if (manifest) writeFileSync(join(root, 'renderer-manifest.json'), JSON.stringify(manifest))
}

const removed = options => pruneStaleAssets({ product: root, ...options }).removed.sort()

test('keeps every file the manifest names in any list, and removes the rest', () => {
  product(
    ['main-a.js', 'lazy-a.css', 'worker-a.js', 'orphan-b.js'],
    { 'src/main.tsx': { file: 'assets/main-a.js', css: ['assets/lazy-a.css'], assets: ['assets/worker-a.js'] } },
  )
  expect(removed()).toEqual(['orphan-b.js'])
  expect(existsSync(join(root, 'assets/worker-a.js'))).toBe(true)
  expect(existsSync(join(root, 'assets/lazy-a.css'))).toBe(true)
})

test('maps chunk names in imports and dynamicImports back to the files they emitted', () => {
  const manifest = {
    'index.html': { file: 'assets/index-a.js', imports: ['shared'], dynamicImports: ['lazy'] },
    'src/shared.ts': { file: 'assets/shared-b.js', name: 'shared' },
    'src/lazy.ts': { file: 'assets/lazy-c.js', name: 'lazy', isDynamicEntry: true },
  }
  expect([...manifestFiles(manifest)].sort()).toEqual([
    'assets/index-a.js', 'assets/lazy-c.js', 'assets/shared-b.js',
  ])
})

test('a retained chunk from the previous generation survives, and dryRun removes nothing', () => {
  product(['main-a.js', 'retained-d.js', 'stale-e.js'], { 'src/main.tsx': { file: 'assets/main-a.js' } })
  expect(removed({ keep: ['assets/retained-d.js'], dryRun: true })).toEqual(['stale-e.js'])
  expect(existsSync(join(root, 'assets/stale-e.js'))).toBe(true)

  expect(removed({ keep: ['assets/retained-d.js'] })).toEqual(['stale-e.js'])
  expect(existsSync(join(root, 'assets/retained-d.js'))).toBe(true)
  expect(existsSync(join(root, 'assets/stale-e.js'))).toBe(false)
})

test('leaves directories and names it cannot classify alone, and refuses a product without a manifest', () => {
  product(['main-a.js'], { 'src/main.tsx': { file: 'assets/main-a.js' } })
  mkdirSync(join(root, 'assets/nested'))
  writeFileSync(join(root, 'assets/notes.txt'), '')
  expect(removed()).toEqual([])
  expect(existsSync(join(root, 'assets/nested'))).toBe(true)
  expect(existsSync(join(root, 'assets/notes.txt'))).toBe(true)

  rmSync(join(root, 'renderer-manifest.json'))
  expect(pruneStaleAssets({ product: root }))
    .toMatchObject({ removed: [], refused: 'no index.html or no manifest' })
  expect(existsSync(join(root, 'assets/main-a.js'))).toBe(true)
})

test('a product directory that was never built is refused, not created', () => {
  const missing = join(root, 'never-built')
  expect(pruneStaleAssets({ product: missing }))
    .toMatchObject({ removed: [], refused: 'no index.html or no manifest' })
  expect(existsSync(missing)).toBe(false)
})
