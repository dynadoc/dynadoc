/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */
/**
 * Gate: formulas, defined names and the fidelity report of the .xlsx import
 * (services/conversion/xlsxImportFidelity.ts and importFidelity.ts).
 *
 * A workbook is built with exceljs (no real file): shared formulas with an
 * absolute part, a one-cell and a three-cell array formula, a quoted
 * cross-sheet reference, defined names (a range, a constant, a sheet-scoped
 * one, one with an accented sheet, one unused), a formula reading another
 * workbook, a comment, a data validation rule, a conditional format, sheet
 * protection and an image. What exceljs cannot write (the constant and the
 * sheet-scoped names, a chart, a pivot cache, an external link, a VBA
 * project, a shape and a text box) is added to the zip afterwards.
 *
 * Both import paths are run: fortune-excel (the primary converter) and the
 * fallback, each followed by restoreWorkbookContent(). Then the round trip:
 * one input changes, fortune-sheet's own formula engine recalculates,
 * fortune-excel exports, restoreXlsxExport() puts the names back, and exceljs
 * and the importer reopen the result.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const conversion = path.join(repoRoot, 'src/renderer/src/services/conversion')

const outDir = mkdtempSync(path.join(tmpdir(), 'xlsx-fidelity-smoke-'))
const entry = path.join(outDir, 'entry.ts')
const compiled = path.join(outDir, 'xlsx-fidelity.mjs')
writeFileSync(
  entry,
  [
    `export { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'`,
    `export * from ${JSON.stringify(path.join(conversion, 'importFidelity.ts'))}`,
    `export * from ${JSON.stringify(path.join(conversion, 'xlsxImportFidelity.ts'))}`
  ].join('\n')
)
const build = spawnSync(
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${compiled}`,
    `--alias:fflate=${path.join(repoRoot, 'node_modules', 'fflate')}`
  ],
  { encoding: 'utf-8', cwd: repoRoot }
)
if (build.status !== 0) {
  console.error(`[xlsx-fidelity] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const M = await import(pathToFileURL(compiled).href)
const require = createRequire(path.join(repoRoot, 'package.json'))
const ExcelJS = require('exceljs')
const FortuneExcel = require('@corbe30/fortune-excel')
const Core = require('@fortune-sheet/core')

// jszip (inside fortune-excel) reads a File through FileReader, which Node
// does not have. The browser's, reduced to what jszip calls.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (result) => this.onload({ target: { result } }),
      (error) => this.onerror({ target: { error } })
    )
  }
}

// fortune-excel names imported images after window.navigator.userAgent.
globalThis.window = { navigator: { userAgent: 'node' } }

const results = []
const json = JSON.stringify
const check = (what, passed, detail = '') => results.push([what, Boolean(passed), detail])
const decode = (address) => {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address)
  return { r: Number(digits) - 1, c: letters.charCodeAt(0) - 65 }
}

// --- the workbook ------------------------------------------------------------
const wb = new ExcelJS.Workbook()
const data = wb.addWorksheet('Data')
const summary = wb.addWorksheet('Summary Sheet')
const vat = wb.addWorksheet('Données')
data.getCell('A1').value = 1
data.getCell('A2').value = 2
data.getCell('A3').value = 3
data.getCell('B1').value = { formula: 'A1*2+$A$1', result: 3, shareType: 'shared', ref: 'B1:B3' }
data.getCell('B2').value = { sharedFormula: 'B1', result: 5 }
data.getCell('B3').value = { sharedFormula: 'B1', result: 7 }
data.getCell('C1').value = {
  formula: 'SUM(A1:A3*B1:B3)',
  result: 34,
  shareType: 'array',
  ref: 'C1'
}
data.getCell('D1').value = { formula: 'A1:A3*10', result: 10, shareType: 'array', ref: 'D1:D3' }
data.getCell('D2').value = 20
data.getCell('D3').value = 30
data.getCell('E1').value = { formula: '"Total: "&A1', result: 'Total: 1' }
data.getCell('F1').value = 'merged'
data.mergeCells('F1:F2')
data.getCell('A1').note = 'Check this value'
data.getCell('A2').dataValidation = { type: 'list', allowBlank: true, formulae: ['"1,2,3"'] }
data.addConditionalFormatting({
  ref: 'A1:A3',
  rules: [{ type: 'expression', formulae: ['A1>1'], style: { font: { bold: true } } }]
})
summary.getCell('A1').value = { formula: 'SUM(Data!A1:A3)', result: 6 }
summary.getCell('A2').value = { formula: 'SUM(Total)', result: 6 }
summary.getCell('A3').value = { formula: "'Summary Sheet'!A1+1", result: 7 }
summary.getCell('A4').value = { formula: '[1]Prices!A1', result: 42 }
summary.getCell('A5').value = { formula: 'Rate*Local*10', result: 10 }
await summary.protect('', {})
vat.getCell('B1').value = 100
vat.getCell('B2').value = 0.2
vat.getCell('B3').value = { formula: 'B1*TauxTVA', result: 20 }
wb.definedNames.add('Data!$A$1:$A$3', 'Total')
wb.definedNames.add('Data!$B$1', 'Unused')
wb.definedNames.add("'Données'!$B$2", 'TauxTVA')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)
data.addImage(wb.addImage({ buffer: png, extension: 'png' }), 'G1:H3')

const parts = M.unzipSync(new Uint8Array(await wb.xlsx.writeBuffer()))
parts['xl/workbook.xml'] = M.strToU8(
  M.strFromU8(parts['xl/workbook.xml']).replace(
    '</definedNames>',
    '<definedName name="Rate">0.5</definedName>' +
      '<definedName name="Local" localSheetId="1">Data!$A$2</definedName>' +
      '<definedName name="Local" localSheetId="0">Data!$A$3</definedName>' +
      '</definedNames>'
  )
)
parts['xl/charts/chart1.xml'] = M.strToU8('<c:chartSpace xmlns:c="c"/>')
parts['xl/pivotCache/pivotCacheDefinition1.xml'] = M.strToU8('<pivotCacheDefinition/>')
parts['xl/externalLinks/externalLink1.xml'] = M.strToU8('<externalLink/>')
parts['xl/vbaProject.bin'] = new Uint8Array([0, 1, 2])
parts['xl/drawings/drawing9.xml'] = M.strToU8(
  '<xdr:wsDr xmlns:xdr="x" xmlns:a="a"><xdr:twoCellAnchor>' +
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Box"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr/></xdr:sp>' +
    '</xdr:twoCellAnchor><xdr:twoCellAnchor>' +
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="Arrow"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>' +
    '</xdr:twoCellAnchor></xdr:wsDr>'
)
const bytes = M.zipSync(parts)

// --- the two import paths ---------------------------------------------------
const content = await M.readXlsxWorkbook(ExcelJS, bytes)
const scan = M.scanXlsxPackage(bytes)
check(
  'the scan reads the defined names, constants and sheet scopes included',
  json(scan.definedNames.map((n) => [n.name, n.ref, n.sheetName ?? null])) ===
    json([
      ['Total', 'Data!$A$1:$A$3', null],
      ['Unused', 'Data!$B$1', null],
      ['TauxTVA', "'Données'!$B$2", null],
      ['Rate', '0.5', null],
      ['Local', 'Data!$A$2', 'Summary Sheet'],
      ['Local', 'Data!$A$3', 'Data']
    ]),
  json(scan.definedNames)
)

let primarySheets = []
await FortuneExcel.transformExcelToFortune(
  new File([bytes], 'fixture.xlsx'),
  (sheets) => {
    primarySheets = sheets
  },
  () => {},
  { current: {} }
)
check(
  'fortune-excel converts the fixture',
  primarySheets.length === 3,
  `${primarySheets.length} sheets`
)

let idCount = 0
const paths = {
  primary: M.createImportFidelityCollector('xlsx', 'fixture.xlsx'),
  fallback: M.createImportFidelityCollector('xlsx', 'fixture.xlsx')
}
const restored = {
  primary: M.restoreWorkbookContent(primarySheets, content, scan.definedNames, paths.primary),
  fallback: M.restoreWorkbookContent(
    M.sheetsFromWorkbook(content, () => `sheet-${++idCount}`),
    content,
    scan.definedNames,
    paths.fallback
  )
}
M.reportXlsxPackage(scan, restored.primary, paths.primary)
M.reportXlsxPackage(scan, restored.fallback, paths.fallback)

const cellOf = (sheets, sheetName, address) => {
  const { r, c } = decode(address)
  const sheet = sheets.find((s) => s.name === sheetName)
  return sheet?.celldata.find((cell) => cell.r === r && cell.c === c)?.v
}

// [sheet, cell, formula fortune-sheet computes, the user's formula when it differs]
const expectedFormulas = [
  ['Data', 'B1', '=A1*2+$A$1'],
  ['Data', 'B2', '=A2*2+$A$1'],
  ['Data', 'B3', '=A3*2+$A$1'],
  ['Data', 'C1', '=SUM(A1:A3*B1:B3)'],
  ['Data', 'D1', '=A1:A3*10'],
  ['Data', 'E1', '="Total: "&A1'],
  ['Summary Sheet', 'A1', '=SUM(Data!A1:A3)'],
  ['Summary Sheet', 'A2', '=SUM(Data!$A$1:$A$3)', '=SUM(Total)'],
  ['Summary Sheet', 'A3', "='Summary Sheet'!A1+1"],
  ['Summary Sheet', 'A5', '=(0.5)*Data!$A$2*10', '=Rate*Local*10'],
  ['Données', 'B3', "=B1*'Données'!$B$2", '=B1*TauxTVA']
]
for (const [name, sheets] of Object.entries(restored)) {
  for (const [sheetName, address, formula, source] of expectedFormulas) {
    const cell = cellOf(sheets, sheetName, address)
    check(
      `${name}: ${sheetName}!${address} computes ${formula}${source ? `, keeps ${source}` : ''}`,
      cell?.f === formula && cell?.xlsxFormula === source,
      json([cell?.f, cell?.xlsxFormula])
    )
  }
  const named = cellOf(sheets, 'Données', 'B3')
  check(
    `${name}: the cell keeps the names its formula uses`,
    json(named?.xlsxNames) === json([{ name: 'TauxTVA', ref: "'Données'!$B$2" }]),
    json(named?.xlsxNames)
  )
  const external = cellOf(sheets, 'Summary Sheet', 'A4')
  check(
    `${name}: a formula reading another workbook keeps its value, not the formula`,
    external && external.f === undefined && Number(external.v) === 42,
    json(external)
  )
  const spilled = cellOf(sheets, 'Data', 'D3')
  check(
    `${name}: an array's other cells keep their values`,
    Number(spilled?.v) === 30,
    json(spilled)
  )
  const merge = sheets.find((s) => s.name === 'Data').config?.merge?.['0_5']
  check(
    `${name}: the merged cells stay merged`,
    json(merge) === json({ r: 0, c: 5, rs: 2, cs: 1 }),
    json(merge)
  )
  const noted = cellOf(sheets, 'Data', 'A1')
  check(
    `${name}: the comment becomes a cell note`,
    noted?.ps?.value === 'Check this value' && Number(noted?.v) === 1,
    json(noted?.ps)
  )
  const chained = sheets.find((s) => s.name === 'Data').calcChain
  check(
    `${name}: the calculation chain lists every formula of the sheet, with the sheet's id`,
    chained.length === 6 && chained.every((item) => item.id === sheets[0].id),
    json(chained)
  )
}

// --- the report -------------------------------------------------------------
const byKind = (report) => Object.fromEntries(report.entries.map((e) => [e.kind, e]))
const expectedReport = {
  formulas: { converted: 9, approximated: 3, lost: 0 },
  definedNames: { converted: 0, approximated: 4, lost: 2 },
  comments: { converted: 1, approximated: 0, lost: 0 },
  shapes: { converted: 0, approximated: 0, lost: 1 },
  textBoxes: { converted: 0, approximated: 0, lost: 1 },
  charts: { converted: 0, approximated: 0, lost: 1 },
  conditionalFormatting: { converted: 0, approximated: 0, lost: 1 },
  pivotCaches: { converted: 0, approximated: 0, lost: 1 },
  externalLinks: { converted: 0, approximated: 0, lost: 1 },
  protection: { converted: 0, approximated: 0, lost: 1 },
  macros: { converted: 0, approximated: 0, lost: 1 }
}
const primaryReport = byKind(paths.primary.report())
const fallbackReport = byKind(paths.fallback.report())
for (const [kind, counts] of Object.entries(expectedReport)) {
  for (const [name, report] of [
    ['primary', primaryReport],
    ['fallback', fallbackReport]
  ]) {
    const got = report[kind]
    check(
      `${name} report: ${kind} ${json(counts)}`,
      got &&
        got.converted === counts.converted &&
        got.approximated === counts.approximated &&
        got.lost === counts.lost,
      json(got)
    )
  }
}
check(
  'primary report: the image and the validation rule fortune-excel converts are counted as kept',
  primaryReport.images?.converted === 1 && primaryReport.dataValidation?.converted === 1,
  json([primaryReport.images, primaryReport.dataValidation])
)
check(
  'fallback report: the fallback keeps no image and no validation, and says so',
  fallbackReport.images?.lost === 1 && fallbackReport.dataValidation?.lost === 1,
  json([fallbackReport.images, fallbackReport.dataValidation])
)
const lines = M.formatFidelityLines(paths.primary.report())
check(
  'the report reads one line per kind',
  lines[0] === 'Formulas: 9 kept, 3 approximated' && lines.includes('Charts: 1 lost'),
  json(lines)
)
check('the report says something was lost', M.hasFidelityLoss(paths.primary.report()))
check(
  'a clean import has nothing to report as lost',
  !M.hasFidelityLoss({
    version: 1,
    source: 'xlsx',
    fileName: 'x',
    entries: [{ kind: 'formulas', converted: 3, approximated: 0, lost: 0, notes: [] }]
  })
)

// --- defined names, on their own --------------------------------------------
const names = [
  { name: 'Rate', ref: '0.2' },
  { name: 'Local', ref: 'Data!$C$1', sheetName: 'Two' },
  { name: 'Local', ref: 'Data!$C$9', sheetName: 'One' },
  { name: 'Prices', ref: "'Price list'!$A$1:$A$9" },
  { name: 'Gross', ref: 'Net*(1+Rate)' },
  { name: 'Net', ref: 'Data!$D$1' }
]
const used = []
const inlined = M.inlineDefinedNames(
  'IF(rate>0,"Rate",SUM(Prices)*Local)+Data!Rate+RATE(1,2,3)+Gross',
  names,
  'Two',
  used
)
check(
  'names are written out: constants in parentheses, sheet scope first, names in names, strings and functions untouched',
  inlined ===
    `IF((0.2)>0,"Rate",SUM('Price list'!$A$1:$A$9)*Data!$C$1)+Data!Rate+RATE(1,2,3)+(Data!$D$1*(1+(0.2)))`,
  inlined
)
check(
  'the names used are collected',
  json(used.map((n) => n.name).sort()) === json(['Gross', 'Local', 'Net', 'Prices', 'Rate']),
  json(used)
)
const renumbered = M.withSheetId({ id: 'a', name: 'S', calcChain: [{ r: 0, c: 0, id: 'a' }] }, 'b')
check(
  'a new sheet id follows into the calculation chain',
  renumbered.calcChain[0].id === 'b',
  json(renumbered)
)

// --- round trip: recalculate, export, reopen --------------------------------
const toTables = (sheets) =>
  sheets.map((sheet) => {
    const rows = Math.max(...sheet.celldata.map((cell) => cell.r)) + 1
    const cols = Math.max(...sheet.celldata.map((cell) => cell.c)) + 1
    const table = Array.from({ length: rows }, () => Array(cols).fill(null))
    for (const cell of sheet.celldata) table[cell.r][cell.c] = cell.v
    return { ...sheet, data: table }
  })
for (const [name, sheets] of Object.entries(restored)) {
  const tables = toTables(sheets)
  const ctx = {
    luckysheetfile: tables,
    currentSheetId: tables[0].id,
    formulaCache: new Core.FormulaCache()
  }
  tables[0].data[0][0] = { ...tables[0].data[0][0], v: 10, m: '10', ct: { fa: 'General', t: 'n' } }
  for (let pass = 0; pass < 3; pass++) {
    for (const table of tables) {
      for (const item of table.calcChain) {
        const cell = table.data[item.r][item.c]
        const [, value] = Core.execfunction(
          ctx,
          cell.f,
          item.r,
          item.c,
          table.id,
          undefined,
          false,
          true
        )
        table.data[item.r][item.c] = { ...cell, v: value, m: String(value) }
      }
    }
  }
  const value = (sheet, address) => {
    const { r, c } = decode(address)
    return tables.find((t) => t.name === sheet).data[r][c]?.v
  }
  const recalculated = [
    ['Data', 'B1', 30],
    ['Data', 'B2', 14],
    ['Summary Sheet', 'A1', 15],
    ['Summary Sheet', 'A2', 15],
    ['Summary Sheet', 'A3', 16],
    ['Summary Sheet', 'A5', 10],
    ['Données', 'B3', 20]
  ]
  for (const [sheet, address, expected] of recalculated) {
    check(
      `${name}: after A1 = 10, ${sheet}!${address} recalculates to ${expected}`,
      Number(value(sheet, address)) === expected,
      json(value(sheet, address))
    )
  }

  // In the fallback run the user rewrites a formula that used a name: the
  // edit wins over the kept formula on export.
  const edited = name === 'fallback'
  if (edited) {
    const { r, c } = decode('A5')
    tables[1].data[r][c] = { ...tables[1].data[r][c], f: '=Data!A2*5' }
  }

  const blob = await FortuneExcel.transformFortuneToExcel(
    { current: { getAllSheets: () => tables, getSheet: () => tables[0] } },
    'xlsx',
    false
  )
  const exported = await M.restoreXlsxExport(
    ExcelJS,
    new Uint8Array(await blob.arrayBuffer()),
    tables
  )
  const reopened = new ExcelJS.Workbook()
  await reopened.xlsx.load(exported)
  for (const [sheet, address, formula, source] of expectedFormulas) {
    const want = edited && address === 'A5' ? '=Data!A2*5' : source || formula
    const cell = reopened.getWorksheet(sheet).getCell(address)
    check(
      `${name}: the exported ${sheet}!${address} holds ${want}`,
      cell.formula === want.slice(1),
      json(cell.value)
    )
  }
  const b1 = reopened.getWorksheet('Data').getCell('B1').value
  check(
    `${name}: the exported B1 carries the recalculated result`,
    Number(b1?.result) === 30,
    json(b1)
  )
  const note = reopened.getWorksheet('Data').getCell('A1').note
  check(
    `${name}: the comment is written back as a note`,
    (typeof note === 'string' ? note : note?.texts?.map((t) => t.text).join('')) ===
      'Check this value',
    json(note)
  )
  const vatCell = reopened.getWorksheet('Données').getCell('B3').value
  check(
    `${name}: the exported =B1*TauxTVA carries its result`,
    Number(vatCell?.result) === 20,
    json(vatCell)
  )
  const exportedNames = M.scanXlsxPackage(exported).definedNames.map((n) => [
    n.name,
    n.ref,
    n.sheetName ?? null
  ])
  const wantNames = [
    ['Total', 'Data!$A$1:$A$3', null],
    ['TauxTVA', "'Données'!$B$2", null],
    ...(edited
      ? []
      : [
          ['Rate', '0.5', null],
          ['Local', 'Data!$A$2', 'Summary Sheet']
        ])
  ]
  check(
    `${name}: the export writes back the names its formulas use${edited ? ', not those of the edited one' : ''}`,
    json([...exportedNames].sort()) === json([...wantNames].sort()),
    json(exportedNames)
  )

  const again = M.restoreWorkbookContent(
    M.sheetsFromWorkbook(await M.readXlsxWorkbook(ExcelJS, exported), () => 'again'),
    await M.readXlsxWorkbook(ExcelJS, exported),
    M.scanXlsxPackage(exported).definedNames,
    M.createImportFidelityCollector('xlsx', 'again.xlsx')
  )
  check(
    `${name}: importing the export again gives the same formulas`,
    expectedFormulas.every(
      ([sheet, address, formula, source]) =>
        (edited && address === 'A5') ||
        (cellOf(again, sheet, address)?.f === formula &&
          cellOf(again, sheet, address)?.xlsxFormula === source)
    ),
    json(expectedFormulas.map(([sheet, address]) => cellOf(again, sheet, address)?.f))
  )
}

rmSync(outDir, { recursive: true, force: true })
let failed = 0
for (const [what, passed, detail] of results) {
  if (!passed) failed++
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${what}${passed ? '' : `  ${detail}`}`)
}
console.log(`[xlsx-fidelity] ${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
