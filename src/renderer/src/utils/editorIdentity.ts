/**
 * Which WYSIWYG entry, and which of its node views, belongs to a document
 * editor.
 *
 * The WYSIWYG store keys its entries by the editor identity: the document
 * editor's `uuid` (which holds the main file path), then the document's uuid,
 * and only then the document editor's `id`. Looking an entry up by `id` alone
 * misses it whenever the editor carries a `uuid`, which is every document
 * opened from disk: whatever hangs off the active node view (the Design tool
 * bar and its layers panel) then sees no node view at all and silently does
 * nothing.
 *
 * Kept free of imports so it can be checked without starting the app
 * (tests/smoke/design-canvas.test.mjs).
 */

export type EditorIdentitySource = {
  id?: string | number | null
  uuid?: string | null
  document?: { uuid?: string | null } | null
} | null

type NodeviewLike = { id: string; type?: string; isActive?: boolean }
type WysiwygEntryLike<N extends NodeviewLike = NodeviewLike> = {
  id?: string | number | null
  nodeViews?: N[]
}

export const normalizeEditorId = (value?: string | number | null): string =>
  value === null || value === undefined ? '' : value.toString()

/** The id the WYSIWYG store registers a document editor's entry under. */
export const resolveEditorIdentity = (editor?: EditorIdentitySource): string =>
  normalizeEditorId(editor?.uuid || editor?.document?.uuid || editor?.id)

/** The WYSIWYG entry of a document editor, matched by its editor identity. */
export function findWysiwygEntryForEditor<E extends WysiwygEntryLike>(
  entries: readonly E[] | null | undefined,
  editor: EditorIdentitySource | undefined
): E | undefined {
  const identity = resolveEditorIdentity(editor)
  if (!identity || !entries) return undefined
  return entries.find((entry) => normalizeEditorId(entry?.id) === identity)
}

/** The active node view of a document editor's WYSIWYG entry, if any. */
export function findActiveNodeviewForEditor<N extends NodeviewLike>(
  entries: readonly WysiwygEntryLike<N>[] | null | undefined,
  editor: EditorIdentitySource | undefined
): N | undefined {
  return findWysiwygEntryForEditor(entries, editor)?.nodeViews?.find((nv) => nv.isActive)
}
