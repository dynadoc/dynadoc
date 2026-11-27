// Ctrl+S / Cmd+S for every target.
//
// The desktop menu declares CmdOrCtrl+S, but a menu accelerator only fires
// where the platform shows that menu, and the web has no menu at all: there
// the browser's own "Save page as" opened and offered to download the HTML of
// the application. The shortcut is therefore handled in the page itself, in
// the capture phase so that no editor (ProseMirror, Monaco, the sheet grid)
// sees it first, and the browser default is always prevented.
//
// No Svelte, store or DOM import here: the matching logic is plain so the
// smoke test can load this file on its own.

export type SaveShortcutAction = 'save' | 'save-as'

type KeyLike = {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

/**
 * Which save action a key event asks for, or null.
 *
 * On macOS the modifier is Cmd and Ctrl+S is left alone (it is a text-editing
 * key there); elsewhere it is Ctrl. Alt is excluded so that Ctrl+Alt+S, the
 * menu's Save All, and AltGr layouts (which report Ctrl+Alt) do not trigger a
 * plain save. `code` is checked as well as `key` so the shortcut survives
 * keyboard layouts where the S key produces another character.
 */
export function matchSaveShortcut(event: KeyLike, isMac: boolean): SaveShortcutAction | null {
  if (!event || event.isComposing) return null
  const primary = isMac ? event.metaKey : event.ctrlKey
  const other = isMac ? event.ctrlKey : event.metaKey
  if (!primary || other || event.altKey) return null
  const isS = String(event.key || '').toLowerCase() === 's' || event.code === 'KeyS'
  if (!isS) return null
  return event.shiftKey ? 'save-as' : 'save'
}

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  const source = `${nav?.platform || ''} ${nav?.userAgent || ''}`
  return /Mac|iPhone|iPad|iPod/i.test(source)
}

/**
 * Listens for the save shortcut on `target` and runs `onAction`.
 * Returns the function that removes the listener.
 */
export function installSaveShortcut(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  onAction: (action: SaveShortcutAction) => unknown,
  isMac: boolean
): () => void {
  const listener = (event: KeyboardEvent): void => {
    const action = matchSaveShortcut(event, isMac)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    // A held key repeats; one save per press is enough.
    if (event.repeat) return
    void onAction(action)
  }
  target.addEventListener('keydown', listener as EventListener, true)
  return () => target.removeEventListener('keydown', listener as EventListener, true)
}
