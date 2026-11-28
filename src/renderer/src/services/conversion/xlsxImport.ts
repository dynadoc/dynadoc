import { transformExcelToFortune } from '@corbe30/fortune-excel'
import { createImportFidelityCollector, type ImportFidelityReport } from './importFidelity'
import {
  readXlsxWorkbook,
  renameSheet,
  reportXlsxPackage,
  restoreWorkbookContent,
  restoreXlsxExport,
  scanXlsxPackage,
  sheetsFromWorkbook,
  type FortuneSheetLike,
  type XlsxPackageScan,
  type XlsxWorkbookContent
} from './xlsxImportFidelity'

// The one spreadsheet import of the app: "Import" into a sheet
// (spreadsheetExchange.service.ts) and the spreadsheet viewer
// (ReactSpreadsheetFileViewer.tsx) both call importXlsxFile(), so the two
// stop drifting. fortune-excel converts first (styles, widths, images,
// validation); exceljs is the fallback when it fails. Either way formulas,
// defined names and comments come from exceljs, and the report says what
// was kept, approximated and lost.

export type XlsxImportResult = {
  sheets: FortuneSheetLike[]
  /** Null for a CSV: nothing in it can be lost. */
  report: ImportFidelityReport | null
}

export type XlsxImportOptions = {
  /** Keep only the first sheet, under this name ("replace current worksheet"). */
  keepFirstSheetAs?: string
  /** Handed to fortune-excel, which sets column widths and row heights on it. */
  sheetRef?: unknown
}

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') }
  return (mod.default ?? mod) as typeof import('exceljs')
}

const isCsv = (file: File): boolean => file.type === 'text/csv' || /\.csv$/i.test(file.name || '')
const isXls = (name: string): boolean => /\.xls$/i.test(name || '')

/**
 * An .xls converted to .xlsx, the only way the converters read it. Uses
 * SheetJS until #135 replaces it; what the conversion drops cannot be listed.
 */
export async function xlsToXlsxFile(bytes: Uint8Array, name: string): Promise<File> {
  const xlsx = await import('xlsx')
  const workbook = xlsx.read(bytes, { type: 'array' })
  const out = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })
  return new File([out], name.replace(/\.xls$/i, '.xlsx'), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
}

async function sha256(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

/**
 * Converts `file` (.xlsx, .xls or .csv) to fortune-sheet sheets, with the
 * import report. Throws when neither converter can read the file: a
 * fallback that drops formulas would be worse than an error.
 */
export async function importXlsxFile(
  file: File,
  newId: () => string,
  options: XlsxImportOptions = {}
): Promise<XlsxImportResult> {
  const convert = async (input: File): Promise<FortuneSheetLike[]> => {
    let sheets: FortuneSheetLike[] = []
    await transformExcelToFortune(
      input,
      (converted: unknown) => {
        sheets = (converted || []) as FortuneSheetLike[]
      },
      () => {},
      options.sheetRef as never
    )
    return sheets
  }

  if (isCsv(file)) {
    const sheets = await convert(file)
    return {
      sheets: options.keepFirstSheetAs ? sheets.slice(0, 1) : sheets,
      report: null
    }
  }

  const sourceName = file.name || 'spreadsheet.xlsx'
  const original = new Uint8Array(await file.arrayBuffer())
  const collector = createImportFidelityCollector({
    name: sourceName,
    kind: isXls(sourceName) ? 'xls' : 'xlsx',
    sha256: await sha256(original)
  })
  let xlsxFile = file
  if (isXls(sourceName)) {
    xlsxFile = await xlsToXlsxFile(original, sourceName)
    collector.unavailable(
      'the .xls file was converted to .xlsx first; what that conversion dropped is not listed'
    )
  }
  const bytes = isXls(sourceName) ? new Uint8Array(await xlsxFile.arrayBuffer()) : original

  let scan: XlsxPackageScan | null = null
  let content: XlsxWorkbookContent | null = null
  try {
    scan = scanXlsxPackage(bytes)
  } catch (err) {
    console.warn('[xlsx import] could not list the parts of the file', err)
    collector.unavailable('the parts of the file could not be listed')
  }
  try {
    content = await readXlsxWorkbook(await loadExcelJs(), bytes)
  } catch (err) {
    console.warn('[xlsx import] exceljs could not read the file', err)
    collector.unavailable(
      'formulas, defined names and comments could not be read; they are as the converter found them'
    )
  }

  let converted: FortuneSheetLike[] = []
  try {
    converted = await convert(xlsxFile)
  } catch (err) {
    console.warn('[xlsx import] fortune-excel failed, using exceljs', err)
  }
  if (!converted.length) {
    if (!content) throw new Error('The spreadsheet could not be read.')
    converted = sheetsFromWorkbook(content, newId)
  }
  if (options.keepFirstSheetAs) converted = converted.slice(0, 1)

  let sheets = content
    ? restoreWorkbookContent(converted, content, scan?.definedNames || [], collector)
    : converted
  if (scan) reportXlsxPackage(scan, sheets, collector)
  if (options.keepFirstSheetAs && sheets[0]) {
    sheets = renameSheet(sheets, sheets[0].name, options.keepFirstSheetAs)
  }
  return { sheets, report: collector.report() }
}

/**
 * The .xlsx fortune-excel exported from `sheets`, with what the import kept
 * aside written back (formulas with names, array formulas, defined names,
 * notes). `restored` is false when that failed: `bytes` then come back
 * unchanged, and saving them over an Office file would lose those.
 */
export async function withDefinedNamesRestored(
  bytes: Uint8Array,
  sheets: FortuneSheetLike[]
): Promise<{ bytes: Uint8Array; restored: boolean }> {
  try {
    return { bytes: await restoreXlsxExport(await loadExcelJs(), bytes, sheets), restored: true }
  } catch (err) {
    console.warn('[xlsx export] could not write the defined names back', err)
    return { bytes, restored: false }
  }
}
