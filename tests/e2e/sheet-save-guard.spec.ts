/**
 * A spreadsheet document never loses its workbook to typed text (dynadoc#133).
 *
 * A spreadsheet document is a Tiptap document whose only content is one
 * `<sheet src="...">` element. Clicking a cell used to put a node selection on
 * that element, so a key that reached the Tiptap editor instead of the cell
 * editor replaced the whole element with text, and the autosave wrote that
 * text as the document.
 *
 * Guards:
 *   - with a cell selected and the focus on the editor root, typing does not
 *     remove the `<sheet>` element;
 *   - when the `<sheet>` element is gone anyway, nothing is written: the
 *     document on disk keeps its `<sheet>`, and the user is told.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './support/fixtures'
import { createFromDashboard, openApp, uniqueToken } from './support/app'
import { STUB_ROOT } from './support/env'
import { enterCell, expectCellSum, selectCell, waitForSheet } from './support/sheet'

/** The content of every document's index.html on the stub's drive. */
function savedIndexFiles(): string[] {
  const root = path.join(STUB_ROOT, 'home')
  if (!existsSync(root)) return []
  const contents: string[] = []
  for (const id of readdirSync(root)) {
    const dir = path.join(root, id)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, 'index.html')
      if (existsSync(file)) contents.push(readFileSync(file, 'utf8'))
    }
  }
  return contents
}

/** The HTML the app's editor holds now, read through its DOM node. */
async function editorHtml(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as
      (HTMLElement & { editor?: { getHTML(): string } }) | null
    return element?.editor?.getHTML() ?? ''
  })
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await createFromDashboard(page, 'Spreadsheet')
  await waitForSheet(page)
})

test('typing with a cell selected and the focus on the editor keeps the sheet', async ({
  page
}) => {
  await selectCell(page, 'B2')
  // Whatever moves the focus back to the editor root (a ribbon command, the
  // mode bar, the window regaining focus) does what this does.
  await page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as
      (HTMLElement & { editor?: { view: { focus(): void } } }) | null
    element?.editor?.view.focus()
  })
  await page.keyboard.type('hello', { delay: 40 })

  const html = await editorHtml(page)
  expect(html, 'the document still holds its <sheet>').toContain('<sheet')
  expect(html).not.toContain('hello')

  // The grid still works afterwards.
  await enterCell(page, 'C3', '7')
  await expectCellSum(page, 'C3', '7')
})

test('a spreadsheet document without its <sheet> is not written, and the user is told', async ({
  page
}) => {
  const token = uniqueToken()
  // Saved sheet documents before the change: the new one is among them once
  // its first save has happened.
  await expect
    .poll(() => savedIndexFiles().filter((html) => html.includes('<sheet')).length, {
      message: 'the new spreadsheet document is saved with its <sheet>',
      timeout: 30_000
    })
    .toBeGreaterThan(0)
  const sheetDocumentsBefore = savedIndexFiles().filter((html) => html.includes('<sheet')).length

  // The consequence of the bug, whatever its trigger: the editor's content
  // becomes plain text.
  await page.evaluate((text) => {
    const element = document.querySelector('.tiptap.ProseMirror') as
      | (HTMLElement & {
          editor?: { commands: { setContent(html: string, emit?: unknown): void } }
        })
      | null
    element?.editor?.commands.setContent(`<p>${text}</p>`, { emitUpdate: true })
  }, token)
  expect(await editorHtml(page)).toContain(token)

  const alert = page.getByRole('dialog', { name: 'Spreadsheet not saved' })
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert).toContainText('last saved version')
  await alert.getByRole('button', { name: 'OK' }).click()

  // An explicit save is refused too, and says so.
  await page.keyboard.press('Control+s')
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: 'OK' }).click()

  // The save flushed the pending autosave before it answered, so the refused
  // write has happened: nothing on disk holds the typed text, and every
  // spreadsheet document still holds its <sheet>.
  expect(savedIndexFiles().some((html) => html.includes(token))).toBe(false)
  expect(savedIndexFiles().filter((html) => html.includes('<sheet')).length).toBe(
    sheetDocumentsBefore
  )
})
