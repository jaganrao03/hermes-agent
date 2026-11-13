import { atom } from 'nanostores'

/**
 * Multi-select in the sessions list.
 *
 * The map holds the set of session ids currently selected (value is always
 * true). `multiSelectMode` gates the checkbox column and the bulk action bar.
 *
 * Interactive only inside the sessions pane — never inside a row's drag handle,
 * its actions menu, an input, or a contenteditable region, where the gesture
 * would be swallowed or would conflict with existing semantics.
 */

export interface SessionMultiSelect {
  /** Set of session ids currently selected. */
  $ids: Map<string, true>
  /** Whether the checkbox column / bulk bar are visible. */
  $mode: boolean
}

export const $sessionMultiSelectIds = atom<Map<string, true>>(new Map())
export const $sessionMultiSelectMode = atom(false)

/** Toggle a session into/out of the selection set. */
export function toggleSessionMultiSelect(sessionId: string): void {
  const next = new Map($sessionMultiSelectIds.get())

  if (next.has(sessionId)) {
    next.delete(sessionId)

    if (next.size === 0) {
      $sessionMultiSelectMode.set(false)
    }
  } else {
    next.set(sessionId, true)

    if (next.size === 1) {
      $sessionMultiSelectMode.set(true)
    }
  }

  $sessionMultiSelectIds.set(next)
}

/** Replace the selection with the given ids (used for Select-all). */
export function setSessionMultiSelectIds(ids: readonly string[]): void {
  const next = new Map<string, true>()

  for (const id of ids) {next.set(id, true)}
  $sessionMultiSelectIds.set(next)
  $sessionMultiSelectMode.set(next.size > 0)
}

/** Clear the whole selection. */
export function clearSessionMultiSelect(): void {
  $sessionMultiSelectIds.set(new Map())
  $sessionMultiSelectMode.set(false)
}

/** Are there any currently selected sessions? */
export function hasSessionMultiSelect(): boolean {
  return $sessionMultiSelectIds.get().size > 0
}

/** The currently selected session ids (as an array). */
export function getSessionMultiSelectIds(): string[] {
  return Array.from($sessionMultiSelectIds.get().keys())
}
