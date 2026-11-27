/**
 * Right-to-left text.
 *
 * Guards:
 *   - the @ menu in an RTL paragraph hangs from the start side of the caret
 *     (its right edge at the caret) and stays fully inside the window; it used
 *     to open toward the left edge, half off screen, over the text;
 *   - in an RTL page, a variable's name reads "@client", not "client@" (the
 *     bidi algorithm moved the @ to the end of a neutral-led run);
 *   - spreadsheet cells still draw when the page is RTL: the grid is laid out
 *     left to right whatever the page direction.
 */
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  createVariableFromMenu,
  newTextDocument,
  openApp,
  textEditor,
  typeKeys,
  variableMenu
} from './support/app'
import { enterCell, sheetCanvas, waitForSheet } from './support/sheet'

/** The caret's rectangle, from the DOM selection. */
async function caretRect(
  page: import('@playwright/test').Page
): Promise<{ x: number; y: number; bottom: number }> {
  return page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount) throw new Error('no selection')
    const range = selection.getRangeAt(0).cloneRange()
    const rects = range.getClientRects()
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    return { x: rect.x, y: rect.y, bottom: rect.bottom }
  })
}

test('the @ menu opens on the start side of the caret in an RTL paragraph', async ({ page }) => {
  const editor = await newTextDocument(page)
  // The ribbon's icon buttons are named by their tooltip.
  await page
    .getByTitle(/Set paragraph direction to RTL/)
    .first()
    .click()
  await expect(editor).toHaveAttribute('dir', 'rtl')
  await editor.click()
  await typeKeys(page, 'مرحبا ')
  await typeKeys(page, '@')
  const menu = variableMenu(page)
  await expect(menu).toBeVisible()
  const caret = await caretRect(page)
  const box = await menu.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('no box')

  // Fully inside the window.
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  // Anchored on the start (right) side: the menu's right edge is at the
  // caret, and the menu extends toward the left, where the text runs.
  expect(Math.abs(box.x + box.width - caret.x)).toBeLessThanOrEqual(40)
  expect(box.x).toBeLessThan(caret.x)
})

test('in an RTL page the menu reads @client, not client@', async ({ page }) => {
  const editor = await newTextDocument(page)
  await typeKeys(page, '@client')
  await createVariableFromMenu(page, 'ACME SARL')
  await expect(editor.locator('span[data-variable="client"]')).toHaveCount(1)

  await page.evaluate(() => {
    document.documentElement.dir = 'rtl'
  })
  await textEditor(page).click()
  await page.keyboard.press('End')
  await typeKeys(page, ' @cli')
  const menu = variableMenu(page)
  const name = menu.locator('.var-menu__name').filter({ hasText: 'client' }).first()
  await expect(name).toBeVisible()
  await expect(name).toHaveText('@client')

  // What the eye sees: the "@" is drawn to the left of the "c".
  const order = await name.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const positions: Record<string, number> = {}
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.textContent || ''
      for (const ch of ['@', 'c']) {
        const index = text.indexOf(ch)
        if (index < 0 || ch in positions) continue
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        positions[ch] = range.getBoundingClientRect().x
      }
    }
    return positions
  })
  expect(order['@']).toBeDefined()
  expect(order['c']).toBeDefined()
  expect(order['@']).toBeLessThan(order['c'])
})

test('spreadsheet cells draw in an RTL page', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl'
  })
  await createFromDashboard(page, 'Spreadsheet')
  await waitForSheet(page)

  const container = page.locator('.fortune-sheet-container').first()
  await expect(container).toHaveCSS('direction', 'ltr')

  await enterCell(page, 'B2', '12345')
  // The cell's area of the canvas has ink: the value was drawn.
  await expect
    .poll(() =>
      sheetCanvas(page).evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext('2d')
        if (!context) return -1
        const scale = canvas.width / canvas.getBoundingClientRect().width
        // B2: after the 46 px row header and column A (74 px), below the
        // 20 px column header and row 1 (20 px).
        const x = Math.round((46 + 74 + 2) * scale)
        const y = Math.round((20 + 20 + 2) * scale)
        const data = context.getImageData(x, y, Math.round(70 * scale), Math.round(16 * scale)).data
        let dark = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120 && data[i + 3] > 0) dark++
        }
        return dark
      })
    )
    .toBeGreaterThan(10)
})
