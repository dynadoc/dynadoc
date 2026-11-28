/**
 * Search and replace across files, in the Search sidebar (#137).
 *
 * Guards:
 *   - a phrase split by formatting (`Acme <b>Corp</b>`) is found;
 *   - Replace all shows a preview first and writes nothing until Apply;
 *   - the document open in the editor is listed but not replaced (its next
 *     save would write the old text back);
 *   - in another file of the folder, only the visible text changes: the link
 *     URL, the attributes and the variable chip are byte for byte the same,
 *     and a `.json` file next to it is not touched;
 *   - a backup is written before the change, and Undo replace puts it back.
 *
 * The stub answers the search channels with src/main/search, the module the
 * desktop main process uses (see tools/stub-bridge/README.md).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './support/fixtures'
import { newTextDocument, typeKeys, uniqueToken } from './support/app'
import { STUB_ROOT } from './support/env'

/** The working folder of the saved document whose index.html contains `text`. */
function documentFolderContaining(text: string): string | null {
  const root = path.join(STUB_ROOT, 'home')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        stack.push(full)
      } else if (name === 'index.html' && readFileSync(full, 'utf8').includes(text)) {
        return dir
      }
    }
  }
  return null
}

test('replace across files changes visible text only, after a preview, and can be undone', async ({
  page
}) => {
  const token = uniqueToken()
  await newTextDocument(page)

  // `Acme ` then `Corp` in bold: one phrase, two text runs on disk.
  await typeKeys(page, `${token} Acme Corp`)
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await page
    .getByTitle(/^Bold — /)
    .first()
    .click()

  let folder: string | null = null
  await expect
    .poll(() => (folder = documentFolderContaining(token)), {
      message: 'the document is saved to the drive',
      timeout: 30_000
    })
    .not.toBeNull()
  await expect
    .poll(() => readFileSync(path.join(folder!, 'index.html'), 'utf8'), { timeout: 30_000 })
    .toMatch(/Acme (<[^>]+>)+Corp/)

  // A second file in the same folder, with the phrase in places a raw
  // replace used to rewrite.
  const notesPath = path.join(folder!, 'notes.html')
  const notes =
    `<p>${token} <a href="https://acme.example/Acme Corp">Acme <em>Corp</em></a>` +
    ` <span name="client" value="Acme Corp" class="variable-chip" data-variable="client">{client}</span></p>`
  writeFileSync(notesPath, notes)
  const varsPath = path.join(folder!, 'notes.json')
  writeFileSync(varsPath, '{"client":"Acme Corp"}')

  // The ribbon's Search button opens the Search sidebar on this document's folder.
  await page.getByText('Search', { exact: true }).first().click()
  // The sidebar wraps the pane in an element with the same id; the pane is the inner one.
  const pane = page.locator('#search-pane').last()
  await expect(pane).toBeVisible()
  await pane.getByPlaceholder('Search', { exact: true }).fill('Acme Corp')
  await expect(pane.getByText(/2 results in 2 files/)).toBeVisible()

  // Open the replace row and ask for Replace all.
  await pane.locator('button:has(i.ph-caret-right)').first().click()
  await pane.getByPlaceholder('Replace', { exact: true }).fill('Globex')
  await pane.getByRole('button', { name: 'Replace All' }).click()

  const preview = pane.getByRole('region', { name: 'Replace preview' })
  await expect(preview).toBeVisible()
  await expect(
    preview.getByText('Open in an editor: close it to replace in this file.')
  ).toBeVisible()
  await expect(preview.getByText(/Replace 1 occurrence\(s\) in 1 file\(s\)\?/)).toBeVisible()
  // Nothing written yet.
  expect(readFileSync(notesPath, 'utf8')).toBe(notes)

  await preview.getByRole('button', { name: 'Apply' }).click()
  await expect(pane.getByRole('status')).toContainText('Replaced 1 occurrence(s) in 1 file(s).')

  expect(readFileSync(notesPath, 'utf8')).toBe(
    `<p>${token} <a href="https://acme.example/Acme Corp">Globex<em></em></a>` +
      ` <span name="client" value="Acme Corp" class="variable-chip" data-variable="client">{client}</span></p>`
  )
  expect(readFileSync(varsPath, 'utf8')).toBe('{"client":"Acme Corp"}')
  expect(readFileSync(path.join(folder!, 'index.html'), 'utf8')).toMatch(/Acme (<[^>]+>)+Corp/)

  const backupRoot = path.join(STUB_ROOT, 'cache', 'search-replace-backups')
  expect(existsSync(path.join(backupRoot, 'replace-log.jsonl'))).toBe(true)

  await pane.getByRole('button', { name: 'Undo replace' }).click()
  await expect(pane.getByRole('status')).toContainText('Restored 1 file(s).')
  expect(readFileSync(notesPath, 'utf8')).toBe(notes)
})
