/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */
/**
 * Gate: the .xlsx import (services/conversion/xlsxImport.ts,
 * xlsxImportFidelity.ts and importFidelity.ts): formulas, defined names,
 * comments, the import report, and the export that writes back what the
 * import kept aside.
 *
 * A workbook is built with exceljs (no real file): shared formulas with an
 * absolute part, a one-cell and a three-cell array formula, a quoted
 * cross-sheet reference, defined names (a range, a constant, sheet-scoped
 * ones, one on an accented sheet, one unused, a print area), a formula
 * reading another workbook and one reading a table, a comment, a data
 * validation rule, a conditional format, a filter, frozen panes, sheet
 * protection, a merge and an image. What exceljs cannot write (constant and
 * sheet-scoped names, a chart, a table, a pivot cache, an external link, a
 * VBA project, a shape, a text box, a form control, a comment reply, a part
 * nobody knows) is added to the zip afterwards.
 *
 * Both converters are run: importXlsxFile() (fortune-excel first) and the
 * exceljs fallback, then the round trip: one input changes, fortune-sheet's
 * own formula engine recalculates, fortune-excel exports, restoreXlsxExport()
 * writes back what was kept aside, and exceljs and the importer reopen the
 * result. Then "replace current worksheet", which keeps one sheet under
 * another name, and the report reader.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const conversion = path.join(repoRoot, 'src/renderer/src/services/conversion')

// Inside node_modules, so the bundle can import the packages it leaves out.
const outDir = path.join(repoRoot, 'node_modules', '.cache', `xlsx-fidelity-smoke-${process.pid}`)
mkdirSync(outDir, { recursive: true })
const entry = path.join(outDir, 'entry.ts')
const compiled = path.join(outDir, 'xlsx-fidelity.mjs')
writeFileSync(
  entry,
  [
    `export { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'`,
    `export * from ${JSON.stringify(path.join(conversion, 'importFidelity.ts'))}`,
    `export * from ${JSON.stringify(path.join(conversion, 'xlsxImportFidelity.ts'))}`,
    `export * from ${JSON.stringify(path.join(conversion, 'xlsxImport.ts'))}`
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
    '--external:@corbe30/fortune-excel',
    '--external:exceljs',
    '--external:xlsx',
    `--alias:fflate=${path.join(repoRoot, 'node_modules', 'fflate')}`
  ],
  { encoding: 'utf-8', cwd: repoRoot }
)
if (build.status !== 0) {
  console.error(`[xlsx-fidelity] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

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

const M = await import(pathToFileURL(compiled).href)
const require = createRequire(path.join(repoRoot, 'package.json'))
const ExcelJS = require('exceljs')
const FortuneExcel = require('@corbe30/fortune-excel')
const Core = require('@fortune-sheet/core')

const results = []
const json = JSON.stringify
const check = (what, passed, detail = '') => results.push([what, Boolean(passed), detail])
const decode = (address) => {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address)
  return { r: Number(digits) - 1, c: letters.charCodeAt(0) - 65 }
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// --- the workbook ------------------------------------------------------------
const wb = new ExcelJS.Workbook()
const data = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] })
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
data.getCell('E5').value = { formula: 'SUM(Table1[Amount])', result: 9 }
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
summary.autoFilter = 'A1:A5'
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
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$E$5</definedName>' +
      '</definedNames>'
  )
)
parts['xl/charts/chart1.xml'] = M.strToU8('<c:chartSpace xmlns:c="c"/>')
parts['xl/tables/table1.xml'] = M.strToU8(
  '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" ' +
    'displayName="Table1" ref="J1:J2"><tableColumns count="1"><tableColumn id="1" name="Amount"/>' +
    '</tableColumns></table>'
)
parts['xl/pivotCache/pivotCacheDefinition1.xml'] = M.strToU8('<pivotCacheDefinition/>')
parts['xl/externalLinks/externalLink1.xml'] = M.strToU8('<externalLink/>')
parts['xl/vbaProject.bin'] = new Uint8Array([0, 1, 2])
parts['xl/timelines/timeline1.xml'] = M.strToU8('<timelines/>')
parts['xl/threadedComments/threadedComment1.xml'] = M.strToU8(
  '<ThreadedComments><threadedComment ref="A1" id="{1}"/>' +
    '<threadedComment ref="A1" id="{2}" parentId="{1}"/></ThreadedComments>'
)
parts['xl/drawings/vmlDrawing9.vml'] = M.strToU8(
  '<xml><v:shape><x:ClientData ObjectType="Button"/></v:shape>' +
    '<v:shape><x:ClientData ObjectType="Note"/></v:shape></xml>'
)
parts['xl/drawings/drawing9.xml'] = M.strToU8(
  '<xdr:wsDr xmlns:xdr="x" xmlns:a="a"><xdr:twoCellAnchor>' +
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Box"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr/></xdr:sp>' +
    '</xdr:twoCellAnchor><xdr:twoCellAnchor>' +
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="Arrow"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>' +
    '</xdr:twoCellAnchor></xdr:wsDr>'
)
const bytes = M.zipSync(parts)

// --- the two import paths ---------------------------------------------------
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
      ['Local', 'Data!$A$3', 'Data'],
      ['_xlnm.Print_Area', 'Data!$A$1:$E$5', 'Data']
    ]),
  json(scan.definedNames)
)

const primary = await M.importXlsxFile(
  new File([bytes], 'fixture.xlsx', { type: XLSX_TYPE }),
  () => 'unused'
)
check('importXlsxFile converts the fixture with fortune-excel', primary.sheets.length === 3)

let idCount = 0
const content = await M.readXlsxWorkbook(ExcelJS, bytes)
const fallbackCollector = M.createImportFidelityCollector({ name: 'fixture.xlsx', kind: 'xlsx' })
const fallbackSheets = M.restoreWorkbookContent(
  M.sheetsFromWorkbook(content, () => `sheet-${++idCount}`),
  content,
  scan.definedNames,
  fallbackCollector
)
M.reportXlsxPackage(scan, fallbackSheets, fallbackCollector)
const restored = { primary: primary.sheets, fallback: fallbackSheets }
const reports = { primary: primary.report, fallback: fallbackCollector.report() }

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
  const kept = cellOf(sheets, 'Data', 'A1')?.xlsxWorkbook?.names?.map((n) => n.name)
  check(
    `${name}: the first sheet's A1 keeps every defined name, print area included`,
    json(kept) === json(scan.definedNames.map((n) => n.name)),
    json(kept)
  )
  const external = cellOf(sheets, 'Summary Sheet', 'A4')
  check(
    `${name}: a formula reading another workbook keeps its value, not the formula`,
    external && external.f === undefined && Number(external.v) === 42,
    json(external)
  )
  check(
    `${name}: an array formula keeps its range for the export`,
    json(cellOf(sheets, 'Data', 'D1')?.xlsxArray) === json({ ref: 'D1:D3', f: '=A1:A3*10' }),
    json(cellOf(sheets, 'Data', 'D1')?.xlsxArray)
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
    chained.length === 7 && chained.every((item) => item.id === sheets[0].id),
    json(chained)
  )
}

// --- the report -------------------------------------------------------------
const totals = (report) => {
  const byKind = {}
  for (const item of report.items) {
    byKind[item.kind] ||= { converted: 0, approximated: 0, lost: 0 }
    byKind[item.kind][item.status] += item.count
  }
  return byKind
}
const expectedReport = {
  formulas: { converted: 9, approximated: 2, lost: 2 },
  definedNames: { converted: 0, approximated: 6, lost: 0 },
  comments: { converted: 1, approximated: 0, lost: 1 },
  shapes: { converted: 0, approximated: 0, lost: 1 },
  textBoxes: { converted: 0, approximated: 0, lost: 1 },
  formControls: { converted: 0, approximated: 0, lost: 1 },
  charts: { converted: 0, approximated: 0, lost: 1 },
  tables: { converted: 0, approximated: 0, lost: 1 },
  conditionalFormatting: { converted: 0, approximated: 0, lost: 1 },
  autoFilter: { converted: 0, approximated: 0, lost: 1 },
  frozenPanes: { converted: 0, approximated: 0, lost: 1 },
  pivotCaches: { converted: 0, approximated: 0, lost: 1 },
  externalLinks: { converted: 0, approximated: 0, lost: 1 },
  protection: { converted: 0, approximated: 0, lost: 1 },
  macros: { converted: 0, approximated: 0, lost: 1 },
  otherParts: { converted: 0, approximated: 0, lost: 1 }
}
for (const [name, report] of Object.entries(reports)) {
  const got = totals(report)
  for (const [kind, counts] of Object.entries(expectedReport)) {
    check(
      `${name} report: ${kind} ${json(counts)}`,
      json(got[kind]) === json(counts),
      json(got[kind])
    )
  }
  check(`${name} report: complete`, report.unavailable.length === 0, json(report.unavailable))
}
const primaryTotals = totals(reports.primary)
const fallbackTotals = totals(reports.fallback)
check(
  'primary report: the image and the validation rule fortune-excel converts are counted as kept',
  primaryTotals.images?.converted === 1 && primaryTotals.dataValidation?.converted === 1,
  json([primaryTotals.images, primaryTotals.dataValidation])
)
check(
  'fallback report: the fallback keeps no image and no validation, and says where',
  fallbackTotals.images?.lost === 1 &&
    fallbackTotals.dataValidation?.lost === 1 &&
    json(reports.fallback.items.find((i) => i.kind === 'dataValidation').places) ===
      json([{ sheet: 'Data', cell: 'A2' }]),
  json(reports.fallback.items.filter((i) => i.kind === 'dataValidation'))
)
const lostFormulas = reports.primary.items.filter(
  (i) => i.kind === 'formulas' && i.status === 'lost'
)
check(
  'the report says where the lost formulas were',
  json(lostFormulas.flatMap((i) => i.places).sort((a, b) => a.sheet.localeCompare(b.sheet))) ===
    json([
      { sheet: 'Data', cell: 'E5' },
      { sheet: 'Summary Sheet', cell: 'A4' }
    ]),
  json(lostFormulas)
)
check(
  'the report has the agreed source and version',
  reports.primary.version === 1 &&
    reports.primary.source.name === 'fixture.xlsx' &&
    reports.primary.source.kind === 'xlsx' &&
    /^[0-9a-f]{64}$/.test(reports.primary.source.sha256 || ''),
  json(reports.primary.source)
)
const lines = M.formatFidelityLines(reports.primary)
check(
  'the report reads one line per kind',
  lines[0] === 'Formulas: 9 kept, 2 approximated, 2 lost' && lines.includes('Charts: 1 lost'),
  json(lines)
)
check(
  'the notes say why and where',
  M.formatFidelityNotes(reports.primary).some(
    (note) =>
      note.startsWith('Formulas: formulas that read another workbook') &&
      note.includes('Summary Sheet!A4')
  ),
  json(M.formatFidelityNotes(reports.primary))
)
check(
  'something was lost, so a save over the original must ask',
  M.hasFidelityLoss(reports.primary) && M.needsSaveConfirmation(reports.primary)
)
const clean = {
  version: 1,
  source: { name: 'x.xlsx', kind: 'xlsx' },
  unavailable: [],
  items: [{ kind: 'formulas', status: 'converted', count: 3 }]
}
check(
  'a clean import shows no panel and needs no confirmation',
  !M.hasFidelityLoss(clean) && !M.needsSaveConfirmation(clean)
)
check(
  'an incomplete report needs a confirmation',
  M.needsSaveConfirmation({ ...clean, unavailable: ['the parts could not be listed'] })
)
const parsed = M.parseImportFidelityReport(
  JSON.stringify({
    ...clean,
    items: [...clean.items, { kind: 'smartArt', status: 'lost', count: 2, reason: 'not converted' }]
  })
)
check(
  'the reader keeps kinds it does not know and labels them by key',
  parsed && M.formatFidelityLines(parsed).includes('smartArt: 2 lost'),
  json(parsed)
)
check(
  'the reader refuses another version',
  M.parseImportFidelityReport({ ...clean, version: 2 }) === null
)

// --- defined names and sheet references, on their own -----------------------
const names = [
  { name: 'Rate', ref: '0.2' },
  { name: 'Local', ref: 'Data!$C$1', sheetName: 'Two' },
  { name: 'Local', ref: 'Data!$C$9', sheetName: 'One' },
  { name: 'Prices', ref: "'Price list'!$A$1:$A$9" },
  { name: 'Gross', ref: 'Net*(1+Rate)' },
  { name: 'Net', ref: 'Data!$D$1' },
  { name: 'Prev', ref: 'Data!A1' }
]
const used = []
const keptAside = []
const inlined = M.inlineDefinedNames(
  'IF(rate>0,"Rate",SUM(Prices)*Local)+Data!Rate+RATE(1,2,3)+Gross+Prev',
  names,
  'Two',
  used,
  keptAside
)
check(
  'names are written out: constants in parentheses, sheet scope first, names in names, strings and functions untouched, relative names kept',
  inlined ===
    `IF((0.2)>0,"Rate",SUM('Price list'!$A$1:$A$9)*Data!$C$1)+Data!Rate+RATE(1,2,3)+(Data!$D$1*(1+(0.2)))+Prev`,
  inlined
)
check(
  'the names used and the names left are collected',
  json(used.map((n) => n.name).sort()) === json(['Gross', 'Local', 'Net', 'Prices', 'Rate']) &&
    json(keptAside.map((n) => n.name)) === json(['Prev']),
  json([used, keptAside])
)
check(
  'a sheet rename follows quoted and plain references, not strings or other sheets',
  M.renameSheetReferences(`'Données'!B2+Données!C1+"Données!A1"+Other!A1`, 'Données', 'Sheet 1') ===
    `'Sheet 1'!B2+'Sheet 1'!C1+"Données!A1"+Other!A1`,
  M.renameSheetReferences(`'Données'!B2+Données!C1+"Données!A1"+Other!A1`, 'Données', 'Sheet 1')
)
check(
  'referencedSheets lists the sheets a formula reads',
  json(M.referencedSheets(`SUM('My sheet'!A1:A2)+Data!B1+[1]Prices!A1`)) ===
    json(['My sheet', 'Data']),
  json(M.referencedSheets(`SUM('My sheet'!A1:A2)+Data!B1+[1]Prices!A1`))
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
const recalculate = (tables) => {
  const ctx = {
    luckysheetfile: tables,
    currentSheetId: tables[0].id,
    formulaCache: new Core.FormulaCache()
  }
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
}
const exportTables = async (tables) => {
  const blob = await FortuneExcel.transformFortuneToExcel(
    { current: { getAllSheets: () => tables, getSheet: () => tables[0] } },
    'xlsx',
    false
  )
  const restoredExport = await M.withDefinedNamesRestored(
    new Uint8Array(await blob.arrayBuffer()),
    tables
  )
  return restoredExport
}

for (const [name, sheets] of Object.entries(restored)) {
  const tables = toTables(sheets)
  tables[0].data[0][0] = { ...tables[0].data[0][0], v: 10, m: '10', ct: { fa: 'General', t: 'n' } }
  recalculate(tables)
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

  const { bytes: exported, restored: wroteBack } = await exportTables(tables)
  check(`${name}: the export writes back what the import kept aside`, wroteBack)
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
  const arrays = ['C1', 'D1'].map((address) => reopened.getWorksheet('Data').getCell(address).value)
  check(
    `${name}: array formulas are exported as array formulas with their range`,
    arrays[0]?.shareType === 'array' &&
      arrays[0]?.ref === 'C1' &&
      arrays[1]?.shareType === 'array' &&
      arrays[1]?.ref === 'D1:D3',
    json(arrays)
  )
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
  const exportedNames = M.scanXlsxPackage(exported)
    .definedNames.map((n) => [n.name, n.ref, n.sheetName ?? null])
    .filter(([n]) => n !== '_xlnm._FilterDatabase')
  const wantNames = scan.definedNames.map((n) => [n.name, n.ref, n.sheetName ?? null])
  check(
    `${name}: the export writes back every defined name, the unused one and the print area included`,
    json([...exportedNames].sort()) === json([...wantNames].sort()),
    json(exportedNames)
  )

  const againContent = await M.readXlsxWorkbook(ExcelJS, exported)
  const again = M.restoreWorkbookContent(
    M.sheetsFromWorkbook(againContent, () => 'again'),
    againContent,
    M.scanXlsxPackage(exported).definedNames,
    M.createImportFidelityCollector({ name: 'again.xlsx', kind: 'xlsx' })
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

// --- "replace current worksheet": one sheet kept, under another name --------
const single = new ExcelJS.Workbook()
const first = single.addWorksheet('Données')
single.addWorksheet('Other').getCell('A1').value = 5
first.getCell('B1').value = 100
first.getCell('B2').value = 0.2
first.getCell('B3').value = { formula: 'B1*TauxTVA', result: 20 }
first.getCell('B4').value = { formula: 'Other!A1*2', result: 10 }
single.definedNames.add("'Données'!$B$2", 'TauxTVA')
const singleBytes = new Uint8Array(await single.xlsx.writeBuffer())
const replaced = await M.importXlsxFile(
  new File([singleBytes], 'vat.xlsx', { type: XLSX_TYPE }),
  () => 'unused',
  { keepFirstSheetAs: 'Sheet1' }
)
const replacedCell = cellOf(replaced.sheets, 'Sheet1', 'B3')
check(
  'replace current: one sheet, renamed, and the name follows it',
  replaced.sheets.length === 1 &&
    replacedCell?.f === '=B1*Sheet1!$B$2' &&
    replacedCell?.xlsxFormula === '=B1*TauxTVA' &&
    replacedCell?.xlsxNames?.[0]?.ref === 'Sheet1!$B$2',
  json([replaced.sheets.map((s) => s.name), replacedCell])
)
const otherCell = cellOf(replaced.sheets, 'Sheet1', 'B4')
check(
  'replace current: a formula reading a sheet that was not imported keeps its value and is reported',
  otherCell &&
    otherCell.f === undefined &&
    Number(otherCell.v) === 10 &&
    replaced.report.items.some(
      (i) => i.kind === 'formulas' && i.status === 'lost' && i.places?.[0]?.cell === 'B4'
    ),
  json([otherCell, replaced.report.items])
)
const replacedTables = toTables(replaced.sheets)
recalculate(replacedTables)
check(
  'replace current: =B1*TauxTVA computes 20 in the renamed sheet',
  Number(replacedTables[0].data[2][1].v) === 20,
  json(replacedTables[0].data[2][1])
)
const replacedExport = await exportTables(replacedTables)
check(
  'replace current: the export points TauxTVA at the renamed sheet',
  json(M.scanXlsxPackage(replacedExport.bytes).definedNames) ===
    json([{ name: 'TauxTVA', ref: 'Sheet1!$B$2' }]),
  json(M.scanXlsxPackage(replacedExport.bytes).definedNames)
)

// --- exceljs cannot read the file: the report says it is incomplete ---------
const broken = M.unzipSync(singleBytes)
broken['xl/tables/table1.xml'] = M.strToU8('<table name="Broken"/>')
const unreadable = await M.importXlsxFile(
  new File([M.zipSync(broken)], 'broken.xlsx', { type: XLSX_TYPE }),
  () => 'unused'
)
check(
  'when exceljs fails, fortune-excel still converts and the report is marked incomplete',
  unreadable.sheets.length === 2 &&
    unreadable.report.unavailable.some((reason) => reason.startsWith('formulas, defined names')) &&
    M.needsSaveConfirmation(unreadable.report),
  json(unreadable.report.unavailable)
)

// --- .xls: converted first, so the report says it is incomplete --------------
const xlsx = require('xlsx')
const xlsBook = xlsx.utils.book_new()
xlsx.utils.book_append_sheet(xlsBook, xlsx.utils.aoa_to_sheet([[1, 2]]), 'Old')
const xlsBytes = xlsx.write(xlsBook, { bookType: 'biff8', type: 'array' })
const fromXls = await M.importXlsxFile(
  new File([xlsBytes], 'old.xls', { type: 'application/vnd.ms-excel' }),
  () => 'unused'
)
check(
  'an .xls is imported, and its report says what it cannot see',
  fromXls.sheets.length === 1 &&
    fromXls.report.source.kind === 'xls' &&
    fromXls.report.source.name === 'old.xls' &&
    fromXls.report.unavailable.length === 1 &&
    M.needsSaveConfirmation(fromXls.report),
  json(fromXls.report)
)

// --- what a save would change: properties, page setup, hidden sheets, lists --
const sheetXml = (b, n = 1) => M.strFromU8(M.unzipSync(b)[`xl/worksheets/sheet${n}.xml`])
const workbookXml = (b) => M.strFromU8(M.unzipSync(b)['xl/workbook.xml'])
{
  const book = new ExcelJS.Workbook()
  const main = book.addWorksheet('Main')
  const lists = book.addWorksheet('Lists')
  const hidden = book.addWorksheet('Hidden', { state: 'hidden' })
  hidden.getCell('A1').value = 2
  lists.getCell('A1').value = 'x'
  lists.getCell('A2').value = 'y'
  main.getCell('A1').value = 'Header'
  main.getCell('B2').dataValidation = { type: 'list', allowBlank: true, formulae: ['MyList'] }
  main.getCell('B3').dataValidation = { type: 'list', allowBlank: true, formulae: ['"a,b"'] }
  main.pageSetup.orientation = 'landscape'
  main.pageSetup.fitToPage = true
  main.getRow(3).addPageBreak()
  book.definedNames.add('Lists!$A$1:$A$2', 'MyList')
  const zip = M.unzipSync(new Uint8Array(await book.xlsx.writeBuffer()))
  zip['xl/workbook.xml'] = M.strToU8(
    M.strFromU8(zip['xl/workbook.xml']).replace(
      '</definedNames>',
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Main!$A$1:$D$5</definedName>' +
        '<definedName name="Remote">[1]Prices!$A$1</definedName></definedNames>'
    )
  )
  zip['docProps/custom.xml'] = M.strToU8(
    '<Properties><property name="MSIP_Label_x_Enabled"><vt:lpwstr>true</vt:lpwstr></property></Properties>'
  )
  zip['customXml/item1.xml'] = M.strToU8('<root/>')
  zip['xl/worksheets/sheet1.xml'] = M.strToU8(
    M.strFromU8(zip['xl/worksheets/sheet1.xml']).replace(
      '</worksheet>',
      '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">' +
        '<x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">' +
        '<x14:cfRule type="iconSet" priority="1" id="{1}"><x14:iconSet iconSet="3Stars"/></x14:cfRule>' +
        '<xm:sqref>A1:A5</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>'
    )
  )
  const settingsBytes = M.zipSync(zip)
  const imported = await M.importXlsxFile(
    new File([settingsBytes], 'settings.xlsx', { type: XLSX_TYPE }),
    () => 'unused'
  )
  const got = totals(imported.report)
  const reasons = imported.report.items.map((i) => `${i.kind}: ${i.reason || ''}`)
  check(
    'custom document properties and custom XML are reported lost',
    got.documentProperties?.lost === 2,
    json(got.documentProperties)
  )
  check(
    'page orientation, fit to page and page breaks are reported lost',
    reasons.includes('printSettings: page orientation, scaling and margins are not kept') &&
      reasons.includes('printSettings: page breaks are not kept'),
    json(reasons)
  )
  check('a hidden sheet is reported', got.hiddenSheets?.lost === 1, json(got.hiddenSheets))
  check(
    'a conditional format written only in the x14 extension is reported lost',
    got.conditionalFormatting?.lost === 1,
    json(got.conditionalFormatting)
  )
  const lists2 = imported.report.items.filter((i) => i.kind === 'dataValidation')
  check(
    'a list read from a name is reported lost, a list of fixed values is kept',
    json(lists2.map((i) => [i.status, i.count, i.places?.[0]?.cell ?? null]).sort()) ===
      json([
        ['converted', 1, null],
        ['lost', 1, 'B2']
      ]),
    json(lists2)
  )
  check('all of this makes a save over the original ask', M.needsSaveConfirmation(imported.report))

  // Delete on A1: fortune-sheet sets the cell to {}, the copy of the names
  // goes with it. The list held outside the grid still writes them back.
  const cleared = toTables(imported.sheets)
  cleared[0].data[0][0] = {}
  const baseNames = M.collectKeptNames(imported.sheets)
  const blob = await FortuneExcel.transformFortuneToExcel(
    { current: { getAllSheets: () => cleared, getSheet: () => cleared[0] } },
    'xlsx',
    false
  )
  const raw = new Uint8Array(await blob.arrayBuffer())
  const withoutBase = await M.withDefinedNamesRestored(raw, cleared)
  const withBase = await M.withDefinedNamesRestored(raw, cleared, baseNames)
  const namesIn = (b) =>
    M.scanXlsxPackage(b)
      .definedNames.map((n) => n.name)
      .sort()
  check(
    'after Delete on A1 the grid alone has lost the names',
    !namesIn(withoutBase.bytes).includes('MyList'),
    json(namesIn(withoutBase.bytes))
  )
  check(
    'the name list held outside the grid writes them back, not the one pointing at another workbook',
    json(namesIn(withBase.bytes)) === json(['MyList', '_xlnm.Print_Area']),
    json(namesIn(withBase.bytes))
  )
  check(
    'exporting one sheet still carries the names kept on another',
    json(
      M.collectKeptNames([imported.sheets[1], imported.sheets[0]])
        .map((n) => n.name)
        .sort()
    ) === json(['MyList', 'Remote', '_xlnm.Print_Area']),
    json(M.collectKeptNames(imported.sheets))
  )
  check(
    'fortune-excel writes a default page setup over the landscape one (why it is reported)',
    !/orientation="landscape"/.test(sheetXml(withBase.bytes)) &&
      !/<rowBreaks/.test(sheetXml(withBase.bytes)) &&
      !/state="hidden"/.test(workbookXml(withBase.bytes)),
    /<pageSetup[^>]*>/.exec(sheetXml(withBase.bytes))?.[0]
  )
}

// --- append: free sheet names, references following -------------------------
{
  const appended = M.withFreeSheetNames(
    [
      { name: 'A', celldata: [{ r: 0, c: 0, v: { f: "='A (2)'!A1+A!B1" } }] },
      { name: 'A (2)', celldata: [{ r: 0, c: 0, v: { f: '=A!A1' } }] }
    ],
    ['A']
  )
  check(
    'append renames a taken name to one no other sheet has, and the references follow',
    json(appended.map((sheet) => [sheet.name, sheet.celldata[0].v.f])) ===
      json([
        ['A (3)', "='A (2)'!A1+'A (3)'!B1"],
        ['A (2)', "='A (3)'!A1"]
      ]),
    json(appended.map((sheet) => [sheet.name, sheet.celldata[0].v.f]))
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
