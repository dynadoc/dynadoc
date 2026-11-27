/**
 * Page growth guard and block sizing for the paginated editor, as pure
 * functions.
 *
 * tiptap-pagination-plus lays pages out as float spacers in one widget at the
 * start of the document; the content flows around them. After each update it
 * compares the bottom of the last block with the bottom of the last page and,
 * when the content runs past it, adds pages and dispatches again. A block that
 * cannot sit between two page breaks (taller than a page's content area, or a
 * node view with `clear: both`, which clears every page float) stays below the
 * last page however many pages there are: each new page pushed it further down
 * and the plugin added pages forever, freezing the renderer (#117).
 *
 * Pages that help pull the overflow up: each added page takes about a content
 * area off it. `checkPageGrowth` remembers the overflow before pages were
 * added and, when the added pages did not reduce it, reports the growth as
 * stalled: CustomPaginationExtension then adds no more pages and the block
 * overflows the last page, until the overflow changes (the block is removed,
 * resized, or content above it moves).
 *
 * Nothing here touches the DOM, so tests/smoke/pagination.test.mjs checks it
 * without starting the app.
 */

export interface PageBoxOptions {
  pageHeight: number
  marginTop: number
  marginBottom: number
  contentMarginTop: number
  contentMarginBottom: number
}

/**
 * CSS variable CustomPaginationExtension keeps on the editor: the height a
 * page leaves for content, measured on the layout. Blocks that must fit in a
 * page (images, the Design canvas) size against it.
 */
export const PAGE_CONTENT_HEIGHT_VAR = '--dd-page-content-height'

/** Below this an area is treated as this. */
export const MIN_PAGE_CONTENT_HEIGHT = 50

/** Height a page leaves for content between its header and footer. */
export function pageContentAreaHeight(
  options: PageBoxOptions,
  headerHeight = 0,
  footerHeight = 0
): number {
  return (
    options.pageHeight -
    (options.contentMarginTop + options.marginTop + headerHeight) -
    (options.contentMarginBottom + options.marginBottom + footerHeight)
  )
}

/** What the guard remembers between two measurements. */
export interface PageGrowthMemory {
  pageCount: number
  /** Overflow when `pageCount` was measured. */
  lastPageGap: number
  stalled: boolean
}

export interface PageGrowthMeasure {
  pageCount: number
  /** Bottom of the last block minus bottom of the last page break, in px. */
  lastPageGap: number
  contentAreaHeight: number
}

/**
 * One measurement of the layout: whether adding pages is stalled, and what to
 * remember for the next measurement.
 */
export function checkPageGrowth(
  memory: PageGrowthMemory | null,
  { pageCount, lastPageGap, contentAreaHeight }: PageGrowthMeasure
): { stalled: boolean; memory: PageGrowthMemory | null } {
  // Nothing runs past the last page: nothing to guard.
  if (!Number.isFinite(lastPageGap) || lastPageGap <= 0) return { stalled: false, memory: null }

  const fresh = { stalled: false, memory: { pageCount, lastPageGap, stalled: false } }
  if (!memory) return fresh

  // Pages help when they take at least half a content area off the overflow.
  const step = Math.max(contentAreaHeight, MIN_PAGE_CONTENT_HEIGHT) / 2
  const reduced = lastPageGap < memory.lastPageGap - step

  if (pageCount === memory.pageCount) {
    // No page added since: keep the verdict, unless the overflow shrank
    // (content above the block moved), which is worth another try.
    if (memory.stalled && reduced) return fresh
    return { stalled: memory.stalled, memory }
  }
  // Pages were added (or removed) since: did that reduce the overflow?
  const stalled = !reduced
  return { stalled, memory: { pageCount, lastPageGap, stalled } }
}

/**
 * Height for a fixed-size block (Design canvas and the like) so it fits in a
 * page: `requested`, at most `maxChildHeight` (the editor's
 * --rm-max-content-child-height) less `chrome`, the block's own margins and
 * borders, and never below `minHeight`. Without a usable `maxChildHeight`
 * (flow layout, not measured yet) `requested` is returned unchanged.
 */
export function fitHeightToPage(
  requested: number,
  maxChildHeight: number | null | undefined,
  chrome = 0,
  minHeight = 120
): number {
  if (!Number.isFinite(requested)) return requested
  if (maxChildHeight == null || !Number.isFinite(maxChildHeight) || maxChildHeight <= 0) {
    return requested
  }
  const room = Math.max(minHeight, Math.floor(maxChildHeight - chrome))
  return Math.min(requested, room)
}
