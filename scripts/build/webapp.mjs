#!/usr/bin/env node
// Pure browser-renderer compilation. The workspace is prepared by the caller
// (apps/desktop/scripts/build-webapp.mjs); the receipt certifies the checkout.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productOutput, withProduct, workspaceTool } from './frontend-common.mjs'
import { buildInputs, outputIntact, recordProduct, sourceHash } from './freshness.mjs'
import { checkWebappBudget } from './check-webapp-budget.mjs'
import { pruneStaleAssets } from './prune-webapp-assets.mjs'

// Vite's build manifest (apps/desktop/vite.config.ts names it too): the files a generation emitted.
const manifestName = 'renderer-manifest.json'

// The build still publishes; say why open tabs of the previous generation may miss this chunk.
const notKept = (from, error) =>
  console.warn(`webapp: could not keep ${from} for tabs on the previous generation (${error?.code ?? error})`)

/** Keep in ``next`` the lazy chunks an open tab of the previous generation still loads: only missing
 *  regular files from a generation intact against its receipt, never through a symlink or over a file.
 *  A manifest omits the chunks its generation inherited, so retention stays one generation back. */
export function keepPreviousGeneration(previous, next) {
  let root
  let chunks
  try {
    if (!outputIntact(previous, 'webapp')) return []
    root = realpathSync(previous)
    chunks = Object.values(JSON.parse(readFileSync(join(previous, manifestName), 'utf8')) ?? {})
  } catch {
    return [] // no previous generation, or one without a manifest
  }
  const list = value => (Array.isArray(value) ? value : [])
  const names = new Set(chunks.flatMap(chunk => [chunk?.file, ...list(chunk?.css), ...list(chunk?.assets)]))
  const kept = []
  for (const name of names) {
    if (typeof name !== 'string' || !name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) continue
    const from = join(previous, name)
    const to = join(next, name)
    try {
      // A symlink anywhere on the way would resolve elsewhere than the name it was listed under.
      if (existsSync(to) || !lstatSync(from).isFile() || relative(root, realpathSync(from)) !== join(name)) continue
    } catch {
      continue // missing, or not a name this filesystem can hold
    }
    try {
      mkdirSync(dirname(to), { recursive: true })
    } catch (error) {
      // Quiet when a new file stands where the name's directory would go.
      if (!['EEXIST', 'ENOTDIR'].includes(error?.code)) notKept(from, error)
      continue
    }
    try {
      copyFileSync(from, to, constants.COPYFILE_EXCL)
      kept.push(name)
    } catch (error) {
      if (error?.code === 'EEXIST') continue // a new file stood there after all
      notKept(from, error)
      // Only ever this copy's own partial file.
      try {
        rmSync(to, { force: true })
      } catch (cleanup) {
        console.warn(`webapp: could not remove the partial copy ${to} (${cleanup?.code ?? cleanup})`)
      }
    }
  }
  return kept
}

export async function buildWebapp({ source, workspace, out }) {
  if (!workspace) throw new Error('A prepared Webapp workspace is required')
  const app = 'apps/desktop'
  workspace = resolve(workspace)
  ;({ source, out } = productOutput(source, out, [
    // The output lives inside the Desktop workspace: protect its siblings, not the directory.
    ...readdirSync(join(resolve(source), app)).filter(name => !['dist', 'dist-webapp', 'build'].includes(name)).map(name => `${app}/${name}`),
    'apps/shared', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/build', 'node_modules',
    relative(resolve(source), workspace),
  ]))
  const inputs = buildInputs(source, 'webapp')
  // The workspace is what compiles; a stale mirror must not publish under a current receipt.
  if (sourceHash(workspace, 'webapp') !== inputs.sourceHash) {
    throw new Error(`Prepared Webapp workspace ${workspace} does not match ${source}; prepare it again`)
  }
  const { build } = await import(pathToFileURL(workspaceTool(workspace, app, 'vite')).href)
  await withProduct(out, async (product, scratch) => {
    await build({
      root: join(workspace, app),
      configLoader: 'runner',
      cacheDir: join(scratch, 'vite-cache'),
      build: { outDir: product, emptyOutDir: true, manifest: manifestName },
    })
    if (!existsSync(join(product, 'index.html'))) throw new Error('Webapp build did not produce index.html')
    // Before the receipt, whose output hash covers the kept files too.
    const retained = keepPreviousGeneration(out, product)
    // Everything under assets/ must be named by this generation's manifest or retained for a tab on
    // the previous one; anything else is a leftover nothing links to. Set
    // HERMES_PRUNE_RETAINED_CHUNKS=1 to drop the retained set as well — correct for a deployment
    // that reloads every client anyway, at the cost of an old tab's unloaded lazy chunk.
    const keep = process.env.HERMES_PRUNE_RETAINED_CHUNKS === '1' ? new Set() : new Set(retained)
    const { removed } = pruneStaleAssets({ product, keep })
    if (removed.length) console.log(`webapp: pruned ${removed.length} stale asset(s): ${removed.join(', ')}`)
    const violations = checkWebappBudget({ product })
    for (const violation of violations) console.error(`webapp budget: ${violation}`)
    if (violations.length) throw new Error(`Webapp build is over its size budget (${violations.length} violation(s))`)
    recordProduct({ source, product: 'webapp', out: product, inputs })
  }, { source })
  return { out, index: join(out, 'index.html') }
}
