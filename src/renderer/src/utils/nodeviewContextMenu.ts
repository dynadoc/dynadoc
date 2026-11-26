/**
 * Context menus for node views (Design canvas and the like).
 *
 * On the desktop the menu is native: `window.api.showContextMenu` sends its
 * template to the main process over IPC, which structured-clones it. A
 * template whose items carry their `click` handlers cannot be cloned, so the
 * call threw "An object could not be cloned" (DataCloneError) and no menu
 * opened (#100). The template that crosses IPC is therefore plain data
 * (labels, separators and a `clickId` per item); the handlers stay in the
 * renderer and run when the main process answers with `invoke-menu-action`.
 *
 * Web and mobile have no IPC: their `showContextMenu` hands the items to the
 * in-app context menu, which calls each item's `action` directly.
 *
 * The builders below import nothing, so tests/smoke/design-canvas.test.mjs
 * checks them without starting the app.
 */

export type NodeviewMenuEntry = { label: string; run: () => void } | { separator: true }

/** What crosses IPC: plain, structured-clone safe data only. */
export type NativeMenuTemplateItem = { label: string; clickId: string } | { type: 'separator' }

/** What the in-app (web / mobile) context menu renders. */
export type WebMenuItem = { label: string; action: () => void; group: number }

export const NODEVIEW_MENU_ID_PREFIX = 'nodeview-menu:'

const isSeparator = (entry: NodeviewMenuEntry): entry is { separator: true } =>
  'separator' in entry && entry.separator === true

/**
 * The native template for `entries` and the handler behind each `clickId`.
 * Separators at the start, at the end or next to another separator are
 * dropped, as a native menu would render them as stray lines.
 */
export function buildNativeMenu(
  entries: readonly NodeviewMenuEntry[],
  menuId: number | string = 0
): { template: NativeMenuTemplateItem[]; actions: Map<string, () => void> } {
  const template: NativeMenuTemplateItem[] = []
  const actions = new Map<string, () => void>()
  entries.forEach((entry, index) => {
    if (isSeparator(entry)) {
      const last = template[template.length - 1]
      if (last && !('type' in last)) template.push({ type: 'separator' })
      return
    }
    const clickId = `${NODEVIEW_MENU_ID_PREFIX}${menuId}:${index}`
    template.push({ label: entry.label, clickId })
    actions.set(clickId, entry.run)
  })
  while (template.length && 'type' in template[template.length - 1]) template.pop()
  return { template, actions }
}

/** The same entries for the in-app menu: separators become group breaks. */
export function buildWebMenu(entries: readonly NodeviewMenuEntry[]): WebMenuItem[] {
  const items: WebMenuItem[] = []
  let group = 0
  let breakPending = false
  for (const entry of entries) {
    if (isSeparator(entry)) {
      breakPending = items.length > 0
      continue
    }
    if (breakPending) group++
    breakPending = false
    items.push({ label: entry.label, action: entry.run, group })
  }
  return items
}

type MenuBridge = {
  showContextMenu?: (template: unknown[]) => unknown
  onInvokeMenuAction?: (callback: (event: unknown, id: string) => void) => (() => void) | void
}

let menuSeq = 0
let pendingUnsubscribe: (() => void) | null = null

/**
 * Opens a context menu for `entries`: native on the desktop, in-app elsewhere.
 * `isDesktop` comes from the caller (libs/platform) so this module stays free
 * of imports.
 */
export function showNodeviewContextMenu(
  entries: readonly NodeviewMenuEntry[],
  isDesktop: boolean,
  bridge: MenuBridge | undefined = typeof window !== 'undefined'
    ? ((window as unknown as { api?: MenuBridge }).api ?? undefined)
    : undefined
): void {
  if (!bridge?.showContextMenu) return

  if (!isDesktop || !bridge.onInvokeMenuAction) {
    bridge.showContextMenu(buildWebMenu(entries))
    return
  }

  // Only the latest menu can be answered: drop the listener of one that was
  // dismissed without a choice.
  pendingUnsubscribe?.()
  pendingUnsubscribe = null

  const { template, actions } = buildNativeMenu(entries, ++menuSeq)
  const unsubscribe = bridge.onInvokeMenuAction((_event, id) => {
    const run = actions.get(id)
    if (!run) return
    pendingUnsubscribe?.()
    pendingUnsubscribe = null
    run()
  })
  pendingUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
  bridge.showContextMenu(template)
}
