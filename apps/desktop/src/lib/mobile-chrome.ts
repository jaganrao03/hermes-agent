/**
 * The bits of a phone the DOM can see but a theme cannot: the status bar's
 * colour, which Android reads from `<meta name="theme-color">`.
 *
 * The meta ships as a dark constant in `index.html` so the very first paint has
 * one. That constant is wrong for every other skin: a light theme under a black
 * status bar reads as a broken window on a phone. `applyTheme` calls this on
 * every theme or mode change, which is also every boot, so the colour tracks
 * whatever the app is actually painting.
 */

export const THEME_COLOR_META = 'theme-color'

/** Point the status bar at the colour the shell is painted with. */
export function syncThemeColor(background: string): void {
  if (typeof document === 'undefined' || !background || !document.head) {
    return
  }

  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${THEME_COLOR_META}"]`)

  if (!meta) {
    meta = document.createElement('meta')
    meta.name = THEME_COLOR_META
    document.head.appendChild(meta)
  }

  meta.content = background
}

/** Read back the painted status-bar colour; `''` when nothing has set one. */
export function currentThemeColor(): string {
  if (typeof document === 'undefined') {
    return ''
  }

  return document.head?.querySelector<HTMLMetaElement>(`meta[name="${THEME_COLOR_META}"]`)?.content ?? ''
}
