'use client'

/**
 * The Shiki-highlighted compact diff body, split out of diff-lines.tsx so the
 * highlighter loads lazily on first use instead of on the cold-start path.
 * diff-lines.tsx reaches this through `React.lazy` with a plain `DiffBody`
 * fallback. Highlighting goes through the shared curated engine
 * (shiki-engine.ts); the full shiki bundle is never imported.
 */
import type { Element, Root, RootContent } from 'hast'
import { createElement, type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'

import { DiffBody, type DiffLine, diffLineTransformer } from '@/components/chat/diff-lines'
import { highlightToHast } from '@/components/chat/shiki-engine'

/** `a-b: x; --c: y` -> React style object (custom properties keep their name). */
function parseStyle(style: string): CSSProperties {
  const out: Record<string, string> = {}

  for (const decl of style.split(';')) {
    const at = decl.indexOf(':')

    if (at < 0) {
      continue
    }

    const name = decl.slice(0, at).trim()
    const key = name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

    out[key] = decl.slice(at + 1).trim()
  }

  return out as CSSProperties
}

// Shiki's hast uses raw HTML attribute names, and the `line` transformer adds a
// `className` array next to the `class` string; merge both into one React className.
function elementProps(node: Element, key: number): Record<string, unknown> {
  const props: Record<string, unknown> = { key }
  const { class: rawClass, className, style, tabindex, ...rest } = node.properties as Record<string, unknown>

  const classes = [rawClass, className].flat().filter(Boolean).join(' ')

  if (classes) {
    props.className = classes
  }

  if (typeof style === 'string') {
    props.style = parseStyle(style)
  }

  if (tabindex !== undefined) {
    props.tabIndex = Number(tabindex)
  }

  return { ...rest, ...props }
}

function renderNode(node: RootContent, key: number): ReactNode {
  if (node.type === 'text') {
    return node.value
  }

  if (node.type !== 'element') {
    return null
  }

  return createElement(node.tagName, elementProps(node, key), ...node.children.map(renderNode))
}

export default function SyntaxDiff({ language, lines }: { language: string; lines: DiffLine[] }) {
  const code = useMemo(() => lines.map(line => line.text).join('\n'), [lines])
  const transformers = useMemo(() => [diffLineTransformer(lines.map(line => line.kind))], [lines])
  const [tree, setTree] = useState<Root | null>(null)

  useEffect(() => {
    let cancelled = false

    highlightToHast(code, language, { defaultColor: 'light-dark()', transformers })
      .then(next => !cancelled && setTree(next))
      .catch(() => !cancelled && setTree(null))

    return () => {
      cancelled = true
    }
  }, [code, language, transformers])

  // Until Shiki resolves, show the plain colored diff so there's no flash.
  return tree ? <>{tree.children.map(renderNode)}</> : <DiffBody lines={lines} />
}
