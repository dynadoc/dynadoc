/**
 * Gate: the page count of a paginated document settles (#117).
 *
 * tiptap-pagination-plus adds pages while the last block ends below the last
 * page, then lays out and measures again. A block that cannot sit between two
 * page breaks (taller than a page's content area, or a Design canvas whose
 * node view cleared every page float) stays below the last page whatever the
 * count, so pages were added forever: about 70 in seconds, the renderer
 * frozen. CustomPaginationExtension stops the growth once
 * CustomPaginationExtension/pageFit.ts says more pages cannot help.
 *
 * The layout is modelled here: pages are content areas one below the other;
 * a block goes on the current page if it fits, else on the next one; past the
 * last page blocks follow one another; a block that fits no page goes below
 * the last page. The plugin's loop (measure, recount, lay out again) is run
 * with tiptap-pagination-plus 3.1.0's rule until the count stops changing.
 *
 * Checked without starting the app.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

let failures = 0
const ok = (what) => console.log(`[pagination]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[pagination]   FAIL  ${what}\n                 ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

const outDir = mkdtempSync(path.join(tmpdir(), 'pagination-'))
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const relPath = 'src/renderer/src/extensions/tiptap/CustomPaginationExtension/pageFit.ts'
const outfile = path.join(outDir, 'pageFit.mjs')
const build = spawnSync(
  esbuild,
  [
    path.join(repoRoot, relPath),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=warning',
    `--outfile=${outfile}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[pagination] FAIL: could not compile ${relPath}\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}
const m = await import(`file://${outfile}`)

// A4 at 96 dpi with the app's defaults. The base plugin counts pages with the
// header and footer left out (1063px); the pages it draws hold 1042px.
const page = {
  pageHeight: 1123,
  pageGap: 50,
  marginTop: 20,
  marginBottom: 20,
  contentMarginTop: 10,
  contentMarginBottom: 10
}
const COUNT_AREA = m.pageContentAreaHeight(page)
const AREA = m.pageContentAreaHeight(page, 11, 10)
check('content area: page less margins, header and footer', [COUNT_AREA, AREA], [1063, 1042])

/**
 * Where the last block ends relative to the bottom of the last page, for
 * `blocks` laid out on `pages` pages.
 */
function layout(blocks, pages) {
  const pitch = page.pageHeight + page.pageGap
  const lastPageBottom = (pages - 1) * pitch + AREA
  let y = 0
  for (const block of blocks) {
    let top = y
    if (block.belowAll || block.height > AREA) {
      top = Math.max(y, lastPageBottom)
    } else if (y < lastPageBottom) {
      // The page holding y, or the next one when y is in a page break.
      let p = Math.floor(y / pitch)
      if (y > p * pitch + AREA) p++
      top = Math.max(y, p * pitch)
      if (top + block.height > p * pitch + AREA) {
        top = p + 1 < pages ? (p + 1) * pitch : lastPageBottom
      }
    }
    y = top + block.height
  }
  return y - lastPageBottom
}

/** tiptap-pagination-plus 3.1.0, calculatePageCount: the next page count. */
function basePageCount(pages, gap) {
  const pitch = page.pageHeight + page.pageGap
  if (gap > 0) return pages + Math.ceil(gap / COUNT_AREA)
  // It drops the page breaks lying wholly below the last block, if two or more.
  const emptyBelow = Math.max(0, Math.floor(-gap / pitch))
  return emptyBelow > 1 ? Math.max(1, pages - emptyBelow) : pages
}

/** The plugin's loop: recount after each layout until the count settles. */
function settle(blocks, { guarded = true, maxRounds = 500 } = {}) {
  let pages = 1
  let memory = null
  for (let round = 1; round <= maxRounds; round++) {
    const gap = layout(blocks, pages)
    let stalled = false
    if (guarded) {
      const result = m.checkPageGrowth(memory, {
        pageCount: pages,
        lastPageGap: gap,
        contentAreaHeight: AREA
      })
      memory = result.memory
      stalled = result.stalled
    }
    const next = stalled ? pages : basePageCount(pages, gap)
    if (next === pages) return { pages, rounds: round }
    pages = next
  }
  return { pages, rounds: Infinity }
}

const para = { height: 24 }
const paragraphs = (n) => Array.from({ length: n }, () => para)

// Ordinary content settles on the pages it needs, the guard never in the way.
check('one paragraph: one page', settle(paragraphs(1)).pages, 1)
check('130 paragraphs of 24px (43 per page): four pages', settle(paragraphs(130)).pages, 4)
check('  the same without the guard', settle(paragraphs(130), { guarded: false }).pages, 4)
check(
  'a Design canvas sized to the page, then a paragraph: two pages',
  settle([{ height: m.fitHeightToPage(1007, AREA, 42) + 26 }, para]).pages,
  2
)

// #117: a block that fits no page. Without the guard the count never settles.
const tallCanvas = [para, { height: 1100 }, para]
check(
  '(without the guard, as before: never settles)',
  settle(tallCanvas, { guarded: false }).rounds === Infinity,
  true
)
{
  const r = settle(tallCanvas)
  check('a 1100px block on a 1042px page: the count settles', Number.isFinite(r.rounds), true)
  check('  after one growth step only', r.pages, 1 + Math.ceil(layout(tallCanvas, 1) / COUNT_AREA))
}
{
  const r = settle([para, { height: 3000 }, para])
  check(
    'a 3000px image: settles on a handful of pages',
    [Number.isFinite(r.rounds), r.pages <= 8],
    [true, true]
  )
}
{
  const r = settle([para, { height: 600, belowAll: true }, para])
  check('a node view that clears every page float: settles', Number.isFinite(r.rounds), true)
}
{
  const r = settle([...paragraphs(200), { height: 5000 }, ...paragraphs(10)])
  check(
    'a tall block after 200 paragraphs: settles, the paragraphs keep their pages',
    [Number.isFinite(r.rounds), r.pages >= 5],
    [true, true]
  )
}

// checkPageGrowth on its own.
function measure(pageCount, lastPageGap) {
  return { pageCount, lastPageGap, contentAreaHeight: AREA }
}
{
  const first = m.checkPageGrowth(null, measure(1, 1100))
  check(
    'first overflow: growth allowed, remembered',
    [first.stalled, first.memory?.lastPageGap],
    [false, 1100]
  )
  const same = m.checkPageGrowth(first.memory, measure(1, 1100))
  check('no page added yet: still allowed', same.stalled, false)
  const helped = m.checkPageGrowth(first.memory, measure(2, 60))
  check('pages that pull the overflow up: allowed', helped.stalled, false)
  const useless = m.checkPageGrowth(first.memory, measure(3, 1100))
  check('pages that leave the overflow as it was: stalled', useless.stalled, true)
  check(
    'stalled stays stalled while nothing changes',
    m.checkPageGrowth(useless.memory, measure(3, 1120)).stalled,
    true
  )
  check(
    'the overflow shrinking a lot (content above removed): growth allowed again',
    m.checkPageGrowth(useless.memory, measure(3, 200)).stalled,
    false
  )
  check(
    'content back inside the last page: forgotten',
    m.checkPageGrowth(useless.memory, measure(3, -40)),
    { stalled: false, memory: null }
  )
  check(
    'an unmeasurable gap: not stalled',
    m.checkPageGrowth(useless.memory, measure(3, NaN)).stalled,
    false
  )
}

// fitHeightToPage: the Design canvas height in a paginated document.
check(
  'maxPageHeight 1007 in a 1032px child area with 32px chrome: kept',
  m.fitHeightToPage(1007, 1032, 32),
  1000
)
check('a larger header: brought down to the area', m.fitHeightToPage(1007, 900, 32), 868)
check('a smaller request is kept', m.fitHeightToPage(400, 972, 32), 400)
check(
  'no measured area (flow layout): request unchanged',
  [m.fitHeightToPage(1007, null, 32), m.fitHeightToPage(1007, 0, 32)],
  [1007, 1007]
)
check('never below the minimum', m.fitHeightToPage(1007, 60, 32), 120)

rmSync(outDir, { recursive: true, force: true })
if (failures) {
  console.error(`[pagination] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('[pagination] all checks passed')
