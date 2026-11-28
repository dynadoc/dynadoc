import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type ExcelJSModule from 'exceljs'
import type { ImportFidelityCollector, ImportFidelityPlace } from './importFidelity'

// Formulas, defined names and comments of an .xlsx import, the inventory of
// what a fortune-sheet cannot hold (shapes, charts, tables, pivot caches...),
// and the export step that writes back what the import kept aside.
//
// fortune-excel (the primary converter) reads most formulas but ignores
// defined names, and the fallback kept values only. Both paths now go through
// restoreWorkbookContent(), which takes every formula from exceljs: shared
// formulas expanded into each cell, array formulas on their first cell.
//
// Defined names: fortune-sheet has no named ranges. A formula that uses one
// gets the name replaced by its reference for fortune-sheet to compute
// (`=B1*TauxTVA` -> `=B1*'Données'!$B$2`), and keeps the user's formula and
// the names it uses in extra cell keys, which fortune-sheet keeps through
// edits and the saved snapshot (the same way as VAR_SOURCE_KEY in
// useSheetVariables.tsx). The workbook's whole name list (print areas, names
// used by validation lists or charts included) is kept on the first sheet's
// A1 cell. restoreXlsxExport() writes all of it back on export. The names are
// read from xl/workbook.xml directly: exceljs drops constant names and sheet
// scopes.
//
// Pure: exceljs is passed in, fflate is the only import.
// tests/smoke/xlsx-import-fidelity.test.mjs runs it.

type ExcelJs = Pick<typeof ExcelJSModule, 'Workbook'>

/** The user's formula, when the one given to fortune-sheet has names written out. */
export const XLSX_FORMULA_KEY = 'xlsxFormula'
/** The defined names that formula uses. */
export const XLSX_NAMES_KEY = 'xlsxNames'
/** An array formula: its range, and the formula given to fortune-sheet. */
export const XLSX_ARRAY_KEY = 'xlsxArray'
/** On the first sheet's A1: what the workbook held that no cell shows. */
export const XLSX_WORKBOOK_KEY = 'xlsxWorkbook'

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
  [XLSX_ARRAY_KEY]?: { ref: string; f: string }
  [XLSX_WORKBOOK_KEY]?: { names: XlsxDefinedName[] }
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

/** Something in the package that no converter carries over. */
export type XlsxFinding = {
  kind: string
  reason: string
  count: number
  place?: ImportFidelityPlace
}

export type XlsxPackageScan = {
  sheetNames: string[]
  definedNames: XlsxDefinedName[]
  comments: number
  pictures: number
  /** Per sheet name, the first cell (0-based) of each data validation rule. */
  validations: Record<string, Array<{ r: number; c: number; fromRange?: boolean }>>
  /** Always lost: the sheets cannot hold them and the export does not write them. */
  findings: XlsxFinding[]
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
  /** Merged ranges per sheet, as "A1:B2". */
  merges: Record<string, string[]>
}

// --- XML and reference helpers ---------------------------------------------

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

const SIMPLE_SHEET_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u
const LOOKS_LIKE_REF = /^([A-Z]{1,3}\d+|R\d*C\d*|TRUE|FALSE)$/i

/** A sheet name as a formula writes it: quoted when it has to be. */
export const quoteSheetName = (name: string): string =>
  SIMPLE_SHEET_NAME.test(name) && !LOOKS_LIKE_REF.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`

/**
 * Walks the sheet prefixes of a formula ("Data!", "'My sheet'!"), outside
 * string literals. `visit` gets the sheet name and returns the prefix to
 * write in its place, or undefined to leave it.
 */
function mapSheetPrefixes(formula: string, visit: (sheet: string) => string | undefined): string {
  let out = ''
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    if (ch === '"') {
      let j = i + 1
      while (j < formula.length && !(formula[j] === '"' && formula[j + 1] !== '"')) {
        j += formula[j] === '"' ? 2 : 1
      }
      out += formula.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < formula.length && !(formula[j] === "'" && formula[j + 1] !== "'")) {
        j += formula[j] === "'" ? 2 : 1
      }
      const quoted = formula.slice(i, j + 1)
      if (formula[j + 1] === '!') {
        const replaced = visit(quoted.slice(1, -1).replace(/''/g, "'"))
        out += replaced === undefined ? quoted : replaced
      } else {
        out += quoted
      }
      i = j + 1
      continue
    }
    const prev = formula[i - 1] || ''
    if (/[\p{L}_]/u.test(ch) && !/[\p{L}\p{N}_.$\]]/u.test(prev)) {
      let j = i + 1
      while (j < formula.length && /[\p{L}\p{N}_.]/u.test(formula[j])) j++
      const token = formula.slice(i, j)
      const replaced = formula[j] === '!' ? visit(token) : undefined
      out += replaced === undefined ? token : replaced
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** The sheets a formula or a name's reference reads. */
export function referencedSheets(formula: string): string[] {
  const sheets: string[] = []
  mapSheetPrefixes(formula, (sheet) => {
    if (!sheets.includes(sheet)) sheets.push(sheet)
    return undefined
  })
  return sheets
}

/** `formula` with every reference to sheet `from` pointing at sheet `to`. */
export function renameSheetReferences(formula: string, from: string, to: string): string {
  return mapSheetPrefixes(formula, (sheet) => (sheet === from ? quoteSheetName(to) : undefined))
}

/** A cell reference with a part not fixed by `$` ("A1", "$A1"), outside sheet names. */
function hasRelativeReference(ref: string): boolean {
  const stripped = ref.replace(/'([^']|'')*'!/g, '!').replace(/"(?:[^"]|"")*"/g, '""')
  for (const match of stripped.matchAll(
    /(?<![\p{L}\p{N}_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?!!)/giu
  )) {
    if (!match[1] || !match[3]) return true
  }
  return false
}

// --- package inventory ------------------------------------------------------

// Parts the import knows about. Anything else is reported as "other content",
// so the save warning fails safe on a part type nobody has looked at.
const KNOWN_PARTS = [
  /^\[Content_Types\]\.xml$/,
  /(^|\/)_rels\//,
  /^docProps\/(app|core)\.xml$/,
  /^docProps\/thumbnail\.\w+$/,
  /^xl\/(workbook|styles|sharedStrings|calcChain|metadata)\.xml$/,
  /^xl\/theme\//,
  /^xl\/worksheets\/[^/]+\.xml$/,
  /^xl\/media\//,
  /^xl\/drawings\/(drawing\d+\.xml|vmlDrawing\d+\.vml)$/,
  /^xl\/comments\d*\.xml$/,
  /^xl\/(threadedComments|persons)\//,
  /^xl\/(charts|chartsheets|tables|pivotTables|pivotCache|externalLinks|slicers|slicerCaches|printerSettings|ctrlProps)\//,
  /^xl\/vbaProject\.bin$/
]

/** Lists what the package holds, by reading its parts (names and XML). */
export function scanXlsxPackage(bytes: Uint8Array): XlsxPackageScan {
  const scan: XlsxPackageScan = {
    sheetNames: [],
    definedNames: [],
    comments: 0,
    pictures: 0,
    validations: {},
    findings: []
  }
  const lost = (kind: string, reason: string, n: number, place?: ImportFidelityPlace): void => {
    if (n > 0) scan.findings.push({ kind, reason, count: n, ...(place ? { place } : {}) })
  }
  const wanted = (name: string): boolean =>
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name) ||
    /^xl\/drawings\/(drawing\d+\.xml|vmlDrawing\d+\.vml)$/.test(name) ||
    /^xl\/comments\d*\.xml$/.test(name) ||
    /^xl\/threadedComments\/[^/]+\.xml$/.test(name)
  const names: string[] = []
  const files = unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name)
      return wanted(file.name)
    }
  })
  const text = (name: string): string => (files[name] ? strFromU8(files[name]) : '')

  for (const part of names) {
    const place = { part }
    if (part === 'xl/vbaProject.bin') lost('macros', 'VBA macros are never imported', 1, place)
    if (/^xl\/charts\/chart(Ex)?\d+\.xml$/.test(part) || /^xl\/chartsheets\/[^/]+\.xml$/.test(part))
      lost('charts', 'charts are not converted', 1, place)
    if (/^xl\/tables\/[^/]+\.xml$/.test(part))
      lost('tables', 'tables are not converted; their cells keep their values', 1, place)
    if (/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(part))
      lost(
        'pivotCaches',
        'the pivot table cells keep their values, the pivot cache is dropped',
        1,
        place
      )
    if (/^xl\/externalLinks\/externalLink\d+\.xml$/.test(part))
      lost('externalLinks', 'links to other workbooks are dropped', 1, place)
    if (/^xl\/slicers\/[^/]+\.xml$/.test(part))
      lost('slicers', 'slicers are not converted', 1, place)
    if (part === 'docProps/custom.xml')
      lost(
        'documentProperties',
        'custom document properties, sensitivity labels included, are not kept',
        1,
        place
      )
    if (/^customXml\/item\d+\.xml$/.test(part))
      lost('documentProperties', 'custom XML data attached to the workbook is not kept', 1, place)
    if (/^xl\/printerSettings\//.test(part))
      lost('printSettings', 'printer settings are not kept', 1, place)
    if (
      !part.endsWith('/') &&
      !/^customXml\//.test(part) &&
      part !== 'docProps/custom.xml' &&
      !KNOWN_PARTS.some((known) => known.test(part))
    )
      lost('otherParts', 'content the import does not recognise', 1, place)
  }

  for (const part of Object.keys(files)) {
    const xml = text(part)
    if (/^xl\/comments\d*\.xml$/.test(part)) scan.comments += count(xml, /<comment[\s>]/g)
    if (/^xl\/threadedComments\//.test(part))
      lost(
        'comments',
        'replies in comment threads are not kept',
        count(xml, /<threadedComment\b[^>]*\sparentId="/g),
        { part }
      )
    if (/\.vml$/.test(part)) {
      const controls = (xml.match(/ObjectType="([^"]+)"/g) || []).filter(
        (type) => type !== 'ObjectType="Note"'
      ).length
      lost('formControls', 'form controls and legacy shapes are not converted', controls, { part })
    }
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(part)) continue
    scan.pictures += count(xml, /<(?:\w+:)?pic[\s>]/g)
    let shapes = count(xml, /<(?:\w+:)?cxnSp[\s>]/g)
    let textBoxes = 0
    for (const shape of xml.match(/<((?:\w+:)?)sp[\s>][\s\S]*?<\/\1sp>/g) || []) {
      if (/txBox="(1|true)"/.test(shape)) textBoxes++
      else shapes++
    }
    lost('shapes', 'Dynadoc sheets have no drawing layer', shapes, { part })
    lost('textBoxes', 'Dynadoc sheets have no drawing layer', textBoxes, { part })
  }

  const workbookXml = text('xl/workbook.xml')
  scan.sheetNames = sheetNamesOf(workbookXml)
  scan.definedNames = definedNamesOf(workbookXml, scan.sheetNames)
  if (/<(?:\w+:)?workbookProtection[\s/>]/.test(workbookXml))
    lost('protection', 'sheet and workbook protection is not kept', 1, { part: 'xl/workbook.xml' })

  // Sheet name -> worksheet part, through the workbook's relationships.
  const targets: Record<string, string> = {}
  for (const rel of text('xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) || []) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (!id || !target) continue
    targets[id] = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  for (const sheetElement of workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []) {
    const sheet = attr(sheetElement, 'name') || ''
    const state = attr(sheetElement, 'state')
    if (state === 'hidden' || state === 'veryHidden')
      lost('hiddenSheets', 'a hidden sheet is saved visible', 1, { sheet })
    const xml = text(targets[attr(sheetElement, 'r:id') || ''] || '')
    if (!xml) continue
    if (/<(?:\w+:)?sheetProtection[\s/>]/.test(xml))
      lost('protection', 'sheet and workbook protection is not kept', 1, { sheet })
    for (const block of xml.match(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g) ||
      []) {
      lost('conditionalFormatting', 'not converted', count(block, /<(?:\w+:)?cfRule[\s>]/g), {
        sheet,
        cell: attr(block, 'sqref')
      })
    }
    for (const block of xml.match(
      /<x14:conditionalFormatting\b[\s\S]*?<\/x14:conditionalFormatting>/g
    ) || []) {
      lost('conditionalFormatting', 'not converted', count(block, /<x14:cfRule[\s>]/g), {
        sheet,
        cell: /<xm:sqref>([^<]*)<\/xm:sqref>/.exec(block)?.[1]
      })
    }
    const filter = /<autoFilter\b[^>]*>/.exec(xml)?.[0]
    if (filter) lost('autoFilter', 'filters are not kept', 1, { sheet, cell: attr(filter, 'ref') })
    if (/<pane\b[^>]*\sstate="frozen(Split)?"/.test(xml))
      lost('frozenPanes', 'frozen rows and columns are not kept', 1, { sheet })
    if (/<(odd|even|first)(Header|Footer)>[^<]/.test(xml))
      lost('printSettings', 'headers and footers are not kept', 1, { sheet })
    // fortune-excel writes a default portrait page setup and no page breaks.
    const pageSetup = /<pageSetup\b[^>]*>/.exec(xml)?.[0] || ''
    const margins = /<pageMargins\b[^>]*>/.exec(xml)?.[0]
    const defaultMargins = {
      left: 0.7,
      right: 0.7,
      top: 0.75,
      bottom: 0.75,
      header: 0.3,
      footer: 0.3
    }
    if (
      attr(pageSetup, 'orientation') === 'landscape' ||
      (attr(pageSetup, 'scale') ?? '100') !== '100' ||
      /<pageSetUpPr\b[^>]*\sfitToPage="(1|true)"/.test(xml) ||
      (margins &&
        Object.entries(defaultMargins).some(
          ([side, value]) => Math.abs(Number(attr(margins, side) ?? value) - value) > 1e-6
        ))
    )
      lost('printSettings', 'page orientation, scaling and margins are not kept', 1, { sheet })
    const breaks = count(xml, /<brk\b/g)
    lost('printSettings', 'page breaks are not kept', breaks, { sheet })
    lost('sparklines', 'sparklines are not converted', count(xml, /<x14:sparkline>/g), { sheet })
    // A list read from a range or a name (not "a,b,c") is saved by
    // fortune-excel as the fixed text of its formula.
    const cells: Array<{ r: number; c: number; fromRange?: boolean }> = []
    for (const rule of xml.match(/<dataValidation\b[\s\S]*?(?:<\/dataValidation>|\/>)/g) || []) {
      const cell = firstCellOf(attr(rule, 'sqref') || '')
      const formula = decodeXml(/<formula1>([^<]*)<\/formula1>/.exec(rule)?.[1] || '').trim()
      const fromRange =
        attr(rule, 'type') === 'list' && Boolean(formula) && !formula.startsWith('"')
      if (cell) cells.push({ ...cell, ...(fromRange ? { fromRange } : {}) })
    }
    // Rules Excel writes in the x14 extension: lists that read another sheet.
    for (const rule of xml.match(/<x14:dataValidation\b[\s\S]*?<\/x14:dataValidation>/g) || []) {
      const cell = firstCellOf(/<xm:sqref>([^<]*)<\/xm:sqref>/.exec(rule)?.[1] || '')
      if (cell) cells.push({ ...cell, fromRange: true })
    }
    if (cells.length) scan.validations[sheet] = cells
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
  collector.add('comments', 'converted', Math.min(keptComments, scan.comments))
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
  for (const [sheet, cells] of Object.entries(scan.validations)) {
    const imported = sheets.find((candidate) => candidate.name === sheet)
    for (const cell of cells) {
      const place = { sheet, cell: toA1(cell.r, cell.c) }
      if (cell.fromRange) {
        collector.add(
          'dataValidation',
          'lost',
          1,
          'a list read from a range or a name is saved as fixed text',
          place
        )
      } else if (imported?.dataVerification?.[`${cell.r}_${cell.c}`]) {
        collector.add('dataValidation', 'converted')
      } else {
        collector.add('dataValidation', 'lost', 1, 'rule types the converter does not read', {
          sheet,
          cell: toA1(cell.r, cell.c)
        })
      }
    }
  }
  for (const finding of scan.findings) {
    collector.add(finding.kind, 'lost', finding.count, finding.reason, finding.place)
  }
}

// --- defined names in formulas ----------------------------------------------

const CELL_REF = /^\$?[A-Z]{1,3}\$?\d+$/i
const NAME_START = /[\p{L}_\\]/u
const NAME_CHAR = /[\p{L}\p{N}_.\\?]/u
const PLAIN_REF = /^(('([^']|'')+'|[\p{L}\p{N}_.]+)!)?\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/iu

/** A reference to another workbook: "[1]Sheet1!A1" or "'[Book.xlsx]Data'!A1". */
const readsOtherWorkbook = (formula: string): boolean =>
  /\[[^\]]+\][^!]*!/.test(formula.replace(/"(?:[^"]|"")*"/g, '""'))

/** A structured reference to an Excel table: "Table1[Amount]". */
const readsTable = (formula: string): boolean =>
  /[\p{L}_][\p{L}\p{N}_.]*\[/u.test(formula.replace(/"(?:[^"]|"")*"/g, '""'))

/** Names a formula can use in place of their reference. */
const isInlinable = (n: XlsxDefinedName): boolean =>
  Boolean(n.ref) &&
  !n.name.startsWith('_xlnm.') &&
  !n.ref.includes('#REF!') &&
  !readsOtherWorkbook(n.ref) &&
  !hasRelativeReference(n.ref)

/**
 * `formula` with every defined name replaced by its reference ("Total" ->
 * "Data!$A$1:$A$3"), or by its value in parentheses when it is not a plain
 * reference. A name scoped to `sheetName` wins over a workbook name. String
 * literals, quoted sheet names, function names and names qualified by a sheet
 * are left alone. `used` collects the names replaced, `kept` the names found
 * but left as they are (relative references, other workbooks, #REF!). Names
 * that use other names are written out too, up to a few levels.
 */
export function inlineDefinedNames(
  formula: string,
  names: XlsxDefinedName[],
  sheetName: string | undefined,
  used: XlsxDefinedName[],
  kept: XlsxDefinedName[] = []
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
          next === '(' || next === '!' || next === '[' || CELL_REF.test(token)
            ? undefined
            : lookup(token)
        if (defined && isInlinable(defined)) {
          if (!used.includes(defined)) used.push(defined)
          out += PLAIN_REF.test(defined.ref) ? defined.ref : `(${defined.ref})`
          changed = true
        } else {
          if (defined && !kept.includes(defined)) kept.push(defined)
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
  const content: XlsxWorkbookContent = { sheetNames: [], cells: {}, merges: {} }
  workbook.eachSheet((worksheet) => {
    const cells: XlsxCell[] = []
    content.sheetNames.push(worksheet.name)
    content.cells[worksheet.name] = cells
    content.merges[worksheet.name] = [...((worksheet.model as { merges?: string[] }).merges || [])]
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
  return content.sheetNames.map((name, index) => {
    const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {}
    for (const range of content.merges[name] || []) {
      const [from, to] = range.split(':').map(decodeCellAddress)
      if (!from || !to) continue
      merge[`${from.r}_${from.c}`] = {
        r: from.r,
        c: from.c,
        rs: to.r - from.r + 1,
        cs: to.c - from.c + 1
      }
    }
    return {
      id: newId(),
      name,
      order: index,
      status: index === 0 ? 1 : 0,
      celldata: content.cells[name]
        .filter((cell) => cell.value.v !== undefined || cell.formula)
        .map((cell) => ({ r: cell.r, c: cell.c, v: { ...cell.value } })),
      ...(Object.keys(merge).length ? { config: { merge } } : {})
    }
  })
}

/**
 * Puts the formulas and comments of `content` on `sheets` (the output of
 * either converter), keeps the workbook's names on the first sheet, rebuilds
 * each sheet's calculation chain, and reports formulas, defined names and
 * comments to `collector`. Returns new sheets.
 */
export function restoreWorkbookContent(
  sheets: FortuneSheetLike[],
  content: XlsxWorkbookContent,
  definedNames: XlsxDefinedName[],
  collector: ImportFidelityCollector
): FortuneSheetLike[] {
  const usedNames = new Set<XlsxDefinedName>()
  const keptNames = new Set<XlsxDefinedName>()
  const imported = new Set(sheets.map((sheet) => sheet.name))

  const result = sheets.map((original, index) => {
    const sheet: FortuneSheetLike = { ...original, celldata: [...(original.celldata || [])] }
    const sheetName = content.cells[sheet.name] ? sheet.name : content.sheetNames[index]
    const source = content.cells[sheetName]
    if (!source) return sheet

    const celldata = sheet.celldata as FortuneCellEntry[]
    const byAddress = new Map<string, number>()
    celldata.forEach((entry, at) => byAddress.set(`${entry.r}_${entry.c}`, at))
    const cellAt = (cell: { r: number; c: number; value: FortuneCellValue }): FortuneCellValue => {
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

    if (index === 0 && definedNames.length) {
      cellAt({ r: 0, c: 0, value: {} })[XLSX_WORKBOOK_KEY] = {
        names: definedNames.map((n) => ({ ...n }))
      }
    }

    for (const cell of source) {
      const place = { sheet: sheet.name, cell: toA1(cell.r, cell.c) }
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
      delete v[XLSX_FORMULA_KEY]
      delete v[XLSX_NAMES_KEY]
      delete v[XLSX_ARRAY_KEY]
      if (readsOtherWorkbook(cell.formula)) {
        delete v.f
        collector.add(
          'formulas',
          'lost',
          1,
          'formulas that read another workbook are replaced by their last value',
          place
        )
        continue
      }
      const used: XlsxDefinedName[] = []
      const kept: XlsxDefinedName[] = []
      const computed = inlineDefinedNames(cell.formula, definedNames, sheetName, used, kept)
      const missing = referencedSheets(computed).filter((name) => !imported.has(name))
      if (missing.length) {
        delete v.f
        collector.add(
          'formulas',
          'lost',
          1,
          'formulas that read a sheet that was not imported are replaced by their last value',
          place
        )
        continue
      }
      v.f = `=${computed}`
      if (used.length) {
        v[XLSX_FORMULA_KEY] = `=${cell.formula}`
        v[XLSX_NAMES_KEY] = used.map((n) => ({ ...n }))
        used.forEach((n) => usedNames.add(n))
      }
      kept.forEach((n) => keptNames.add(n))
      if (cell.arrayRef) v[XLSX_ARRAY_KEY] = { ref: cell.arrayRef, f: v.f }

      if (readsTable(cell.formula)) {
        collector.add(
          'formulas',
          'lost',
          1,
          'formulas that read an Excel table cannot compute: the table is not kept',
          place
        )
      } else if (kept.length) {
        collector.add(
          'formulas',
          'approximated',
          1,
          'they use a name Dynadoc cannot compute (a relative reference); written back as they were',
          place
        )
      } else if (cell.arrayRef) {
        collector.add(
          'formulas',
          'approximated',
          1,
          'array formulas are computed as ordinary formulas on their first cell; written back as array formulas',
          place
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
    // Print areas, print titles and filter ranges are written back with the
    // others; they are not something to report.
    if (n.name.startsWith('_xlnm.')) continue
    const place = n.sheetName ? { sheet: n.sheetName } : undefined
    if (usedNames.has(n)) {
      collector.add(
        'definedNames',
        'approximated',
        1,
        'computed as the ranges they stand for, and written back on export',
        place
      )
    } else if (keptNames.has(n)) {
      collector.add(
        'definedNames',
        'approximated',
        1,
        'relative references are not computed; written back on export',
        place
      )
    } else {
      collector.add(
        'definedNames',
        'approximated',
        1,
        'no formula in a cell uses them: kept and written back on export',
        place
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

/**
 * Renames sheet `from` to `to` in `sheets`: the sheet itself, and every
 * reference to it in formulas, kept formulas and defined names.
 */
export function renameSheet<T extends FortuneSheetLike>(
  sheets: T[],
  from: string,
  to: string
): T[] {
  if (from === to) return sheets
  const renameName = (n: XlsxDefinedName): XlsxDefinedName => ({
    ...n,
    ref: renameSheetReferences(n.ref, from, to),
    ...(n.sheetName === from ? { sheetName: to } : {})
  })
  const renameCell = (v: FortuneCellValue | null): FortuneCellValue | null => {
    if (!v || typeof v !== 'object') return v
    const next: FortuneCellValue = { ...v }
    if (typeof next.f === 'string') next.f = renameSheetReferences(next.f, from, to)
    const source = next[XLSX_FORMULA_KEY]
    if (typeof source === 'string') next[XLSX_FORMULA_KEY] = renameSheetReferences(source, from, to)
    const array = next[XLSX_ARRAY_KEY]
    if (array) next[XLSX_ARRAY_KEY] = { ...array, f: renameSheetReferences(array.f, from, to) }
    const names = next[XLSX_NAMES_KEY]
    if (Array.isArray(names)) next[XLSX_NAMES_KEY] = names.map(renameName)
    const workbook = next[XLSX_WORKBOOK_KEY]
    if (workbook) next[XLSX_WORKBOOK_KEY] = { ...workbook, names: workbook.names.map(renameName) }
    return next
  }
  return sheets.map((sheet) => ({
    ...sheet,
    name: sheet.name === from ? to : sheet.name,
    ...(sheet.celldata
      ? { celldata: sheet.celldata.map((entry) => ({ ...entry, v: renameCell(entry.v) })) }
      : {}),
    ...(sheet.data ? { data: sheet.data.map((row) => row?.map(renameCell)) } : {})
  }))
}

/** Every defined name the sheets keep, on A1 or with the formulas that use them. */
export function collectKeptNames(sheets: FortuneSheetLike[]): XlsxDefinedName[] {
  const names = new Map<string, XlsxDefinedName>()
  const visit = (cell: FortuneCellValue | null | undefined): void => {
    if (!cell || typeof cell !== 'object') return
    for (const n of cell[XLSX_WORKBOOK_KEY]?.names || []) names.set(nameKey(n), n)
    for (const n of cell[XLSX_NAMES_KEY] || []) if (!names.has(nameKey(n))) names.set(nameKey(n), n)
  }
  for (const sheet of sheets) {
    sheet.celldata?.forEach((entry) => visit(entry.v))
    sheet.data?.forEach((row) => row?.forEach(visit))
  }
  return [...names.values()]
}

/**
 * `sheets` with every name in `taken` replaced by a free one ("A (2)"), and
 * the references to it following. Names already in `sheets` stay reserved,
 * so a renamed sheet never lands on another imported sheet's name.
 */
export function withFreeSheetNames<T extends FortuneSheetLike>(sheets: T[], taken: string[]): T[] {
  const reserved = new Set([...taken, ...sheets.map((sheet) => sheet.name)])
  const renames: Array<[string, string]> = []
  for (const sheet of sheets) {
    if (!taken.includes(sheet.name)) continue
    let n = 2
    while (reserved.has(`${sheet.name} (${n})`)) n++
    reserved.add(`${sheet.name} (${n})`)
    renames.push([sheet.name, `${sheet.name} (${n})`])
  }
  return renames.reduce((current, [from, to]) => renameSheet(current, from, to), sheets)
}

// --- export -----------------------------------------------------------------

const nameKey = (n: XlsxDefinedName): string => `${n.sheetName ?? ''}\u0000${n.name.toUpperCase()}`

/**
 * The .xlsx fortune-excel exported from `sheets`, with what the import kept
 * aside written back: the user's formulas where names had been written out,
 * array formulas with their range (unless the formula was edited since), the
 * workbook's defined names, and the cell notes (comments), which
 * fortune-excel does not write. `baseNames` (the list the import read, held
 * outside the grid by the caller) is written back even when the copy kept on
 * A1 was cleared. Names that point at a sheet the export does not contain,
 * or at another workbook (its link is not written), are left out.
 */
export async function restoreXlsxExport(
  ExcelJS: ExcelJs,
  bytes: Uint8Array,
  sheets: FortuneSheetLike[],
  baseNames: XlsxDefinedName[] = []
): Promise<Uint8Array> {
  const names = new Map<string, XlsxDefinedName>(baseNames.map((n) => [nameKey(n), n]))
  const restores: Array<{ sheet: string; address: string; formula: string; array?: string }> = []
  const notes: Array<{ sheet: string; address: string; note: string }> = []
  for (const sheet of sheets) {
    const rows: Array<Array<FortuneCellValue | null>> =
      sheet.data ||
      (sheet.celldata || []).reduce<Array<Array<FortuneCellValue | null>>>((grid, entry) => {
        ;(grid[entry.r] ||= [])[entry.c] = entry.v
        return grid
      }, [])
    rows.forEach((row, r) =>
      row?.forEach((cell, c) => {
        if (!cell || typeof cell !== 'object') return
        for (const n of cell[XLSX_WORKBOOK_KEY]?.names || []) names.set(nameKey(n), n)
        const note = cell.ps?.value
        if (typeof note === 'string' && note.trim()) {
          notes.push({ sheet: sheet.name, address: toA1(r, c), note })
        }
        if (!cell.f) return
        const source = cell[XLSX_FORMULA_KEY]
        const used = cell[XLSX_NAMES_KEY]
        const named =
          typeof source === 'string' &&
          Array.isArray(used) &&
          cell.f === `=${inlineDefinedNames(source.slice(1), used, sheet.name, [])}`
        if (named) for (const n of used) if (!names.has(nameKey(n))) names.set(nameKey(n), n)
        const array = cell[XLSX_ARRAY_KEY]
        const isArray = Boolean(array && array.f === cell.f)
        if (!named && !isArray) return
        restores.push({
          sheet: sheet.name,
          address: toA1(r, c),
          formula: (named ? (source as string) : cell.f).slice(1),
          ...(isArray ? { array: array?.ref } : {})
        })
      })
    )
  }
  if (!restores.length && !notes.length && !names.size) return bytes

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  for (const restore of restores) {
    const cell = workbook.getWorksheet(restore.sheet)?.getCell(restore.address)
    if (!cell) continue
    const current = cell.value as { result?: unknown } | null
    const result = current && typeof current === 'object' ? current.result : current
    cell.value = (
      restore.array
        ? { formula: restore.formula, result, shareType: 'array', ref: restore.array }
        : { formula: restore.formula, result }
    ) as ExcelJSModule.CellFormulaValue
  }
  // fortune-excel does not write cell notes.
  for (const { sheet, address, note } of notes) {
    const cell = workbook.getWorksheet(sheet)?.getCell(address)
    if (cell) cell.note = note
  }
  const written = new Uint8Array(await workbook.xlsx.writeBuffer())

  const parts = unzipSync(written)
  let workbookXml = strFromU8(parts['xl/workbook.xml'])
  const sheetNames = sheetNamesOf(workbookXml)
  const present = new Set(definedNamesOf(workbookXml, sheetNames).map(nameKey))
  const elements = [...names.entries()]
    .filter(
      ([key, n]) =>
        !present.has(key) &&
        (!n.sheetName || sheetNames.includes(n.sheetName)) &&
        !readsOtherWorkbook(n.ref) &&
        referencedSheets(n.ref).every((sheet) => sheetNames.includes(sheet))
    )
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
