/**
 * An .xlsx imported from the dashboard and opened in the spreadsheet viewer.
 *
 * Guards (#141, #143):
 *   - a formula that uses a defined name (`=B1*TauxTVA`) computes in the app:
 *     changing B1 recalculates it, where fortune-sheet alone has no names and
 *     gives #NAME?;
 *   - the import report appears and counts what was kept, approximated and
 *     lost (here a chart, added to the package by hand);
 *   - the viewer's first save asks before it overwrites a file that lost
 *     items; "Keep the original" leaves the file on the drive unchanged and
 *     says the changes are not saved; "Save over the original" then writes the
 *     file, and "Save a copy" writes a copy next to it and leaves the original,
 *     both with the formula and the defined name back in Excel form.
 *
 * The workbook is built here with exceljs, never a real file. The stub has no
 * upload endpoint (multipart is refused by design and /fs/upload does not
 * exist), so the test plays the bridge's part of the upload: it writes the
 * file where the client asked for it on the stub's drive and answers with
 * that path. Everything after that (the open, the import, the save) is the
 * app against the stub as usual.
 */
import { test, expect } from './support/fixtures'
import type { Locator, Page } from '@playwright/test'
import { openApp, uniqueToken } from './support/app'
import { STUB_ROOT } from './support/env'
import { enterCell, expectCellSum, waitForSheet } from './support/sheet'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { strToU8, unzipSync, zipSync } from 'fflate'

async function fixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Données')
  sheet.getCell('B1').value = 100
  sheet.getCell('B2').value = 0.2
  sheet.getCell('B3').value = { formula: 'B1*TauxTVA', result: 20 }
  workbook.definedNames.add("'Données'!$B$2", 'TauxTVA')
  const parts = unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()))
  parts['xl/charts/chart1.xml'] = strToU8('<c:chartSpace xmlns:c="c"/>')
  return Buffer.from(zipSync(parts))
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** B1 and B3 of the first sheet, and the defined names, of the file on the drive. */
async function readBack(file: string): Promise<{ b1: unknown; b3: string; names: string[] }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(readFileSync(file))
  const sheet = workbook.worksheets[0]
  return {
    b1: sheet.getCell('B1').value,
    b3: sheet.getCell('B3').formula,
    names: workbook.definedNames.model.map((n: { name: string }) => n.name)
  }
}

/**
 * Imports the fixture from the dashboard into the viewer, checks the report,
 * types 200 in B1 and answers "Keep the original". Returns the file on the
 * drive, its hash before any save, and the paused bar.
 */
async function importAndKeepOriginal(
  page: Page
): Promise<{ name: string; onDrive: string; before: string; paused: Locator }> {
  const name = `fidelity-${uniqueToken()}.xlsx`
  const bytes = await fixture()
  let onDrive = ''
  await page.route(/\/fs\/(public\/)?upload\?/, async (route) => {
    const remote = new URL(route.request().url()).searchParams.get('path') || ''
    onDrive = path.join(STUB_ROOT, remote)
    mkdirSync(path.dirname(onDrive), { recursive: true })
    writeFileSync(onDrive, bytes)
    await route.fulfill({ json: { path: remote } })
  })

  await openApp(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a file' }).click()
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: bytes
  })
  await page.getByRole('button', { name: 'Open in Spreadsheet' }).click()
  await waitForSheet(page)
  const before = sha(onDrive)

  const report = page.getByRole('status', { name: 'Import report' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await expect(report).toContainText(`Imported ${name}, with differences`)
  await expect(report).toContainText('Formulas: 1 kept')
  await expect(report).toContainText('Defined names: 1 approximated')
  await expect(report).toContainText('Charts: 1 lost')
  await report.getByRole('button', { name: 'Close' }).click()
  await expect(report).toBeHidden()

  // fortune-excel brings the cached values in as text (see #132), so the
  // status area cannot sum them yet; the recalculated result is a number.
  await enterCell(page, 'B1', '200')

  const confirm = page.getByRole('dialog').filter({ hasText: 'Save over the original file?' })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('Charts: 1')
  await confirm.getByRole('button', { name: 'Keep the original' }).click()
  await expect(confirm).toBeHidden()
  const paused = page.getByRole('alert').filter({ hasText: `Changes are not saved to ${name}` })
  await expect(paused).toBeVisible()

  await expectCellSum(page, 'B3', '40')
  expect(sha(onDrive), 'the original file is left as it was').toBe(before)
  return { name, onDrive, before, paused }
}

test('an .xlsx computes its defined names, reports what it lost and asks before overwriting', async ({
  page
}) => {
  const { paused } = await importAndKeepOriginal(page)
  await expect(paused.getByRole('button', { name: 'Save a copy' })).toBeVisible()
  await expect(paused.getByRole('button', { name: 'Save over the original' })).toBeVisible()
})

test('"Save over the original" writes the file, with the formula and the name as Excel wrote them', async ({
  page
}) => {
  const { onDrive, before, paused } = await importAndKeepOriginal(page)
  await paused.getByRole('button', { name: 'Save over the original' }).click()
  await expect(paused).toBeHidden()
  await expect.poll(() => sha(onDrive), { timeout: 15_000 }).not.toBe(before)
  const saved = await readBack(onDrive)
  expect(Number(saved.b1)).toBe(200)
  expect(saved.b3).toBe('B1*TauxTVA')
  expect(saved.names).toContain('TauxTVA')
})

test('"Save a copy" writes a copy next to the file and leaves the original', async ({ page }) => {
  const { name, onDrive, before, paused } = await importAndKeepOriginal(page)
  const copy = path.join(path.dirname(onDrive), name.replace(/\.xlsx$/, ' (copy).xlsx'))
  await paused.getByRole('button', { name: 'Save a copy' }).click()
  await expect(paused).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Saving to' })).toContainText(
    `${path.basename(copy)}; ${name} is left as it was`
  )
  await expect.poll(() => existsSync(copy), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => Number((await readBack(copy)).b1), { timeout: 15_000 }).toBe(200)
  const saved = await readBack(copy)
  expect(saved.b3).toBe('B1*TauxTVA')
  expect(saved.names).toContain('TauxTVA')
  expect(sha(onDrive), 'the original file is left as it was').toBe(before)
})
