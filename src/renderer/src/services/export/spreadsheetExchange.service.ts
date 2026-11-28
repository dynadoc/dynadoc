import { transformFortuneToExcel } from '@corbe30/fortune-excel'
import { get } from 'svelte/store'
import { v4 as uuidv4 } from 'uuid'
import { activeSheet } from '../../stores/sheetBridge.store'
import { _$_documentEditorsList } from '../../stores/editor.store'
import { openAlertModal } from '../../stores/alertModal.store'
import { recordDocumentExport } from './exportTracking.service'
import { openSpreadsheetExportModal } from '../../stores/spreadsheetExportModal.store'
import { openSpreadsheetImportModal } from '../../stores/spreadsheetImportModal.store'
import { nodeApi } from '../../utils/shims/node'
import { getUploadedFile, getLastUploadedFile } from '../../utils/uploadCache'
import Utils from '../../utils/Utils'
import { hasFidelityLoss, type ImportFidelityReport } from '../conversion/importFidelity'
import { showImportFidelityReport } from '../conversion/importFidelityToast'
import { importXlsxFile, withDefinedNamesRestored } from '../conversion/xlsxImport'
import { collectKeptNames, withFreeSheetNames, withSheetId } from '../conversion/xlsxImportFidelity'

// const nodeApi =
//   typeof window !== 'undefined' ? (window as any)?.api?.node || (window as any)?.node : null
// const fs = nodeApi?.fs
// const path = nodeApi?.path

export type SpreadsheetExportScope = 'current' | 'all' | 'selected'
export type SpreadsheetImportMode = 'replaceAll' | 'replaceCurrent' | 'append'

export type SpreadsheetExportResult = {
  scope: SpreadsheetExportScope
  fileType: 'xlsx' | 'csv'
  selectedSheetIds?: string[]
  openAfterExport?: boolean
  revealAfterExport?: boolean
  outputPath?: string
}

export type SpreadsheetImportResult = {
  mode: SpreadsheetImportMode
}

const LAST_EXCEL_DIR_KEY = 'ui:lastSpreadsheetExportDir'
const SPREADSHEET_TOAST_STYLE_ID = 'dynadoc-spreadsheet-export-toast'

function ensureToastStyles() {
  if (document.getElementById(SPREADSHEET_TOAST_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SPREADSHEET_TOAST_STYLE_ID
  style.textContent = `
    .spreadsheet-export-toast {
      position: fixed;
      right: 20px;
      bottom: 24px;
      z-index: 10000;
      min-width: 320px;
      max-width: 420px;
      background: rgba(12, 16, 25, 0.96);
      color: #f3f4f6;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 14px 16px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(12px);
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 160ms ease, transform 160ms ease;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .spreadsheet-export-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .spreadsheet-export-toast .title {
      font-weight: 600;
      letter-spacing: 0.3px;
      font-size: 13px;
    }
    .spreadsheet-export-toast .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.6);
      word-break: break-all;
      line-height: 1.3;
    }
    .spreadsheet-export-toast .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .spreadsheet-export-toast .btn {
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.06);
      color: #fff;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      cursor: pointer;
      transition: background 120ms ease, border 120ms ease;
    }
    .spreadsheet-export-toast .btn:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.3);
    }
  `
  document.head.appendChild(style)
}

function showProgressToast(title: string): () => void {
  ensureToastStyles()
  const toast = document.createElement('div')
  toast.className = 'spreadsheet-export-toast'
  toast.innerHTML = `<div class="title" style="display:flex;align-items:center;gap:8px">
    <span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite"></span>
    ${title}
  </div>`
  if (!document.getElementById('spreadsheet-spin-keyframes')) {
    const kf = document.createElement('style')
    kf.id = 'spreadsheet-spin-keyframes'
    kf.textContent = '@keyframes spin{to{transform:rotate(360deg)}}'
    document.head.appendChild(kf)
  }
  document.body.appendChild(toast)
  requestAnimationFrame(() => toast.classList.add('show'))
  return () => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 180)
  }
}

function showExportToast(title: string, path: string, options: { onOpen?: () => void; onReveal?: () => void }) {
  ensureToastStyles()
  const toast = document.createElement('div')
  toast.className = 'spreadsheet-export-toast'
  toast.innerHTML = `
    <div class="title">${title}</div>
    <div class="path">${path}</div>
    <div class="actions">
      <button class="btn" data-action="open">Open file</button>
      <button class="btn" data-action="reveal">Show in folder</button>
    </div>
  `

  const handleClick = (event: Event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    const action = target.getAttribute('data-action')
    if (action === 'open') options.onOpen?.()
    if (action === 'reveal') options.onReveal?.()
  }

  toast.addEventListener('click', handleClick)
  document.body.appendChild(toast)

  requestAnimationFrame(() => toast.classList.add('show'))

  const removeToast = () => {
    toast.classList.remove('show')
    setTimeout(() => {
      toast.removeEventListener('click', handleClick)
      toast.remove()
    }, 180)
  }

  setTimeout(removeToast, 7000)
}

function getLastExportDir(): string | null {
  try {
    return window.localStorage.getItem(LAST_EXCEL_DIR_KEY)
  } catch {
    return null
  }
}

function setLastExportDir(dir: string) {
  try {
    window.localStorage.setItem(LAST_EXCEL_DIR_KEY, dir)
  } catch {
    // ignore
  }
}

function createSheetRef(methods: any, sheets: any[], currentSheet: any) {
  return {
    current: {
      ...methods,
      getAllSheets: () => sheets,
      getSheet: () => currentSheet || sheets?.[0]
    }
  }
}

function ensureUniqueSheetIds(sheets: any[], existingIds: Set<string>) {
  return sheets.map((sheet) => {
    let id = sheet?.id || uuidv4()
    while (existingIds.has(id)) id = uuidv4()
    existingIds.add(id)
    return {
      ...withSheetId(sheet, id),
      name: sheet?.name || 'Sheet'
    }
  })
}

async function createFileFromPath(filePath: string) {
  // An .xls stays as it is: importXlsxFile() converts it and says so in its report.
  const cached = getUploadedFile(filePath)
  if (cached) {
    return cached
  }
  const fallback =
    filePath?.includes('/.tmp/uploads/') || filePath?.includes('public-temp/')
      ? getLastUploadedFile()
      : null
  if (fallback) {
    return fallback
  }
  const shouldDebug = (() => {
    try {
      return localStorage.getItem('ddoc.upload.debug') === 'true'
    } catch {
      return false
    }
  })()
  const buffer = await nodeApi.fsPromises.readFile(filePath)
  const normalizedBuffer =
    typeof buffer === 'string' ? new TextEncoder().encode(buffer) : buffer
  const byteLength =
    (normalizedBuffer as any)?.byteLength ?? (normalizedBuffer as any)?.length ?? 0
  if (!byteLength) {
    if (shouldDebug) {
      console.warn('[SpreadsheetImport] Empty file data', { filePath, bufferType: typeof buffer })
    }
    throw new Error('Empty file data')
  }
  const name = nodeApi.path.basename(filePath)
  const ext = nodeApi.path.extname(name).toLowerCase()
  const type = ext === '.csv'
    ? 'text/csv'
    : ext === '.xls'
      ? 'application/vnd.ms-excel'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return new File([normalizedBuffer], name, { type })
}

export async function promptAndExportActiveSheet() {
  const entry = get(activeSheet)
  if (!entry?.methods) {
    await openAlertModal({
      title: 'No active sheet',
      message: 'Select a spreadsheet cell before exporting.'
    })
    return
  }

  const allSheets = entry.methods.getAllSheets?.() || []
  const currentSheet = entry.methods.getSheet?.()
  const documentName = _$_documentEditorsList.getActiveSync?.()?.document?.name || 'Spreadsheet'

  const result = await openSpreadsheetExportModal({
    documentName,
    sheets: allSheets.map((sheet: any) => ({
      id: sheet.id,
      name: sheet.name || 'Sheet'
    })),
    defaultScope: 'current'
  })
  if (!result) return

  await exportActiveSheetToFile(result, entry)
}

export async function exportActiveSheetToFile(
  options: SpreadsheetExportResult,
  entry = get(activeSheet)
) {
  if (!entry?.methods) return
  const methods = entry.methods
  const allSheets = methods.getAllSheets?.() || []
  const currentSheet = methods.getSheet?.()

  let sheetsToExport = allSheets
  if (options.scope === 'current') {
    sheetsToExport = currentSheet ? [currentSheet] : allSheets.slice(0, 1)
  } else if (options.scope === 'selected') {
    const selected = new Set(options.selectedSheetIds || [])
    sheetsToExport = allSheets.filter((sheet: any) => selected.has(sheet.id))
  }

  if (options.fileType === 'csv' && sheetsToExport.length > 1) {
    await openAlertModal({
      title: 'CSV supports a single sheet',
      message: 'Choose a single worksheet or switch to Excel (.xlsx) for multi-sheet exports.'
    })
    return
  }

  const sheetRef = createSheetRef(methods, sheetsToExport, currentSheet)
  const dismissProgress = showProgressToast('Exporting spreadsheet…')
  let blob: Blob
  try {
    blob = await transformFortuneToExcel(sheetRef, options.fileType, false)
  } finally {
    dismissProgress()
  }
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer())
  if (options.fileType === 'xlsx') {
    // Names kept on any sheet, so exporting one sheet still carries the
    // names its validations and print areas use.
    const restored = await withDefinedNamesRestored(
      bytes,
      sheetsToExport,
      collectKeptNames(allSheets)
    )
    bytes = restored.bytes
    if (!restored.restored) {
      await openAlertModal({
        title: 'Export Spreadsheet',
        message:
          'The defined names, array formulas and comments of the imported workbook could not be written back. The file is exported without them.'
      })
    }
  }
  const buffer = Buffer.from(bytes)

  const suggestedName = (currentSheet?.name || 'Spreadsheet')
    .replace(/[\\/:*?"<>|]/g, '_')
  const lastDir = getLastExportDir()
  const defaultPath = lastDir
    ? nodeApi.path.join(lastDir, `${suggestedName}.${options.fileType}`)
    : `${suggestedName}.${options.fileType}`

  const savePath =
    options.outputPath ||
    (await window.api.saveDialogFile({
      title: 'Export Spreadsheet',
      defaultPath,
      filters: [
        { name: 'Excel Workbook', extensions: ['xlsx'] },
        { name: 'CSV', extensions: ['csv'] }
      ]
    }))

  if (!savePath) return

  const finalPath = savePath.endsWith(`.${options.fileType}`)
    ? savePath
    : `${savePath}.${options.fileType}`

  await nodeApi.fsPromises.mkdir(nodeApi.path.dirname(finalPath), { recursive: true })
  // base64: the web bridge would write a Buffer as its printed form.
  await nodeApi.fsPromises.writeFile(finalPath, buffer.toString('base64'), 'base64')
  setLastExportDir(nodeApi.path.dirname(finalPath))

  showExportToast('Spreadsheet export ready', finalPath, {
    onOpen: () => window.api.openFile(finalPath),
    onReveal: () => window.api.openFile(nodeApi.path.dirname(finalPath))
  })

  if (options.openAfterExport) {
    window.api.openFile(finalPath)
  } else if (options.revealAfterExport) {
    window.api.openFile(nodeApi.path.dirname(finalPath))
  }

  const activeDocument = _$_documentEditorsList.getActiveSync?.()
  if (activeDocument) {
    recordDocumentExport(activeDocument, {
      format: options.fileType,
      target: options.fileType,
      outputPath: finalPath,
      scope: options.scope
    })
  }
}

export async function promptAndImportSpreadsheetToActiveSheet() {
  const entry = get(activeSheet)
  if (!entry?.methods) {
    await openAlertModal({
      title: 'No active sheet',
      message: 'Select a spreadsheet cell before importing.'
    })
    return
  }

  const filePath = await openSpreadsheetFileDialog()
  if (!filePath) return

  const result = await openSpreadsheetImportModal({
    fileName: nodeApi.path.basename(filePath)
  })
  if (!result) return

  try {
    await importSpreadsheetFileToActiveSheet(filePath, result, entry)
  } catch (error) {
    console.error('Import spreadsheet failed', error)
    await openAlertModal({
      title: 'Import Spreadsheet',
      message: 'Unable to read the selected file. Please try again.'
    })
  }
}

export async function importSpreadsheetFileToActiveSheet(
  filePath: string,
  options: SpreadsheetImportResult,
  entry = get(activeSheet)
): Promise<ImportFidelityReport | null> {
  if (!entry?.methods) return null
  const methods = entry.methods
  const existingSheets = methods.getAllSheets?.() || []
  const currentSheet = methods.getSheet?.()
  const existingIds = new Set(existingSheets.map((sheet: any) => sheet.id))

  const file = await createFileFromPath(filePath)

  const setSheets = (importedSheets: any[]) => {
    let nextSheets = JSON.parse(JSON.stringify(importedSheets || []))

    if (options.mode === 'append') {
      // A sheet whose name is taken gets a new one, and its formulas follow.
      nextSheets = withFreeSheetNames(
        nextSheets,
        existingSheets.map((sheet: any) => sheet.name)
      )
      const adjusted = ensureUniqueSheetIds(nextSheets, existingIds)
      nextSheets = [...existingSheets, ...adjusted]
    } else if (options.mode === 'replaceCurrent' && currentSheet) {
      // importXlsxFile() kept the first sheet only, already renamed.
      const adjusted = ensureUniqueSheetIds(nextSheets, new Set(existingIds))
      const replacement = withSheetId(
        JSON.parse(JSON.stringify(adjusted[0] || currentSheet)),
        currentSheet.id
      )
      nextSheets = existingSheets.map((sheet: any) =>
        sheet.id === currentSheet.id ? replacement : sheet
      )
    }

    methods.updateSheet?.(JSON.parse(JSON.stringify(nextSheets)))
  }

  const sheetRef = { current: methods }

  const dismissProgress = showProgressToast('Importing spreadsheet…')
  let report: ImportFidelityReport | null = null
  try {
    // fortune-excel first, exceljs if it fails; formulas, defined names and
    // comments come from exceljs either way (services/conversion/xlsxImport.ts).
    const result = await importXlsxFile(file, () => `sheet-${uuidv4().slice(0, 8)}`, {
      sheetRef,
      ...(options.mode === 'replaceCurrent' && currentSheet?.name
        ? { keepFirstSheetAs: currentSheet.name }
        : {})
    })
    if (result.sheets.length) setSheets(result.sheets)
    report = result.report
  } finally {
    dismissProgress()
  }
  if (report && hasFidelityLoss(report)) showImportFidelityReport(report)
  return report
}

export async function openSpreadsheetFileDialog() {
  const files = await window.api.openDialogFile([
    { name: 'Spreadsheets', extensions: [Utils.OFFICE_EXTENSIONS_FORMAT.excel, 'csv'] }
  ])
  if (!files?.length) return null
  return files[0]
}

export async function importSpreadsheetFileIntoNewDocument(filePath: string) {
  const documentEditors = _$_documentEditorsList.getList()

  const EditorCommonUtils = (await import('../../utils/common.utils')).default
  await EditorCommonUtils.addNewDocumentEditor(null, null, undefined, 'sheet', 'default')

  const activeDocument = _$_documentEditorsList.getActiveSync?.()
  if (!activeDocument?.document) return documentEditors

  const html = await activeDocument.document.getMainFileContent()
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const sheetNode = doc.querySelector('sheet')
  let rootPath = sheetNode?.getAttribute('src') || ''
  
  if (!rootPath) {
    // If we're on desktop and it's a new document, the path might not be in HTML yet
    const docPath = activeDocument.document.path;
    const docName = activeDocument.document.name;
    if (docPath) {
       rootPath = nodeApi.path.join(nodeApi.path.dirname(docPath), docName + ".sheet");
    }
  }

  if (!rootPath) return documentEditors

  const entry = await waitForSheetReady(rootPath)
  if (!entry?.methods) return documentEditors

  await importSpreadsheetFileToActiveSheet(filePath, { mode: 'replaceAll' }, entry)
  return documentEditors
}

export async function waitForSheetReady(rootPath: string, timeoutMs = 12000) {
  const registry = await import('../../stores/sheetBridge.store')
  const snapshot = registry.sheetRegistry.getSnapshot?.() || {}
  if (snapshot[rootPath]) return snapshot[rootPath]

  return new Promise((resolve) => {
    let timeoutId: any
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { rootPath?: string; methods?: any } | undefined
      if (detail?.rootPath !== rootPath) return
      window.removeEventListener('dynadoc-sheet-ready', handler)
      clearTimeout(timeoutId)
      resolve(detail)
    }

    window.addEventListener('dynadoc-sheet-ready', handler)
    timeoutId = setTimeout(() => {
      window.removeEventListener('dynadoc-sheet-ready', handler)
      resolve(null)
    }, timeoutMs)
  })
}
