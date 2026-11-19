/** Longest selection quoted into the composer; a whole reply pasted back is noise, not a reference. */
export const MAX_QUOTE_CHARS = 1200

/** Markdown blockquote of the text a user selected in a reply, ready to seed the composer so the
 *  next message can ask about it. Empty when nothing readable was selected. */
export function quoteSelection(selected: string): string {
  const trimmed = selected.trim()

  if (!trimmed) {
    return ''
  }

  const capped = trimmed.length > MAX_QUOTE_CHARS ? `${trimmed.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : trimmed

  return capped
    .split('\n')
    .map(line => `> ${line.trimEnd()}`.trimEnd())
    .join('\n')
}
