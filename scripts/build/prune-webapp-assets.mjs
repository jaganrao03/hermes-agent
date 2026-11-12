// Prune the chunks a Webapp build did not name.
//
// Vite empties the output directory, so a fresh generation holds only its own files plus what
// ``keepPreviousGeneration`` copied for tabs opened against the previous generation. Anything else
// under ``assets/`` is a leftover (an interrupted build, a hand-copied bundle) and is dead weight:
// nothing links to it, yet it keeps serving under a stable name if a stale index.html is cached.
//
// The manifest is the authority, and it names files in more than one place: an entry's ``file``, the
// ``css`` and ``assets`` lists a chunk pulls in, and ``imports``/``dynamicImports`` — which are chunk
// names that must be mapped back to files. Pruning on ``file`` alone deletes live stylesheets and
// worker scripts, so every one of those lists is read here.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Build outputs are content-hashed. An unrecognized name is left alone: the step removes known
// garbage, never anything it cannot classify.
const buildOutput = /^[A-Za-z0-9._-]+\.(?:js|css|map)$/

/** Every file name the manifest names, as it appears under the output directory. */
export function manifestFiles(manifest) {
  const entries = Object.values(manifest ?? {}).filter(entry => entry && typeof entry === 'object')
  const nameToFile = new Map()
  for (const entry of entries) {
    if (typeof entry.name === 'string' && typeof entry.file === 'string') nameToFile.set(entry.name, entry.file)
  }
  const names = new Set()
  const add = value => {
    if (typeof value !== 'string' || !value) return
    const name = value.replace(/^\.\//, '')
    // A chunk name is mapped to its file; a bare file name is already one.
    names.add(nameToFile.get(name) ?? name)
  }
  for (const entry of entries) {
    add(entry.file)
    for (const list of [entry.css, entry.assets]) if (Array.isArray(list)) list.forEach(add)
    for (const list of [entry.imports, entry.dynamicImports]) if (Array.isArray(list)) list.forEach(add)
  }
  return names
}

/**
 * Remove output files under ``assets/`` that the manifest does not name and ``keep`` does not retain.
 *
 * Only regular files directly inside ``assets/`` are considered: no recursion, no directories, no
 * symlinks. A product without both ``index.html`` and its manifest is refused rather than guessed at.
 */
export function pruneStaleAssets({ product, manifestName = 'renderer-manifest.json', keep = new Set(), dryRun = false } = {}) {
  if (!product) throw new Error('A built product directory is required')
  const root = resolve(product)
  const manifestPath = join(root, manifestName)
  if (!existsSync(join(root, 'index.html')) || !existsSync(manifestPath)) {
    return { removed: [], refused: 'no index.html or no manifest' }
  }
  const retained = new Set([...keep].map(name => String(name).split(/[\\/]/).pop()))
  const named = new Set([...manifestFiles(JSON.parse(readFileSync(manifestPath, 'utf8')))]
    .map(name => String(name).split(/[\\/]/).pop()))
  const removed = []
  for (const entry of readdirSync(join(root, 'assets'), { withFileTypes: true })) {
    if (!entry.isFile() || !buildOutput.test(entry.name)) continue
    if (named.has(entry.name) || retained.has(entry.name)) continue
    if (!dryRun) rmSync(join(root, 'assets', entry.name), { force: true })
    removed.push(entry.name)
  }
  return { removed, kept: retained?.size ?? 0 }
}
