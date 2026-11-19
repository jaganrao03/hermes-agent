/**
 * Web Share Target (Android share sheet -> installed Webapp). The manifest's `share_target` is a GET
 * to `./?share-target=1`, so the shared title/text/url arrive as query params on the page URL, ahead
 * of the `#/` hash route. This module only reads them; the caller decides where they go.
 *
 * The `share-target=1` marker keeps an unrelated `?text=` (a bookmark, an embed) from seeding the
 * composer.
 */
export const SHARE_TARGET_MARKER = 'share-target'

/** One share can't flood the composer; the user is meant to read and edit what lands there. */
export const MAX_SHARED_CHARS = 8000

const SHARE_PARAMS = ['title', 'text', 'url'] as const

export interface ParsedShare {
  /** Query string without the share params (`''` or `?a=b`), for `history.replaceState`. */
  rest: string
  text: string
}

export function parseShareTarget(search: string): ParsedShare | null {
  const params = new URLSearchParams(search)

  if (params.get(SHARE_TARGET_MARKER) !== '1') {
    return null
  }

  const parts = SHARE_PARAMS.map(name => params.get(name)?.trim() ?? '').filter(Boolean)
  // Android Chrome usually puts the link in `text`, not `url`; don't say it twice.
  const unique = parts.filter((part, index) => !(index > 0 && parts.slice(0, index).some(prior => prior.includes(part))))
  const text = unique.join('\n').slice(0, MAX_SHARED_CHARS)

  for (const name of [SHARE_TARGET_MARKER, ...SHARE_PARAMS]) {
    params.delete(name)
  }

  const rest = params.toString()

  return text ? { rest: rest ? `?${rest}` : '', text } : null
}

let pending: null | string = null
let consumed = false

/** Read the share once per page load and strip its params from the address bar, so a reload or a
 *  later "add to home screen" never replays it. Returns the text to hand off, or `''`. */
export function takePendingShare(loc: Location = window.location, hist: History = window.history): string {
  if (!consumed) {
    consumed = true
    const share = parseShareTarget(loc.search)

    if (share) {
      pending = share.text
      hist.replaceState(hist.state, '', `${loc.pathname}${share.rest}${loc.hash}`)
    }
  }

  const text = pending ?? ''
  pending = null

  return text
}

/** Test seam: forget the one-shot read. */
export function resetPendingShareForTests() {
  pending = null
  consumed = false
}
