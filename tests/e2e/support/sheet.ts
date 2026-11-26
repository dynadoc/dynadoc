/**
 * Driving a fortune-sheet grid. The grid is one canvas: cells have no DOM, so
 * they are reached by position, and every click is checked against the name
 * box, which says which cell is selected. Values are read back through the
 * status area (Sum/Count of the selection), the one place the grid writes a
 * computed value into the DOM.
 */
import { expect, type Locator, type Page } from '@playwright/test'

// fortune-sheet's defaults: a 46 px row header, a 20 px column header, and
// cells of 73 x 19 px plus a 1 px grid line.
const ROW_HEADER = 46
const COLUMN_HEADER = 20
const CELL_WIDTH = 74
const CELL_HEIGHT = 20

export function sheetCanvas(page: Page): Locator {
  return page.locator('canvas.fortune-sheet-canvas').first()
}

export function nameBox(page: Page): Locator {
  return page.locator('.fortune-name-box').first()
}

export function statArea(page: Page): Locator {
  return page.locator('.fortune-stat-area').first()
}

export function cellInput(page: Page): Locator {
  return page.locator('.luckysheet-cell-input').first()
}

/** Waits for the grid to be drawn and ready for input. */
export async function waitForSheet(page: Page): Promise<void> {
  await expect(sheetCanvas(page)).toBeVisible({ timeout: 60_000 })
  await expect(nameBox(page)).toBeVisible()
  await expect
    .poll(async () => (await sheetCanvas(page).boundingBox())?.width ?? 0)
    .toBeGreaterThan(400)
}

/** Selects a cell by its A1 address ("B2"), and checks the selection. */
export async function selectCell(page: Page, address: string): Promise<void> {
  const match = /^([A-Z])(\d+)$/.exec(address)
  if (!match) throw new Error(`unsupported cell address ${address}`)
  const column = match[1].charCodeAt(0) - 'A'.charCodeAt(0)
  const row = Number(match[2]) - 1
  const box = await sheetCanvas(page).boundingBox()
  if (!box) throw new Error('the grid has no box')
  await page.mouse.click(
    box.x + ROW_HEADER + CELL_WIDTH * column + CELL_WIDTH / 2,
    box.y + COLUMN_HEADER + CELL_HEIGHT * row + CELL_HEIGHT / 2
  )
  await expect(nameBox(page)).toHaveText(address)
}

/** Selects a cell, types into it and commits with Enter. */
export async function enterCell(page: Page, address: string, text: string): Promise<void> {
  await selectCell(page, address)
  await page.keyboard.type(text, { delay: 40 })
  await page.keyboard.press('Enter')
}

/** The numeric value of a cell, as the status area sums it. */
export async function expectCellSum(page: Page, address: string, sum: string): Promise<void> {
  await selectCell(page, address)
  await expect(statArea(page)).toContainText(`Sum: ${sum}`)
}
