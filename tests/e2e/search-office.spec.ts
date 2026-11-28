/**
 * Search inside Word and Excel files, in the Search sidebar (#136).
 *
 * Guards:
 *   - .docx and .xlsx files in the searched folder are read (they used to be
 *     skipped without a word), with the default "files to include";
 *   - a phrase split across runs of a Word paragraph is found, in the body,
 *     a header and a text box stored twice (found once);
 *   - an Excel formula, a defined name and a sheet name are found;
 *   - each match shows where it is ("header 1, paragraph 1", "Data!B3 (formula)");
 *   - a package that cannot be read is reported as not read;
 *   - Office rows offer no replace.
 *
 * The packages are synthetic, built here with fflate and handwritten XML.
 * The stub answers search:files with src/main/search, the code the desktop
 * main process runs (there, extraction happens in a worker thread).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { newTextDocument, typeKeys, uniqueToken } from './support/app'
import { STUB_ROOT } from './support/env'

/** The working folder of the saved document whose index.html contains `text`. */
function documentFolderContaining(text: string): string | null {
  const stack = [path.join(STUB_ROOT, 'home')]
  while (stack.length) {
    const dir = stack.pop() as string
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (name === 'index.html' && readFileSync(full, 'utf8').includes(text)) return dir
    }
  }
  return null
}

/**
 * The text selected in the editor, and the paragraph it is in (focus goes back
 * to the search box after a click, so the DOM selection is not the editor's).
 */
async function editorSelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.querySelector('.tiptap.ProseMirror') as
      | (HTMLElement & {
          editor?: {
            state: {
              selection: { from: number; to: number; $from: { parent: { textContent: string } } }
              doc: { textBetween: (from: number, to: number) => string }
            }
          }
        })
      | null
    const editor = element?.editor
    if (!editor) return ''
    const { from, to, $from } = editor.state.selection
    return `${editor.state.doc.textBetween(from, to)} | ${$from.parent.textContent}`
  })
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const run = (text: string, bold = false): string =>
  `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const para = (...runs: string[]): string => `<w:p>${runs.join('')}</w:p>`
const textBox = (text: string): string =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${para(run(text))}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
  `<mc:Fallback><w:pict><v:textbox><w:txbxContent>${para(run(text))}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`

function docx(token: string): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8(
      `<w:document ${W}><w:body>${para(run(`${token} Ac`), run('me Corp', true))}` +
        `${para(run('Box: '), textBox(`${token} Acme Corp boxed`))}</w:body></w:document>`
    ),
    'word/header1.xml': strToU8(`<w:hdr ${W}>${para(run(`${token} Acme Corp header`))}</w:hdr>`)
  })
}

function xlsx(token: string): Uint8Array {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="${REL}"><sheets><sheet name="Data${token}" sheetId="1" r:id="rId1"/></sheets>` +
        `<definedNames><definedName name="Rate${token}">Data${token}!$B$1</definedName></definedNames></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet><sheetData><row r="3"><c r="B3"><f>B1*Rate${token}</f><v>0.04</v></c></row></sheetData></worksheet>`
    )
  })
}

test('the Search sidebar finds text inside .docx and .xlsx files, with its location', async ({
  page
}) => {
  const token = uniqueToken()
  await newTextDocument(page)
  await typeKeys(page, `${token} intro`)

  let folder: string | null = null
  await expect
    .poll(() => (folder = documentFolderContaining(token)), {
      message: 'the document is saved to the drive',
      timeout: 30_000
    })
    .not.toBeNull()
  writeFileSync(path.join(folder!, 'Contract.docx'), docx(token))
  writeFileSync(path.join(folder!, 'Budget.xlsx'), xlsx(token))
  writeFileSync(path.join(folder!, 'Broken.docx'), 'not a package')

  await page.getByText('Search', { exact: true }).first().click()
  // The sidebar wraps the pane in an element with the same id; the pane is the inner one.
  const pane = page.locator('#search-pane').last()
  await expect(pane).toBeVisible()
  const input = pane.getByPlaceholder('Search', { exact: true })

  await input.fill(`${token} Acme Corp`)
  await expect(pane.getByText(/3 results in 1 files/)).toBeVisible()
  await expect(pane.getByText('body, paragraph 1', { exact: true })).toBeVisible()
  await expect(pane.getByText('header 1, paragraph 1', { exact: true })).toBeVisible()
  // Stored twice by Word (DrawingML and VML), listed once.
  await expect(pane.getByText(/^text box 1 \(body, paragraph 2\), paragraph 1$/)).toHaveCount(1)
  await expect(pane.getByText(/1 file\(s\) not read/)).toBeVisible()

  await input.fill(`Rate${token}`)
  await expect(pane.getByText(/2 results in 1 files/)).toBeVisible()
  await expect(pane.getByText(`defined name Rate${token}`, { exact: true })).toBeVisible()
  await expect(pane.getByText(`Data${token}!B3 (formula)`, { exact: true })).toBeVisible()

  await input.fill(`Data${token}`)
  await expect(pane.getByText('sheet name', { exact: true })).toBeVisible()

  // Office files are searched, never replaced in.
  await pane.locator('button:has(i.ph-caret-right)').first().click()
  await pane.getByPlaceholder('Replace', { exact: true }).fill('X')
  await expect(pane.getByText('search only', { exact: true }).first()).toBeAttached()
  await expect(pane.getByTitle('Replace in file')).toHaveCount(0)
})

test('clicking a result selects a match split by formatting, in the right paragraph', async ({
  page
}) => {
  const token = uniqueToken()
  await newTextDocument(page)
  // Paragraph 1 plain, paragraph 2 with `Corp` in bold, paragraph 3 plain:
  // the search counts matches per paragraph, formatting runs joined.
  await typeKeys(page, `${token} Acme Corp one`)
  await page.keyboard.press('Enter')
  await typeKeys(page, `${token} Acme Corp two`)
  await page.keyboard.press('Shift+Home')
  for (let i = 0; i < `${token} Acme `.length; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('End')
  for (let i = 0; i < ' two'.length; i += 1) await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 'Corp'.length; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await page
    .getByTitle(/^Bold — /)
    .first()
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await typeKeys(page, `${token} Acme Corp three`)

  await expect
    .poll(() => {
      const folder = documentFolderContaining(`${token} Acme Corp three`)
      return folder ? readFileSync(path.join(folder, 'index.html'), 'utf8') : ''
    })
    .toMatch(/Acme (<[^>]+>)+Corp(<[^>]+>)+ two/)

  await page.getByText('Search', { exact: true }).first().click()
  const pane = page.locator('#search-pane').last()
  await pane.getByPlaceholder('Search', { exact: true }).fill(`${token} Acme Corp`)
  await expect(pane.getByText(/3 results in 1 files/)).toBeVisible()

  // The third result is in the third paragraph, not in the first.
  await pane.locator('.search-match-row').nth(2).click()
  await expect
    .poll(() => editorSelection(page))
    .toBe(`${token} Acme Corp | ${token} Acme Corp three`)

  // The second result spans the bold run.
  await pane.locator('.search-match-row').nth(1).click()
  await expect.poll(() => editorSelection(page)).toBe(`${token} Acme Corp | ${token} Acme Corp two`)
})
