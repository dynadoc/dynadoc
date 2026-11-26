/**
 * Screenshot comparisons of a few stable views. @visual
 *
 * These run only in the Playwright Docker image with E2E_VISUAL=1, and skip
 * while a view has no baseline: see support/visual.ts and the README. Every
 * area that changes from run to run (connection status, drive statistics,
 * the caret) is masked or hidden.
 */
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  createVariableFromMenu,
  dashboardHeading,
  newTextDocument,
  openApp,
  typeKeys,
  variableMenu
} from './support/app'
import { enterCell, selectCell, waitForSheet } from './support/sheet'
import { expectScreenshot, requireVisualEnvironment } from './support/visual'
import type { Locator, Page } from '@playwright/test'

test.describe('views @visual', () => {
  test.beforeEach(() => {
    requireVisualEnvironment()
  })

  /** What changes between runs: connection status, drive statistics. */
  function dynamicAreas(page: Page): Locator[] {
    return [page.getByText(/offline|last seen|online/i), page.getByText(/folders ·|files ·/i)]
  }

  /**
   * The window without its status bar (the bottom 40 px), which shows the
   * connection state and a collaborator avatar that change between runs.
   */
  function aboveStatusBar(page: Page): { x: number; y: number; width: number; height: number } {
    const size = page.viewportSize() ?? { width: 1400, height: 900 }
    return { x: 0, y: 0, width: size.width, height: size.height - 40 }
  }

  test('dashboard', async ({ page }) => {
    await openApp(page)
    await expect(dashboardHeading(page)).toBeVisible()
    await expectScreenshot(page, 'dashboard.png', { mask: dynamicAreas(page) })
  })

  test('document with a variable chip and the @ menu open', async ({ page }) => {
    const editor = await newTextDocument(page)
    await typeKeys(page, 'Contrat pour @client')
    await createVariableFromMenu(page, 'ACME SARL')
    await expect(editor.locator('span[data-variable="client"]')).toHaveText('ACME SARL')
    await typeKeys(page, ' et @cl')
    await expect(variableMenu(page)).toBeVisible()
    await expectScreenshot(page, 'document-variable-menu.png', {
      mask: dynamicAreas(page),
      clip: aboveStatusBar(page)
    })
  })

  test('mode bar menu', async ({ page }) => {
    await newTextDocument(page)
    await page.getByRole('button', { name: 'Mode: Editing' }).click()
    const menu = page.getByRole('menu', { name: 'Editing mode' })
    await expect(menu).toBeVisible()
    await expectScreenshot(menu, 'mode-bar-menu.png')
  })

  test('spreadsheet with values', async ({ page }) => {
    await openApp(page)
    await createFromDashboard(page, 'Spreadsheet')
    await waitForSheet(page)
    await enterCell(page, 'A1', 'Article')
    await enterCell(page, 'B1', 'Prix')
    await enterCell(page, 'A2', 'Stylo')
    await enterCell(page, 'B2', '2.5')
    await enterCell(page, 'A3', 'Cahier')
    await enterCell(page, 'B3', '4')
    await enterCell(page, 'B4', '=SUM(B2:B3)')
    await selectCell(page, 'D6')
    await expectScreenshot(page.locator('.fortune-sheet-container').first(), 'sheet-values.png')
  })

  test('slide', async ({ page }) => {
    await openApp(page)
    await createFromDashboard(page, 'Presentation')
    const stages = page.locator('.konvajs-content')
    await expect(stages.first()).toBeVisible({ timeout: 60_000 })
    await page.getByTitle('New slide').click()
    await page.getByRole('menuitem', { name: 'Title and content' }).click()
    await expect(stages).toHaveCount(2)
    const stage = stages.last()
    await stage.scrollIntoViewIfNeeded()
    const box = await stage.boundingBox()
    if (!box) throw new Error('the slide has no box')
    const scale = box.width / 1280
    await page.mouse.dblclick(box.x + 640 * scale, box.y + 95 * scale)
    await expect(page.locator('.tiptap.ProseMirror-focused:not(.rm-with-pagination)')).toBeVisible()
    await typeKeys(page, 'Bilan annuel')
    // Leave the text box, so the slide is drawn as it is shown.
    await page.keyboard.press('Escape')
    await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10)
    await expectScreenshot(stage, 'slide.png')
  })
})
