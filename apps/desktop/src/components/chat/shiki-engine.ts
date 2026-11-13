/**
 * The one shiki highlighter for the renderer: `shiki/core` on the JS regex
 * engine, a curated grammar set and the two shared themes. Chat code blocks
 * (shiki-block.tsx) and diffs (diff-lines.tsx) both go through here.
 *
 * Never import the bare `shiki` package at runtime: its full bundle ships
 * every grammar and theme (a ~19 MB chunk) plus the oniguruma wasm. Only
 * `shiki/core`, `shiki/engine/javascript`, `shiki/langs/*`,
 * `shiki/themes/*` and type-only imports are allowed
 * (shiki-engine-graph.test.ts enforces it).
 */
import type { Root } from 'hast'
import type { HighlighterCore, LanguageRegistration, ShikiTransformer, ThemedToken } from 'shiki/core'

import { SHIKI_THEME } from '@/components/chat/shiki-config'

// Each grammar is its own dynamic import, fetched only when a block needs it.
// Anything outside this list renders as plain text; do not widen it casually
// (scripts/build/check-webapp-budget.mjs fails the build on a bloated bundle).
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs')
}

// Fence aliases the full bundle used to resolve, limited to the curated set.
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  patch: 'diff',
  jsonc: 'json'
}

/** Only the two shared themes are bundled; anything else falls back to them. */
export const BUNDLED_THEMES: ReadonlySet<string> = new Set([SHIKI_THEME.dark, SHIKI_THEME.light])

/** Curated language id for a fence/extension name, or `'text'` when not curated. */
export function resolveLanguage(lang: string): string {
  const key = lang.toLowerCase()
  const id = LANGUAGE_ALIASES[key] ?? key

  return Object.hasOwn(LANGUAGE_LOADERS, id) ? id : 'text'
}

let highlighterPromise: Promise<HighlighterCore> | null = null

function createHighlighter(): Promise<HighlighterCore> {
  return Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-dark-dimmed.mjs'), import('shiki/themes/github-light-default.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine()
      })
  )
}

/** Cached core highlighter. A failed creation is not cached, so a chunk fetch error cannot poison later calls. */
export function getHighlighter(): Promise<HighlighterCore> {
  const pending = (highlighterPromise ??= createHighlighter())

  pending.catch(() => {
    if (highlighterPromise === pending) {
      highlighterPromise = null
    }
  })

  return pending
}

/** Highlighter with the grammar for curated language `id` loaded (`'text'` needs none). */
export async function getHighlighterFor(id: string): Promise<HighlighterCore> {
  const highlighter = await getHighlighter()

  if (id !== 'text' && !highlighter.getLoadedLanguages().includes(id)) {
    await highlighter.loadLanguage(LANGUAGE_LOADERS[id]())
  }

  return highlighter
}

function plainTokens(code: string): ThemedToken[][] {
  return code.split('\n').map(line => [{ content: line, offset: 0 }])
}

/** Tokens for diff rendering. Unknown language -> plain text tokens; never throws. */
export async function highlightToTokens(code: string, lang: string, theme: string): Promise<ThemedToken[][]> {
  const id = resolveLanguage(lang)

  if (id === 'text') {
    return plainTokens(code)
  }

  try {
    const highlighter = await getHighlighterFor(id)

    return highlighter.codeToTokens(code, {
      lang: id,
      theme: BUNDLED_THEMES.has(theme) ? theme : SHIKI_THEME.light
    }).tokens
  } catch {
    return plainTokens(code)
  }
}

export interface HighlightHastOptions {
  defaultColor?: string | false
  transformers?: ShikiTransformer[]
}

/**
 * Dual-theme hast tree, for callers that need shiki transformers (they only
 * run on the hast path, not on `codeToTokens`). Unknown language -> `text`
 * grammar, so transformers still apply. Rejects on engine/chunk failure.
 */
export async function highlightToHast(code: string, lang: string, options: HighlightHastOptions = {}): Promise<Root> {
  const highlighter = await getHighlighterFor(resolveLanguage(lang))

  return highlighter.codeToHast(code, {
    lang: resolveLanguage(lang),
    themes: { dark: SHIKI_THEME.dark, light: SHIKI_THEME.light },
    ...options
  })
}
