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
 *     says the changes are not saved, with a way to save a copy.
 *
 * The workbook is built here with exceljs, never a real file. The stub has no
 * upload endpoint (multipart is refused by design and /fs/upload does not
 * exist), so the test plays the bridge's part of the upload: it writes the
 * file where the client asked for it on the stub's drive and answers with
 * that path. Everything after that (the open, the import, the save) is the
 * app against the stub as usual.
 */
import { test, expect } from './support/fixtures'
import { openApp, uniqueToken } from './support/app'
import { STUB_ROOT } from './support/env'
import { enterCell, expectCellSum, waitForSheet } from './support/sheet'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

test('an .xlsx computes its defined names, reports what it lost and asks before overwriting', async ({
  page
}) => {
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
  await expect(paused.getByRole('button', { name: 'Save a copy' })).toBeVisible()

  await expectCellSum(page, 'B3', '40')
  expect(sha(onDrive), 'the original file is left as it was').toBe(before)
})
