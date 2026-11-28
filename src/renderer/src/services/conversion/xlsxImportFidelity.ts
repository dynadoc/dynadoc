import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type ExcelJSModule from 'exceljs'
import type { ImportFidelityCollector } from './importFidelity'

// Formulas, defined names and comments of an .xlsx import, the inventory of
// what a fortune-sheet cannot hold (shapes, charts, pivot caches...), and the
// export step that puts the defined names back.
//
// fortune-excel (the primary converter) reads most formulas but ignores
// defined names, and the fallback kept values only. Both paths now go through
// restoreWorkbookContent(), which takes every formula from exceljs: shared
// formulas expanded into each cell, array formulas on their first cell.
//
// Defined names: fortune-sheet has no named ranges. A formula that uses one
// gets the name replaced by its reference for fortune-sheet to compute
// (`=B1*TauxTVA` -> `=B1*'Données'!$B$2`), and keeps the user's formula and
// the names it uses in two extra cell keys, which fortune-sheet keeps through
// edits and the saved snapshot (the same way as VAR_SOURCE_KEY in
// useSheetVariables.tsx). restoreXlsxExport() writes both back on export.
// The names are read from xl/workbook.xml directly: exceljs drops constant
// names and sheet scopes.
//
// Pure: exceljs is passed in, fflate is the only import.
// tests/smoke/xlsx-import-fidelity.test.mjs runs it.

type ExcelJs = Pick<typeof ExcelJSModule, 'Workbook'>

/** The user's formula, when the one given to fortune-sheet has names written out. */
export const XLSX_FORMULA_KEY = 'xlsxFormula'
/** The defined names that formula uses, to write them back on export. */
export const XLSX_NAMES_KEY = 'xlsxNames'

export type XlsxDefinedName = {
  name: string
  /** What the name stands for, as in the file: a reference, a constant or a formula. */
  ref: string
  /** Set for a name scoped to one sheet. */
  sheetName?: string
  hidden?: boolean
}

export type FortuneCellValue = {
  v?: unknown
  m?: string
  f?: string
  ct?: { fa?: string; t?: string }
  ps?: {
    left: number | null
    top: number | null
    width: number | null
    height: number | null
    value: string
    isShow: boolean
  }
  [XLSX_FORMULA_KEY]?: string
  [XLSX_NAMES_KEY]?: XlsxDefinedName[]
  [key: string]: unknown
}

export type FortuneCellEntry = { r: number; c: number; v: FortuneCellValue | null }

export type FortuneCalcChainItem = { r: number; c: number; id?: string }

export type FortuneSheetLike = {
  id?: string
  name: string
  celldata?: FortuneCellEntry[]
  /** The live grid, as getAllSheets() returns it. */
  data?: (FortuneCellValue | null)[][]
  calcChain?: FortuneCalcChainItem[]
  images?: unknown[]
  dataVerification?: Record<string, unknown> | null
  [key: string]: unknown
}

export type XlsxPackageScan = {
  sheetNames: string[]
  definedNames: XlsxDefinedName[]
  comments: number
  pictures: number
  shapes: number
  textBoxes: number
  charts: number
  conditionalRules: number
  pivotCaches: number
  externalLinks: number
  protections: number
  macros: boolean
  /** Per sheet name, the first cell (0-based) of each data validation rule. */
  validations: Record<string, Array<{ r: number; c: number }>>
}

export type XlsxCell = {
  r: number
  c: number
  value: FortuneCellValue
  /** Without the leading "=". */
  formula?: string
  /** The range of an array formula, on its first cell. */
  arrayRef?: string
  note?: string
}

export type XlsxWorkbookContent = {
  sheetNames: string[]
  cells: Record<string, XlsxCell[]>
}

// --- XML helpers --------------------------------------------------------------

const count = (text: string, pattern: RegExp): number => (text.match(pattern) || []).length

const decodeXml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')

const encodeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const attr = (element: string, name: string): string | undefined => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1]
  return value === undefined ? undefined : decodeXml(value)
}

/** "B3" -> { r: 2, c: 1 }; null for anything else. */
function decodeCellAddress(address: string): { r: number; c: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(address.trim())
  if (!match) return null
  let c = 0
  for (const letter of match[1].toUpperCase()) c = c * 26 + (letter.charCodeAt(0) - 64)
  return { r: Number(match[2]) - 1, c: c - 1 }
}

const firstCellOf = (sqref: string): { r: number; c: number } | null =>
  decodeCellAddress(sqref.trim().split(/\s+/)[0]?.split(':')[0] || '')

/** The sheets of a workbook.xml, in order. */
const sheetNamesOf = (workbookXml: string): string[] =>
  (workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []).map((sheet) => attr(sheet, 'name') || '')

function definedNamesOf(workbookXml: string, sheetNames: string[]): XlsxDefinedName[] {
  const names: XlsxDefinedName[] = []
  const pattern = /<(?:\w+:)?definedName\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?definedName>)/g
  for (const match of workbookXml.matchAll(pattern)) {
    const attributes = ` ${match[1]}`
    const name = attr(attributes, 'name')
    if (!name) continue
    const local = attr(attributes, 'localSheetId')
    const sheetName = local === undefined ? undefined : sheetNames[Number(local)]
    const hidden = attr(attributes, 'hidden')
    names.push({
      name,
      ref: decodeXml(match[2] || '').trim(),
      ...(sheetName !== undefined ? { sheetName } : {}),
      ...(hidden === '1' || hidden === 'true' ? { hidden: true } : {})
    })
  }
  return names
}

// --- package inventory ------------------------------------------------------

/** Lists what the package holds, by reading its parts (names and XML). */
export function scanXlsxPackage(bytes: Uint8Array): XlsxPackageScan {
  const scan: XlsxPackageScan = {
    sheetNames: [],
    definedNames: [],
    comments: 0,
    pictures: 0,
    shapes: 0,
    textBoxes: 0,
    charts: 0,
    conditionalRules: 0,
    pivotCaches: 0,
    externalLinks: 0,
    protections: 0,
    macros: false,
    validations: {}
  }
  const wanted = (name: string): boolean =>
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name) ||
    /^xl\/drawings\/[^/]+\.xml$/.test(name) ||
    /^xl\/comments\d*\.xml$/.test(name)
  const names: string[] = []
  const files = unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name)
      return wanted(file.name)
    }
  })
  const text = (name: string): string => (files[name] ? strFromU8(files[name]) : '')

  for (const name of names) {
    if (name === 'xl/vbaProject.bin') scan.macros = true
    if (/^xl\/charts\/chart(Ex)?\d+\.xml$/.test(name)) scan.charts++
    if (/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(name)) scan.pivotCaches++
    if (/^xl\/externalLinks\/externalLink\d+\.xml$/.test(name)) scan.externalLinks++
  }

  for (const name of Object.keys(files)) {
    if (/^xl\/comments\d*\.xml$/.test(name)) scan.comments += count(text(name), /<comment[\s>]/g)
    if (!name.startsWith('xl/drawings/')) continue
    const xml = text(name)
    scan.pictures += count(xml, /<(?:\w+:)?pic[\s>]/g)
    scan.shapes += count(xml, /<(?:\w+:)?cxnSp[\s>]/g)
    for (const shape of xml.match(/<((?:\w+:)?)sp[\s>][\s\S]*?<\/\1sp>/g) || []) {
      if (/txBox="(1|true)"/.test(shape)) scan.textBoxes++
      else scan.shapes++
    }
  }

  const workbookXml = text('xl/workbook.xml')
  scan.sheetNames = sheetNamesOf(workbookXml)
  scan.definedNames = definedNamesOf(workbookXml, scan.sheetNames)
  if (/<(?:\w+:)?workbookProtection[\s/>]/.test(workbookXml)) scan.protections++

  // Sheet name -> worksheet part, through the workbook's relationships.
  const targets: Record<string, string> = {}
  for (const rel of text('xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) || []) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (!id || !target) continue
    targets[id] = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  for (const sheet of workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []) {
    const sheetName = attr(sheet, 'name') || ''
    const xml = text(targets[attr(sheet, 'r:id') || ''] || '')
    if (!xml) continue
    if (/<(?:\w+:)?sheetProtection[\s/>]/.test(xml)) scan.protections++
    scan.conditionalRules += count(xml, /<(?:\w+:)?cfRule[\s>]/g)
    const cells: Array<{ r: number; c: number }> = []
    for (const rule of xml.match(/<dataValidation\b[^>]*>/g) || []) {
      const cell = firstCellOf(attr(rule, 'sqref') || '')
      if (cell) cells.push(cell)
    }
    // Rules Excel writes in the x14 extension (lists that read another sheet).
    for (const rule of xml.match(/<x14:dataValidation\b[\s\S]*?<\/x14:dataValidation>/g) || []) {
      const cell = firstCellOf(/<xm:sqref>([^<]*)<\/xm:sqref>/.exec(rule)?.[1] || '')
      if (cell) cells.push(cell)
    }
    if (cells.length) scan.validations[sheetName] = cells
  }
  return scan
}

/** Reports what the package held against what the imported sheets kept. */
export function reportXlsxPackage(
  scan: XlsxPackageScan,
  sheets: FortuneSheetLike[],
  collector: ImportFidelityCollector
): void {
  const keptComments = sheets.reduce(
    (sum, sheet) => sum + (sheet.celldata || []).filter((cell) => cell.v?.ps).length,
    0
  )
  collector.add('comments', 'converted', keptComments)
  collector.add(
    'comments',
    'lost',
    scan.comments - keptComments,
    'comments on cells the converter does not read'
  )
  const keptImages = sheets.reduce((sum, sheet) => sum + (sheet.images?.length || 0), 0)
  const images = Math.min(scan.pictures, keptImages)
  collector.add('images', 'converted', images)
  collector.add('images', 'lost', scan.pictures - images, 'pictures the converter could not place')
  collector.add('shapes', 'lost', scan.shapes, 'Dynadoc sheets have no drawing layer')
  collector.add('textBoxes', 'lost', scan.textBoxes, 'Dynadoc sheets have no drawing layer')
  collector.add('charts', 'lost', scan.charts, 'charts are not converted')
  for (const [sheetName, cells] of Object.entries(scan.validations)) {
    const sheet = sheets.find((candidate) => candidate.name === sheetName)
    const kept = cells.filter((cell) => sheet?.dataVerification?.[`${cell.r}_${cell.c}`]).length
    collector.add('dataValidation', 'converted', kept)
    collector.add(
      'dataValidation',
      'lost',
      cells.length - kept,
      'rule types the converter does not read'
    )
  }
  collector.add('conditionalFormatting', 'lost', scan.conditionalRules, 'not converted')
  collector.add(
    'pivotCaches',
    'lost',
    scan.pivotCaches,
    'the pivot table cells keep their values, the pivot cache is dropped'
  )
  collector.add('externalLinks', 'lost', scan.externalLinks, 'links to other workbooks are dropped')
  collector.add('protection', 'lost', scan.protections, 'sheet and workbook protection is not kept')
  collector.add('macros', 'lost', scan.macros ? 1 : 0, 'VBA macros are never imported')
}

// --- defined names in formulas ----------------------------------------------

const CELL_REF = /^\$?[A-Z]{1,3}\$?\d+$/i
const NAME_START = /[\p{L}_\\]/u
const NAME_CHAR = /[\p{L}\p{N}_.\\?]/u
const PLAIN_REF = /^(('([^']|'')+'|[\p{L}\p{N}_.]+)!)?\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/iu

/** A reference to another workbook: "[1]Sheet1!A1" or "'[Book.xlsx]Data'!A1". */
const readsOtherWorkbook = (formula: string): boolean =>
  /\[[^\]]+\][^!]*!/.test(formula.replace(/"(?:[^"]|"")*"/g, '""'))

/** Names a formula can use in place of their reference. */
const isInlinable = (n: XlsxDefinedName): boolean =>
  Boolean(n.ref) &&
  !n.name.startsWith('_xlnm.') &&
  !n.ref.includes('#REF!') &&
  !readsOtherWorkbook(n.ref)

/**
 * `formula` with every defined name replaced by its reference ("Total" ->
 * "Data!$A$1:$A$3"), or by its value in parentheses when it is not a plain
 * reference. A name scoped to `sheetName` wins over a workbook name. String
 * literals, quoted sheet names, function names and names qualified by a sheet
 * are left alone. `used` collects the names replaced. Names that use other
 * names are written out too, up to a few levels.
 */
export function inlineDefinedNames(
  formula: string,
  names: XlsxDefinedName[],
  sheetName: string | undefined,
  used: XlsxDefinedName[]
): string {
  const lookup = (token: string): XlsxDefinedName | undefined => {
    const key = token.toUpperCase()
    return (
      names.find((n) => n.sheetName === sheetName && n.name.toUpperCase() === key) ||
      names.find((n) => n.sheetName === undefined && n.name.toUpperCase() === key)
    )
  }
  let current = formula
  for (let depth = 0; depth < 4; depth++) {
    let out = ''
    let changed = false
    let i = 0
    while (i < current.length) {
      const ch = current[i]
      if (ch === '"' || ch === "'") {
        // A string literal or a quoted sheet name; a doubled quote escapes it.
        let j = i + 1
        while (j < current.length) {
          if (current[j] === ch && current[j + 1] === ch) j += 2
          else if (current[j] === ch) break
          else j++
        }
        out += current.slice(i, j + 1)
        i = j + 1
        continue
      }
      const prev = current[i - 1] || ''
      if (NAME_START.test(ch) && !NAME_CHAR.test(prev) && prev !== '!' && prev !== '$') {
        let j = i + 1
        while (j < current.length && NAME_CHAR.test(current[j])) j++
        const token = current.slice(i, j)
        const next = current[j] || ''
        const defined =
          next === '(' || next === '!' || CELL_REF.test(token) ? undefined : lookup(token)
        if (defined && isInlinable(defined)) {
          if (!used.includes(defined)) used.push(defined)
          out += PLAIN_REF.test(defined.ref) ? defined.ref : `(${defined.ref})`
          changed = true
        } else {
          out += token
        }
        i = j
        continue
      }
      out += ch
      i++
    }
    current = out
    if (!changed) break
  }
  return current
}

// --- cells ------------------------------------------------------------------

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

/** A cell value of exceljs as a fortune-sheet cell value. */
function valueOf(value: unknown, text: string, numFmt?: string): FortuneCellValue {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const object = value as Record<string, unknown>
    if ('formula' in object || 'sharedFormula' in object)
      return valueOf(object.result, text, numFmt)
    if ('error' in object) {
      const error = String(object.error)
      return { v: error, m: error, ct: { fa: 'General', t: 'e' } }
    }
    if (Array.isArray(object.richText)) {
      const joined = (object.richText as Array<{ text?: string }>).map((r) => r.text || '').join('')
      return { v: joined, m: joined, ct: { fa: 'General', t: 'g' } }
    }
    if ('text' in object) {
      const linked = String(object.text ?? '')
      return { v: linked, m: linked, ct: { fa: 'General', t: 'g' } }
    }
    return {}
  }
  if (value instanceof Date) {
    const serial = (value.getTime() - EXCEL_EPOCH_MS) / 86400000
    return {
      v: serial,
      m: value.toISOString().slice(0, 10),
      ct: { fa: numFmt || 'yyyy-mm-dd', t: 'n' }
    }
  }
  if (typeof value === 'number')
    return { v: value, m: text || String(value), ct: { fa: numFmt || 'General', t: 'n' } }
  if (typeof value === 'boolean')
    return { v: value, m: value ? 'TRUE' : 'FALSE', ct: { fa: 'General', t: 'b' } }
  if (value === null || value === undefined) return {}
  return { v: String(value), m: String(value), ct: { fa: 'General', t: 'g' } }
}

function noteText(note: unknown): string {
  if (!note) return ''
  if (typeof note === 'string') return note.trim()
  const texts = (note as { texts?: Array<{ text?: string }> }).texts
  return Array.isArray(texts)
    ? texts
        .map((t) => t.text || '')
        .join('')
        .trim()
    : ''
}

/** Reads every cell of an .xlsx with exceljs: values, formulas and notes. */
export async function readXlsxWorkbook(
  ExcelJS: ExcelJs,
  bytes: Uint8Array
): Promise<XlsxWorkbookContent> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  const content: XlsxWorkbookContent = { sheetNames: [], cells: {} }
  workbook.eachSheet((worksheet) => {
    const cells: XlsxCell[] = []
    content.sheetNames.push(worksheet.name)
    content.cells[worksheet.name] = cells
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const note = noteText(cell.note)
        const raw = cell.value as unknown
        const object = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
        const formula =
          object && ('formula' in object || 'sharedFormula' in object) ? cell.formula : ''
        if ((raw === null || raw === undefined) && !note) return
        const text = (() => {
          try {
            return cell.text
          } catch {
            return ''
          }
        })()
        cells.push({
          r: Number(cell.row) - 1,
          c: Number(cell.col) - 1,
          value: valueOf(raw, text, cell.numFmt),
          ...(formula ? { formula } : {}),
          ...(object?.shareType === 'array' && typeof object.ref === 'string'
            ? { arrayRef: object.ref }
            : {}),
          ...(note ? { note } : {})
        })
      })
    })
  })
  return content
}

/**
 * The fallback conversion: every sheet with its values. Run
 * restoreWorkbookContent() on the result for formulas and comments.
 */
export function sheetsFromWorkbook(
  content: XlsxWorkbookContent,
  newId: () => string
): FortuneSheetLike[] {
  return content.sheetNames.map((name, index) => ({
    id: newId(),
    name,
    order: index,
    status: index === 0 ? 1 : 0,
    celldata: content.cells[name]
      .filter((cell) => cell.value.v !== undefined || cell.formula)
      .map((cell) => ({ r: cell.r, c: cell.c, v: { ...cell.value } }))
  }))
}

/**
 * Puts the formulas and comments of `content` on `sheets` (the output of
 * either converter), rebuilds each sheet's calculation chain, and reports
 * formulas, defined names and comments to `collector`. Returns new sheets.
 */
export function restoreWorkbookContent(
  sheets: FortuneSheetLike[],
  content: XlsxWorkbookContent,
  definedNames: XlsxDefinedName[],
  collector: ImportFidelityCollector
): FortuneSheetLike[] {
  const usedNames = new Set<XlsxDefinedName>()

  const result = sheets.map((original, index) => {
    const sheet: FortuneSheetLike = { ...original, celldata: [...(original.celldata || [])] }
    const sheetName = content.cells[sheet.name] ? sheet.name : content.sheetNames[index]
    const source = content.cells[sheetName]
    if (!source) return sheet

    const celldata = sheet.celldata as FortuneCellEntry[]
    const byAddress = new Map<string, number>()
    celldata.forEach((entry, at) => byAddress.set(`${entry.r}_${entry.c}`, at))
    const cellAt = (cell: XlsxCell): FortuneCellValue => {
      const at = byAddress.get(`${cell.r}_${cell.c}`)
      if (at !== undefined) {
        const entry = celldata[at]
        const v = entry.v && typeof entry.v === 'object' ? { ...entry.v } : { ...cell.value }
        celldata[at] = { ...entry, v }
        return v
      }
      const v = { ...cell.value }
      byAddress.set(`${cell.r}_${cell.c}`, celldata.length)
      celldata.push({ r: cell.r, c: cell.c, v })
      return v
    }

    for (const cell of source) {
      if (cell.note) {
        cellAt(cell).ps = {
          left: null,
          top: null,
          width: null,
          height: null,
          value: cell.note,
          isShow: false
        }
      }
      if (!cell.formula) continue
      const v = cellAt(cell)
      if (readsOtherWorkbook(cell.formula)) {
        delete v.f
        collector.add(
          'formulas',
          'approximated',
          1,
          'formulas that read another workbook keep their last value'
        )
        continue
      }
      const used: XlsxDefinedName[] = []
      const computed = inlineDefinedNames(cell.formula, definedNames, sheetName, used)
      v.f = `=${computed}`
      delete v[XLSX_FORMULA_KEY]
      delete v[XLSX_NAMES_KEY]
      if (used.length) {
        v[XLSX_FORMULA_KEY] = `=${cell.formula}`
        v[XLSX_NAMES_KEY] = used.map((n) => ({ ...n }))
        used.forEach((n) => usedNames.add(n))
      }
      if (cell.arrayRef) {
        const [first, last] = cell.arrayRef.split(':')
        collector.add(
          'formulas',
          'approximated',
          1,
          last && last !== first
            ? 'array formulas are kept as ordinary formulas on their first cell; the other cells keep their values'
            : 'array formulas are kept as ordinary formulas; a recalculation may give #VALUE!'
        )
      } else {
        collector.add('formulas', 'converted')
      }
    }

    sheet.calcChain = celldata
      .filter((entry) => typeof entry.v?.f === 'string' && entry.v.f.length > 1)
      .map((entry) => ({ r: entry.r, c: entry.c, id: sheet.id }))
    return sheet
  })

  for (const n of definedNames) {
    if (usedNames.has(n)) {
      collector.add(
        'definedNames',
        'approximated',
        1,
        'kept with the formulas that use them and written back on export; Dynadoc computes them as the ranges they stand for'
      )
    } else {
      collector.add(
        'definedNames',
        'lost',
        1,
        'names no formula uses: Dynadoc sheets have no named ranges'
      )
    }
  }
  return result
}

/** Sets a sheet's id, and the id its calculation chain points at. */
export function withSheetId<T extends FortuneSheetLike>(sheet: T, id: string): T {
  return {
    ...sheet,
    id,
    calcChain: sheet.calcChain?.map((item) => ({ ...item, id }))
  }
}

// --- export -----------------------------------------------------------------

const toA1 = (r: number, c: number): string => {
  let letters = ''
  let n = c + 1
  while (n > 0) {
    const m = (n - 1) % 26
    letters = String.fromCharCode(65 + m) + letters
    n = Math.floor((n - m) / 26)
  }
  return `${letters}${r + 1}`
}

/**
 * The .xlsx fortune-excel exported from `sheets`, with the user's formulas
 * put back where names had been written out (unless the formula was edited
 * since), and the defined names those formulas use.
 */
export async function restoreXlsxExport(
  ExcelJS: ExcelJs,
  bytes: Uint8Array,
  sheets: FortuneSheetLike[]
): Promise<Uint8Array> {
  const names = new Map<string, XlsxDefinedName>()
  const restores: Array<{ sheet: string; address: string; formula: string }> = []
  for (const sheet of sheets) {
    const rows: Array<Array<FortuneCellValue | null>> =
      sheet.data ||
      (sheet.celldata || []).reduce<Array<Array<FortuneCellValue | null>>>((grid, entry) => {
        ;(grid[entry.r] ||= [])[entry.c] = entry.v
        return grid
      }, [])
    rows.forEach((row, r) =>
      row?.forEach((cell, c) => {
        const source = cell?.[XLSX_FORMULA_KEY]
        const used = cell?.[XLSX_NAMES_KEY]
        if (typeof source !== 'string' || !Array.isArray(used) || !cell?.f) return
        const expected = `=${inlineDefinedNames(source.slice(1), used, sheet.name, [])}`
        if (cell.f !== expected) return
        restores.push({ sheet: sheet.name, address: toA1(r, c), formula: source.slice(1) })
        for (const n of used) names.set(`${n.sheetName ?? ''}\u0000${n.name.toUpperCase()}`, n)
      })
    )
  }
  if (!restores.length) return bytes

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  for (const restore of restores) {
    const cell = workbook.getWorksheet(restore.sheet)?.getCell(restore.address)
    if (!cell) continue
    const current = cell.value as { result?: unknown } | null
    const result = current && typeof current === 'object' ? current.result : current
    cell.value = { formula: restore.formula, result } as ExcelJSModule.CellFormulaValue
  }
  const written = new Uint8Array(await workbook.xlsx.writeBuffer())

  const parts = unzipSync(written)
  let workbookXml = strFromU8(parts['xl/workbook.xml'])
  const sheetNames = sheetNamesOf(workbookXml)
  const present = new Set(
    definedNamesOf(workbookXml, sheetNames).map(
      (n) => `${n.sheetName ?? ''}\u0000${n.name.toUpperCase()}`
    )
  )
  const elements = [...names.entries()]
    .filter(([key, n]) => !present.has(key) && (!n.sheetName || sheetNames.includes(n.sheetName)))
    .map(([, n]) => {
      const scope = n.sheetName ? ` localSheetId="${sheetNames.indexOf(n.sheetName)}"` : ''
      const hidden = n.hidden ? ' hidden="1"' : ''
      return `<definedName name="${encodeXml(n.name)}"${scope}${hidden}>${encodeXml(n.ref)}</definedName>`
    })
    .join('')
  if (!elements) return written
  workbookXml = /<definedNames>/.test(workbookXml)
    ? workbookXml.replace('</definedNames>', `${elements}</definedNames>`)
    : workbookXml.replace('</sheets>', `</sheets><definedNames>${elements}</definedNames>`)
  parts['xl/workbook.xml'] = strToU8(workbookXml)
  return zipSync(parts)
}
