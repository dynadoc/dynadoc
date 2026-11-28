/**
 * A spreadsheet document never loses its workbook to typed text (dynadoc#133).
 *
 * A spreadsheet document is a Tiptap document whose only content is one
 * `<sheet src="...">` element. Clicking a cell puts a node selection on that
 * element (the sheet ribbons depend on it), so a key that reached the Tiptap
 * editor instead of the cell editor replaced the whole element with text, and
 * the autosave wrote that text as the document.
 *
 * Guards:
 *   - with the sheet node selected and the focus on the editor root, typing,
 *     pasting, cutting, Backspace and Delete do not remove the `<sheet>`;
 *     neither does Ctrl+A then typing;
 *   - a cell click still selects the sheet, so the sheet ribbon shows;
 *   - in a text document, typing over a selected embedded sheet does not
 *     replace it, and Backspace still reaches the app's delete confirmation;
 *   - when the `<sheet>` is gone anyway, nothing is written: the document on
 *     disk keeps its `<sheet>`, and the user is told.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { createFromDashboard, newTextDocument, openApp, uniqueToken } from './support/app'
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

/**
 * The parts of the app's Tiptap editor the tests use, reached through its DOM
 * node (Tiptap sets `element.editor`).
 */
type EditorNode = HTMLElement & {
  editor: {
    getHTML(): string
    state: {
      doc: { descendants(visit: (node: { type: { name: string } }, pos: number) => boolean): void }
      selection: { node?: { type: { name: string } } }
    }
    view: { dom: HTMLElement; focus(): void; pasteText(text: string): boolean }
    commands: {
      setNodeSelection(pos: number): boolean
      setContent(html: string, options?: { emitUpdate?: boolean }): boolean
      insertSpreadsheet(): boolean
    }
  }
}

/** The HTML the app's editor holds now, read through its DOM node. */
async function editorHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as
      (HTMLElement & { editor?: { getHTML(): string } }) | null
    return element?.editor?.getHTML() ?? ''
  })
}

/**
 * Selects the first `<sheet>` node and focuses the editor root, the state in
 * which keys used to replace the sheet. Whatever moves the focus back to the
 * editor root in real use (a ribbon command, the mode bar, the window
 * regaining focus) leaves the same state.
 */
async function selectSheetNodeAndFocusEditor(page: Page): Promise<void> {
  const selected = await page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as EditorNode
    const editor = element?.editor
    if (!editor) return false
    let pos = -1
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.type.name === 'sheet') pos = at
      return pos < 0
    })
    if (pos < 0) return false
    editor.commands.setNodeSelection(pos)
    editor.view.focus()
    return (
      editor.state.selection.node?.type.name === 'sheet' &&
      document.activeElement === editor.view.dom
    )
  })
  expect(selected, 'the sheet node is selected and the editor root has the focus').toBe(true)
}

test.describe('in a spreadsheet document', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await createFromDashboard(page, 'Spreadsheet')
    await waitForSheet(page)
  })

  test('a cell click selects the sheet, so the sheet ribbon shows', async ({ page }) => {
    await selectCell(page, 'B2')
    await page.getByRole('button', { name: 'Data', exact: true }).first().click()
    await expect(page.getByText('Manage Duplicates').first()).toBeVisible()
  })

  test('keys that reach the editor with the sheet selected keep the sheet', async ({ page }) => {
    await selectCell(page, 'B2')
    await selectSheetNodeAndFocusEditor(page)

    await page.keyboard.type('hello', { delay: 40 })
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
    await page.evaluate(() => {
      const view = (document.querySelector('.tiptap.ProseMirror') as EditorNode).editor.view
      view.pasteText('pasted')
      view.dom.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true }))
    })
    // Ctrl+A selects the whole document, sheet included.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('x')

    const html = await editorHtml(page)
    expect(html, 'the document still holds its <sheet>').toContain('<sheet')
    expect(html).not.toContain('hello')
    expect(html).not.toContain('pasted')

    // The grid still works afterwards.
    await enterCell(page, 'C3', '7')
    await expectCellSum(page, 'C3', '7')
  })

  test('a document without its <sheet> is not written, and the user is told', async ({ page }) => {
    const token = uniqueToken()
    let autosaveSkips = 0
    page.on('console', (message) => {
      if (message.text().includes('autosave skipped')) autosaveSkips += 1
    })
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
      const element = document.querySelector('.tiptap.ProseMirror') as EditorNode
      element.editor.commands.setContent(`<p>${text}</p>`, { emitUpdate: true })
    }, token)
    expect(await editorHtml(page)).toContain(token)

    const alert = page.getByRole('dialog', { name: 'Document not saved' })
    await expect(alert).toBeVisible({ timeout: 15_000 })
    await expect(alert).toContainText('last saved version')
    await alert.getByRole('button', { name: 'OK' }).click()
    await expect(alert).toBeHidden()

    // The background autosave to the drive (2 s after a change) is refused
    // too, and stays quiet: it logs, and no alert comes back.
    await page.evaluate((text) => {
      const element = document.querySelector('.tiptap.ProseMirror') as EditorNode
      element.editor.commands.setContent(`<p>${text} again</p>`, { emitUpdate: true })
    }, token)
    await expect
      .poll(() => autosaveSkips, { message: 'the autosave ran and was skipped', timeout: 20_000 })
      .toBeGreaterThan(0)
    await expect(alert).toBeHidden()

    // An explicit save is refused, and says so in its own words.
    await page.keyboard.press('Control+s')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('is missing from this document')
    await alert.getByRole('button', { name: 'OK' }).click()

    // The save flushed the pending autosave before it answered, so the refused
    // write has happened: nothing on disk holds the typed text, and every
    // spreadsheet document still holds its <sheet>.
    expect(savedIndexFiles().some((html) => html.includes(token))).toBe(false)
    expect(savedIndexFiles().filter((html) => html.includes('<sheet')).length).toBe(
      sheetDocumentsBefore
    )
  })
})

test('in a text document, typing over a selected sheet keeps it, Backspace still asks to delete it', async ({
  page
}) => {
  await newTextDocument(page)
  await page.keyboard.type('Before the sheet', { delay: 20 })
  await page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as EditorNode
    element.editor.commands.insertSpreadsheet()
  })
  await expect.poll(() => editorHtml(page), { timeout: 30_000 }).toContain('<sheet')
  // Once drawn, the grid takes the focus; select the node after that.
  await waitForSheet(page)

  await selectSheetNodeAndFocusEditor(page)
  await page.keyboard.type('zz')
  expect(await editorHtml(page), 'typing does not replace the sheet').toContain('<sheet')
  expect(await editorHtml(page)).not.toContain('zz')

  // Backspace on the selected sheet is not swallowed in a text document: it
  // reaches the app's own "Delete embedded content?" confirmation, as on main.
  await selectSheetNodeAndFocusEditor(page)
  await page.keyboard.press('Backspace')
  const confirm = page.getByRole('dialog').filter({ hasText: 'Delete embedded content?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await editorHtml(page)).toContain('Before the sheet')
})
