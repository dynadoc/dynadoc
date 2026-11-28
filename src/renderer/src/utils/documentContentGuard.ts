import Platform from '../libs/platform'

/**
 * Refuses to write the main file of a spreadsheet document when the content no
 * longer holds its workbook (and the same for presentation and design
 * documents, which have the same shape).
 *
 * A spreadsheet document is a Tiptap document whose only content is one
 * `<sheet src="...">` element; the workbook lives in the file that element
 * points to. When keys reach the Tiptap editor while that element is selected,
 * ProseMirror replaces it with the typed text, and the next autosave wrote
 * `<p>typed text</p>` as the whole document (dynadoc#133). The workbook file is
 * still on disk, but nothing points to it any more.
 *
 * The rule is checked on the HTML about to be written, never on the DOM: a new
 * spreadsheet document is saved before its node view has rendered, and that
 * save must go through.
 *
 * Keyed by the main file's path, like `unreadableFiles.ts`, because the write
 * this guards (`Utils.saveToFile`) only knows a path. The kind of a document
 * is recorded whenever its main file path is computed
 * (`DocumentModel.getMainFilePath`), which every editor does before it can
 * write that file.
 */

/**
 * Kinds whose main file must keep a given element, and that element's test.
 * Slide and design documents have the same shape as spreadsheet documents:
 * one `<slide>` or `<design>` element pointing to the file that holds them.
 */
const REQUIRED_ELEMENT: Record<string, RegExp> = {
  sheet: /<sheet[\s>/]/i,
  slide: /<slide[\s>/]/i,
  design: /<design[\s>/]/i
}

const KIND_NAME: Record<string, string> = {
  sheet: 'spreadsheet',
  slide: 'presentation',
  design: 'design'
}

/** What the user calls the content a refused document lost ("spreadsheet"). */
export function guardedKindName(contentType: string | null | undefined): string {
  return (contentType && KIND_NAME[contentType]) || 'document'
}

/**
 * True when `html` may be written as the main file of a document of this kind.
 * A spreadsheet, presentation or design document must still contain its
 * `<sheet>`, `<slide>` or `<design>` element; every other kind, and an unknown
 * kind, is not checked.
 */
export function isSafeToWrite(contentType: string | null | undefined, html: string): boolean {
  const required = contentType ? REQUIRED_ELEMENT[contentType] : undefined
  if (!required) return true
  return typeof html === 'string' && required.test(html)
}

const kindByPath = new Map<string, string>()
// Paths whose last write was refused. Cleared by the next accepted write, so
// the user is told once per episode, not on every debounced autosave.
const refusedPaths = new Set<string>()

// The same normalization `Utils.saveToFile` applies before writing.
function normalize(filePath: string): string {
  const raw = typeof filePath === 'string' ? filePath : String(filePath ?? '')
  if (Platform.getPlatform() === Platform.SUPPORTED_PLATFORMS.desktop) return raw
  return raw.replace(/^file:\/\//i, '').replace(/^\/+/, '')
}

/** Records the kind of the document whose main file is `mainFilePath`. */
export function registerDocumentKind(
  mainFilePath: string | null | undefined,
  contentType: string | null | undefined
): void {
  const key = normalize(mainFilePath || '')
  if (!key) return
  // A copy of the document whose info does not say its kind changes nothing.
  if (!contentType) return
  if (REQUIRED_ELEMENT[contentType]) kindByPath.set(key, contentType)
  else kindByPath.delete(key)
}

export type WriteCheck = { ok: true } | { ok: false; firstRefusal: boolean; contentType: string }

/**
 * Checks a write of `content` to `filePath`. A refused write leaves the file
 * as it is, which keeps the last good version on disk.
 */
export function checkDocumentWrite(filePath: string, content: string): WriteCheck {
  const key = normalize(filePath)
  const contentType = kindByPath.get(key)
  if (!contentType || isSafeToWrite(contentType, content)) {
    refusedPaths.delete(key)
    return { ok: true }
  }
  const firstRefusal = !refusedPaths.has(key)
  refusedPaths.add(key)
  return { ok: false, firstRefusal, contentType }
}

/**
 * The kind of the document whose last write to this path was refused, or null
 * when the last write went through.
 */
export function refusedDocumentKind(filePath: string | null | undefined): string | null {
  const key = normalize(filePath || '')
  if (!key || !refusedPaths.has(key)) return null
  return kindByPath.get(key) ?? null
}
