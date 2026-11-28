import { transformExcelToFortune } from '@corbe30/fortune-excel'
import { createImportFidelityCollector, type ImportFidelityReport } from './importFidelity'
import {
  readXlsxWorkbook,
  reportXlsxPackage,
  restoreWorkbookContent,
  restoreXlsxExport,
  scanXlsxPackage,
  sheetsFromWorkbook,
  type FortuneSheetLike,
  type XlsxPackageScan,
  type XlsxWorkbookContent
} from './xlsxImportFidelity'

// The one .xlsx import of the app: "Import" into a sheet
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

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') }
  return (mod.default ?? mod) as typeof import('exceljs')
}

const isCsv = (file: File): boolean => file.type === 'text/csv' || /\.csv$/i.test(file.name || '')

/**
 * Converts `file` (.xlsx or .csv) to fortune-sheet sheets. `sheetRef` is
 * handed to fortune-excel, which sets column widths and row heights on it.
 * Throws when neither converter can read the file: a fallback that drops
 * formulas would be worse than an error.
 */
export async function importXlsxFile(
  file: File,
  newId: () => string,
  sheetRef?: unknown
): Promise<XlsxImportResult> {
  if (isCsv(file)) {
    let sheets: FortuneSheetLike[] = []
    await transformExcelToFortune(
      file,
      (converted: unknown) => {
        sheets = (converted || []) as FortuneSheetLike[]
      },
      () => {},
      sheetRef as never
    )
    return { sheets, report: null }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const collector = createImportFidelityCollector('xlsx', file.name || 'spreadsheet.xlsx')
  let scan: XlsxPackageScan | null = null
  let content: XlsxWorkbookContent | null = null
  try {
    scan = scanXlsxPackage(bytes)
  } catch (err) {
    console.warn('[xlsx import] could not list the parts of the file', err)
  }
  try {
    content = await readXlsxWorkbook(await loadExcelJs(), bytes)
  } catch (err) {
    console.warn('[xlsx import] exceljs could not read the file', err)
  }

  let converted: FortuneSheetLike[] = []
  try {
    await transformExcelToFortune(
      file,
      (sheets: unknown) => {
        converted = (sheets || []) as FortuneSheetLike[]
      },
      () => {},
      sheetRef as never
    )
  } catch (err) {
    console.warn('[xlsx import] fortune-excel failed, using exceljs', err)
  }
  if (!converted.length) {
    if (!content) throw new Error('The spreadsheet could not be read.')
    converted = sheetsFromWorkbook(content, newId)
  }

  const sheets = content
    ? restoreWorkbookContent(converted, content, scan?.definedNames || [], collector)
    : converted
  if (scan) reportXlsxPackage(scan, sheets, collector)
  return { sheets, report: collector.report() }
}

/**
 * The .xlsx fortune-excel exported from `sheets`, with the formulas that
 * use defined names and the names themselves put back. Returns `bytes`
 * unchanged when that fails, so an export is never lost to it.
 */
export async function withDefinedNamesRestored(
  bytes: Uint8Array,
  sheets: FortuneSheetLike[]
): Promise<Uint8Array> {
  try {
    return await restoreXlsxExport(await loadExcelJs(), bytes, sheets)
  } catch (err) {
    console.warn('[xlsx export] could not write the defined names back', err)
    return bytes
  }
}
