export type ComposerEnterIntent = 'newline' | 'other' | 'submit'

type KeyboardModifiers = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>

/** Plain Enter inserts a line break; the platform modifier+Enter shortcut submits. */
export const composerEnterIntent = (event: KeyboardModifiers): ComposerEnterIntent => {
  if (event.key !== 'Enter') {
    return 'other'
  }

  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey ? 'submit' : 'newline'
}
