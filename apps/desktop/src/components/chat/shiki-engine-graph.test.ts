import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The bare `shiki` package is the full bundle (~19 MB of grammars + themes).
// Only shiki/core, shiki/engine/javascript, shiki/langs/*, shiki/themes/* and
// type-only imports may appear; everything runs through shiki-engine.ts.
const chatDir = dirname(fileURLToPath(import.meta.url))

const RUNTIME_BARE_SHIKI = [
  /import\(\s*['"]shiki['"]\s*\)/,
  /^\s*import\s+(?!type\b)[^'"\n]*\bfrom\s+['"]shiki['"]/m,
  /^\s*import\s+['"]shiki['"]/m,
  /^\s*export\s+(?!type\b)[^'"\n]*\bfrom\s+['"]shiki['"]/m,
  /require\(\s*['"]shiki['"]\s*\)/
]

describe('chat module graph', () => {
  it('never imports the bare shiki package at runtime', () => {
    const offenders = readdirSync(chatDir)
      .filter(name => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))
      .filter(name => {
        const source = readFileSync(join(chatDir, name), 'utf8')

        return RUNTIME_BARE_SHIKI.some(pattern => pattern.test(source))
      })

    expect(offenders).toEqual([])
  })
})
