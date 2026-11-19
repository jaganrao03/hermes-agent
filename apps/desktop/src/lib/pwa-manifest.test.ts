import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseShareTarget } from './share-target'

const publicDir = resolve(__dirname, '../../public')
const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8'))
// Where the installed app lives; every manifest URL resolves against the manifest's own URL.
const manifestUrl = 'https://hermes.example.ts.net/manifest.webmanifest'
const scope = new URL(manifest.scope, manifestUrl)

describe('webapp manifest', () => {
  it('ships every icon it names', () => {
    for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)]) {
      expect(existsSync(resolve(publicDir, (icon as { src: string }).src)), (icon as { src: string }).src).toBe(true)
    }
  })

  it('keeps every shortcut inside the app scope and opens a hash route', () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(0)

    for (const shortcut of manifest.shortcuts) {
      const url = new URL(shortcut.url, manifestUrl)

      expect(url.href.startsWith(scope.href)).toBe(true)
      expect(url.hash.startsWith('#/')).toBe(true)
      expect(shortcut.name).toBeTruthy()
    }
  })

  it('declares a GET share target the in-app handler understands', () => {
    const target = manifest.share_target

    expect(target.method).toBe('GET')

    // What the browser builds for a share: the action URL plus the mapped params.
    const url = new URL(target.action, manifestUrl)
    expect(url.href.startsWith(scope.href)).toBe(true)
    url.searchParams.set(target.params.title, 'Release notes')
    url.searchParams.set(target.params.text, 'Worth a read')
    url.searchParams.set(target.params.url, 'https://example.com/n')

    expect(parseShareTarget(url.search)?.text).toBe('Release notes\nWorth a read\nhttps://example.com/n')
  })
})
