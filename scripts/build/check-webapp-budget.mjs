// Size budget for a built Webapp product. A single oversized chunk (the full shiki bundle was 19 MB)
// is paid by every phone that opens a chat with a code block, so the build fails instead of shipping it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MB = 1024 * 1024

export const budget = Object.freeze({
  maxAssetBytes: 4 * MB,
  maxAssetsJsBytes: 14 * MB,
  maxProductBytes: 16 * MB,
})

const mb = bytes => `${(bytes / MB).toFixed(2)} MB`

/**
 * Product-relative paths the current build links to: every manifest ``file`` and every entry of
 * ``assets``/``css``/``imports``/``dynamicImports`` (chunk keys map back to their files), plus
 * ``index.html`` and every local file it links. Anything else under ``assets/`` is a
 * retained previous-generation file or a leftover; nothing links to it, so it is not measured.
 */
function referencedPaths(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'renderer-manifest.json'), 'utf8'))
  const entries = Object.entries(manifest ?? {}).filter(([, entry]) => entry && typeof entry === 'object')
  const keyToFile = new Map(entries.map(([key, entry]) => [key, entry.file]))
  const paths = new Set(['index.html'])
  const add = value => {
    if (typeof value !== 'string' || !value) return
    const path = value.replace(/^\.?\//, '')
    paths.add(keyToFile.get(path) ?? path)
  }
  for (const [, entry] of entries) {
    add(entry.file)
    for (const list of [entry.assets, entry.css, entry.imports, entry.dynamicImports]) {
      if (Array.isArray(list)) list.forEach(add)
    }
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  for (const [, url] of html.matchAll(/(?:href|src)=["']\.?\/?([^"'#?/:][^"'#?:]*)["']/g)) {
    paths.add(url)
  }
  return paths
}

/** Budget violations (human-readable strings) for a built product directory; empty when within budget. */
export function checkWebappBudget({ product, limits = budget } = {}) {
  if (!product) throw new Error('A built product directory is required')
  const root = resolve(product)
  if (!existsSync(root)) throw new Error(`No built product at ${root}`)
  const violations = []
  let js = 0
  let total = 0
  for (const path of [...referencedPaths(root)].sort()) {
    const file = join(root, path)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    const size = statSync(file).size
    total += size
    if (path.endsWith('.js')) js += size
    if (size > limits.maxAssetBytes) {
      violations.push(`${path} is ${mb(size)}, over the ${mb(limits.maxAssetBytes)} per-file limit`)
    }
  }
  if (js > limits.maxAssetsJsBytes) {
    violations.push(`referenced js total ${mb(js)}, over the ${mb(limits.maxAssetsJsBytes)} limit`)
  }
  if (total > limits.maxProductBytes) {
    violations.push(`product total ${mb(total)}, over the ${mb(limits.maxProductBytes)} limit`)
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkWebappBudget({ product: process.argv[2] ?? 'apps/desktop/dist-webapp' })
  for (const violation of violations) console.error(`webapp budget: ${violation}`)
  process.exit(violations.length ? 1 : 0)
}
