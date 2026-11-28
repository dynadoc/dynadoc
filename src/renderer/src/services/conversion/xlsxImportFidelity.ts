import { strFromU8, unzipSync } from 'fflate'
import type { CellObject, WorkBook } from 'xlsx'
import type { ImportFidelityCollector } from './importFidelity'

// Formulas, defined names and comments of an .xlsx import, and the inventory
// of what a fortune-sheet cannot hold (shapes, charts, pivot caches...).
//
// fortune-excel (the primary converter) reads formulas itself, but it misses
// some (shared formulas it cannot shift, formulas reading other workbooks) and
// the SheetJS fallback kept values only. Both paths now go through
// restoreWorkbookContent(), which takes the formulas from SheetJS: it expands
// shared formulas into every cell they cover and keeps array formulas on
// their first cell. fortune-sheet has no named ranges, so a defined name is
// replaced by what it stands for in the formulas that use it.
//
// Pure: the SheetJS module is passed in, fflate is the only import.
// tests/smoke/xlsx-import-fidelity.test.mjs runs it.

type SheetJs = Pick<typeof import('xlsx'), 'read' | 'utils'>

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
  [key: string]: unknown
}

export type FortuneCellEntry = { r: number; c: number; v: FortuneCellValue | null }

export type FortuneCalcChainItem = { r: number; c: number; id?: string }

export type FortuneSheetLike = {
  id?: string
  name: string
  celldata?: FortuneCellEntry[]
  calcChain?: FortuneCalcChainItem[]
  images?: unknown[]
  dataVerification?: Record<string, unknown> | null
  [key: string]: unknown
}

export type XlsxPackageScan = {
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

export function readXlsxWorkbook(xlsx: SheetJs, bytes: Uint8Array): WorkBook {
  return xlsx.read(bytes, { type: 'array', cellFormula: true, cellStyles: false })
}

// --- package inventory ------------------------------------------------------

const count = (text: string, pattern: RegExp): number => (text.match(pattern) || []).length

const decodeXml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** "B3" -> { r: 2, c: 1 }; null for anything else. */
function decodeCellAddress(address: string): { r: number; c: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(address.trim())
  if (!match) return null
  let c = 0
  for (const letter of match[1].toUpperCase()) c = c * 26 + (letter.charCodeAt(0) - 64)
  return { r: Number(match[2]) - 1, c: c - 1 }
}

const firstCellOf = (sqref: string): { r: number; c: number } | null =>
  decodeCellAddress(decodeXml(sqref).trim().split(/\s+/)[0]?.split(':')[0] || '')

/** Lists what the package holds, by reading its parts (names and XML). */
export function scanXlsxPackage(bytes: Uint8Array): XlsxPackageScan {
  const scan: XlsxPackageScan = {
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
    /^xl\/drawings\/[^/]+\.xml$/.test(name)
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
  if (/<(?:\w+:)?workbookProtection[\s/>]/.test(workbookXml)) scan.protections++

  // Sheet name -> worksheet part, through the workbook's relationships.
  const targets: Record<string, string> = {}
  for (const rel of text('xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) || []) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(rel)?.[1]
    if (!id || !target) continue
    targets[id] = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  for (const sheet of workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []) {
    const sheetName = decodeXml(/\bname="([^"]*)"/.exec(sheet)?.[1] || '')
    const relId = /\br:id="([^"]+)"/.exec(sheet)?.[1] || ''
    const xml = text(targets[relId] || '')
    if (!xml) continue
    if (/<(?:\w+:)?sheetProtection[\s/>]/.test(xml)) scan.protections++
    scan.conditionalRules += count(xml, /<(?:\w+:)?cfRule[\s>]/g)
    const cells: Array<{ r: number; c: number }> = []
    for (const rule of xml.match(/<dataValidation\b[^>]*>/g) || []) {
      const cell = firstCellOf(/\bsqref="([^"]*)"/.exec(rule)?.[1] || '')
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

// --- cells: values, formulas, defined names, comments -----------------------

const CELL_REF = /^\$?[A-Z]{1,3}\$?\d+$/i
const NAME_START = /[A-Za-z_\\]/
const NAME_CHAR = /[A-Za-z0-9_.\\?]/

type DefinedName = { name: string; ref: string; sheet?: number }

/**
 * `formula` with every defined name replaced by its reference ("Total" ->
 * "Data!$A$1:$A$3"), or by its value in parentheses when it is not a plain
 * reference. String literals, quoted sheet names, function names and names
 * qualified by a sheet are left alone. `used` collects the names replaced.
 */
export function inlineDefinedNames(
  formula: string,
  names: DefinedName[],
  sheetIndex: number,
  used: Set<string>
): string {
  const lookup = (token: string): DefinedName | undefined => {
    const key = token.toUpperCase()
    return (
      names.find((n) => n.sheet === sheetIndex && n.name.toUpperCase() === key) ||
      names.find((n) => n.sheet === undefined && n.name.toUpperCase() === key)
    )
  }
  const isPlainRef = (ref: string): boolean =>
    /^(('[^']+'|[A-Za-z0-9_.]+)!)?\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/i.test(ref)

  let out = ''
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"' || ch === "'") {
      // A string literal or a quoted sheet name; a doubled quote escapes it.
      let j = i + 1
      while (j < formula.length) {
        if (formula[j] === ch && formula[j + 1] === ch) j += 2
        else if (formula[j] === ch) break
        else j++
      }
      out += formula.slice(i, j + 1)
      i = j + 1
      continue
    }
    const prev = formula[i - 1] || ''
    if (NAME_START.test(ch) && !NAME_CHAR.test(prev) && prev !== '!' && prev !== '$') {
      let j = i + 1
      while (j < formula.length && NAME_CHAR.test(formula[j])) j++
      const token = formula.slice(i, j)
      const next = formula[j] || ''
      const defined =
        next === '(' || next === '!' || CELL_REF.test(token) ? undefined : lookup(token)
      if (defined) {
        used.add(defined.name)
        out += isPlainRef(defined.ref) ? defined.ref : `(${defined.ref})`
      } else {
        out += token
      }
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** A reference to another workbook: "[1]Sheet1!A1" or "'[Book.xlsx]Data'!A1". */
const readsOtherWorkbook = (formula: string): boolean =>
  /\[[^\]]+\][^!]*!/.test(formula.replace(/"(?:[^"]|"")*"/g, '""'))

function displayOf(cell: CellObject): string {
  if (cell.w !== undefined) return cell.w
  return cell.v === undefined || cell.v === null ? '' : String(cell.v)
}

function valueOf(cell: CellObject): FortuneCellValue {
  if (cell.t === 'n')
    return {
      v: cell.v,
      m: displayOf(cell),
      ct: { fa: cell.z ? String(cell.z) : 'General', t: 'n' }
    }
  if (cell.t === 'b')
    return { v: cell.v, m: cell.v ? 'TRUE' : 'FALSE', ct: { fa: 'General', t: 'b' } }
  if (cell.t === 'e')
    return { v: displayOf(cell), m: displayOf(cell), ct: { fa: 'General', t: 'e' } }
  if (cell.t === 'z') return {}
  return {
    v: cell.v === undefined ? '' : String(cell.v),
    m: displayOf(cell),
    ct: { fa: 'General', t: 'g' }
  }
}

/**
 * The fallback conversion: every sheet of `workbook` with its values. Run
 * restoreWorkbookContent() on the result for formulas and comments.
 */
export function sheetsFromWorkbook(
  xlsx: SheetJs,
  workbook: WorkBook,
  newId: () => string
): FortuneSheetLike[] {
  return workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name] || {}
    const celldata: FortuneCellEntry[] = []
    for (const key of Object.keys(sheet)) {
      if (key[0] === '!') continue
      const cell = sheet[key] as CellObject
      if (cell.t === 'z' && !cell.f) continue
      const { r, c } = xlsx.utils.decode_cell(key)
      celldata.push({ r, c, v: valueOf(cell) })
    }
    return { id: newId(), name, order: index, celldata }
  })
}

/**
 * Puts the formulas and comments of `workbook` on `sheets` (the output of
 * either converter), rebuilds each sheet's calculation chain, and reports
 * formulas, defined names and comments to `collector`. Returns new sheets.
 */
export function restoreWorkbookContent(
  xlsx: SheetJs,
  sheets: FortuneSheetLike[],
  workbook: WorkBook,
  collector: ImportFidelityCollector
): FortuneSheetLike[] {
  const allNames = (workbook.Workbook?.Names || []).map((n) => ({
    name: n.Name,
    ref: String(n.Ref || ''),
    sheet: typeof n.Sheet === 'number' ? n.Sheet : undefined
  }))
  // Names a formula can use in place of their reference.
  const inlinable = allNames.filter(
    (n) =>
      n.ref &&
      !n.name.startsWith('_xlnm.') &&
      !n.ref.includes('#REF!') &&
      !readsOtherWorkbook(n.ref)
  )
  const usedNames = new Set<string>()

  const result = sheets.map((original, index) => {
    const sheet: FortuneSheetLike = { ...original, celldata: [...(original.celldata || [])] }
    const sheetIndex = workbook.SheetNames.includes(sheet.name)
      ? workbook.SheetNames.indexOf(sheet.name)
      : index
    const source = workbook.Sheets[workbook.SheetNames[sheetIndex]]
    if (!source) return sheet

    const celldata = sheet.celldata as FortuneCellEntry[]
    const byAddress = new Map<string, number>()
    celldata.forEach((entry, at) => byAddress.set(`${entry.r}_${entry.c}`, at))
    const cellAt = (r: number, c: number, cell: CellObject): FortuneCellValue => {
      const at = byAddress.get(`${r}_${c}`)
      if (at !== undefined) {
        const entry = celldata[at]
        const v = entry.v && typeof entry.v === 'object' ? { ...entry.v } : { ...valueOf(cell) }
        celldata[at] = { ...entry, v }
        return v
      }
      const v = valueOf(cell)
      byAddress.set(`${r}_${c}`, celldata.length)
      celldata.push({ r, c, v })
      return v
    }

    for (const key of Object.keys(source)) {
      if (key[0] === '!') continue
      const cell = source[key] as CellObject
      const { r, c } = xlsx.utils.decode_cell(key)

      if (cell.c?.length) {
        const value = cell.c
          .map((comment) => String(comment.t || '').trim())
          .filter(Boolean)
          .join('\n')
        if (value) {
          cellAt(r, c, cell).ps = {
            left: null,
            top: null,
            width: null,
            height: null,
            value,
            isShow: false
          }
          collector.add('comments', 'converted')
        }
      }

      if (!cell.f) {
        // A converter may have read a formula SheetJS does not see as one.
        continue
      }
      const v = cellAt(r, c, cell)
      if (readsOtherWorkbook(cell.f)) {
        delete v.f
        collector.add(
          'formulas',
          'approximated',
          1,
          'formulas that read another workbook keep their last value'
        )
        continue
      }
      const usedHere = new Set<string>()
      const formula = inlineDefinedNames(cell.f, inlinable, sheetIndex, usedHere)
      usedHere.forEach((name) => usedNames.add(name))
      v.f = `=${formula}`
      if (cell.F) {
        collector.add(
          'formulas',
          'approximated',
          1,
          cell.F.includes(':') && cell.F.split(':')[0] !== cell.F.split(':')[1]
            ? 'array formulas are kept as ordinary formulas on their first cell; the other cells keep their values'
            : 'array formulas are kept as ordinary formulas; a recalculation may give #VALUE!'
        )
      } else if (usedHere.size) {
        collector.add(
          'formulas',
          'approximated',
          1,
          'defined names are replaced by the ranges they stand for'
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

  for (const n of allNames) {
    if (usedNames.has(n.name)) {
      collector.add(
        'definedNames',
        'approximated',
        1,
        'Dynadoc sheets have no named ranges: names are written out in the formulas that use them'
      )
    } else {
      collector.add('definedNames', 'lost', 1, 'Dynadoc sheets have no named ranges')
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
