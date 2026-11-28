import { createRoot } from 'react-dom/client'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import '../../libs/fortune-sheet/direction.css'
import React, { useEffect, useRef, useState } from 'react'

import { nodeApi } from '../../../../../utils/shims/node'
import { openConfirmModal } from '../../../../../stores/confirmModal.store'
import {
  describeLostItems,
  type ImportFidelityReport
} from '../../../../../services/conversion/importFidelity'
import { showImportFidelityReport } from '../../../../../services/conversion/importFidelityToast'
import {
  importXlsxFile,
  withDefinedNamesRestored
} from '../../../../../services/conversion/xlsxImport'
// const fs = nodeApi.fs
// const path = nodeApi.path

function ReactSpreadsheetFileViewer({ filePath, readOnly = false }) {
  const sheetRef = useRef<any>(null)
  const [sheets, setSheets] = useState<any[]>([])
  const [key, setKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<any>(null)
  const filePathRef = useRef<string>(filePath)
  const fileTypeRef = useRef<'xlsx' | 'csv'>('xlsx')
  // What the import could not keep: saving over the original file would
  // remove it from there too, so the first save asks.
  const lossRef = useRef<{ report: ImportFidelityReport | null; decision: Promise<boolean> | null }>({
    report: null,
    decision: null
  })

  const toBuffer = (input: any) => {
    if (!input) return Buffer.from([])
    if (Buffer.isBuffer(input)) return input
    if (input instanceof Uint8Array) return Buffer.from(input)
    if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input))
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer as ArrayBuffer)
    if (typeof input === 'string') {
      const trimmed = input.trim()
      if (!trimmed) return Buffer.from([])
      const isBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length % 4 === 0
      try {
        return Buffer.from(trimmed, isBase64 ? 'base64' : 'utf8')
      } catch {
        return Buffer.from(trimmed, 'utf8')
      }
    }
    try {
      return Buffer.from(input)
    } catch {
      return Buffer.from([])
    }
  }

  const applySheets = (nextSheets: any[]) => {
    const cloned = JSON.parse(JSON.stringify(nextSheets || []))
    if (!cloned.length) {
      cloned.push({ id: 'sheet-1', name: 'Sheet1', celldata: [] })
    }
    setSheets(cloned)
  }

  const ensureWorkbookKey = () => setKey((k) => k + 1)

  const mayOverwrite = (): Promise<boolean> => {
    const loss = lossRef.current
    const lost = loss.report ? describeLostItems(loss.report) : ''
    if (!lost) return Promise.resolve(true)
    if (!loss.decision) {
      loss.decision = openConfirmModal({
        title: 'Save over the original file?',
        message: `Saving writes your changes into ${loss.report?.fileName}, and removes from it what the import could not keep (${lost}). Keep the original to leave the file as it is; your changes then stay in this view only.`,
        confirmText: 'Save',
        cancelText: 'Keep the original',
        destructive: true
      }).then((answer: unknown) => answer === true)
    }
    return loss.decision
  }

  const saveNow = async () => {
    try {
      if (!(await mayOverwrite())) return
      const { transformFortuneToExcel } = await import('@corbe30/fortune-excel')
      const blob = await transformFortuneToExcel(sheetRef, fileTypeRef.current, false)
      let bytes = new Uint8Array(await blob.arrayBuffer())
      if (fileTypeRef.current === 'xlsx') {
        bytes = await withDefinedNamesRestored(bytes, sheetRef.current?.getAllSheets?.() || [])
      }
      const buffer = Buffer.from(bytes)
      await nodeApi.fsPromises.writeFile(filePathRef.current, buffer)
    } catch (err) {
      console.warn('Failed to save spreadsheet file', err)
    }
  }

  const scheduleSave = () => {
    if (readOnly) return
    if (!sheetRef.current || !filePathRef.current) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void saveNow()
    }, 800)
  }

  // Flush a pending save when the viewer is closed so the last edits
  // are not lost to the debounce window.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        if (!readOnly && sheetRef.current && filePathRef.current) void saveNow()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const convertXlsToXlsxFile = async (buffer: Buffer, name: string) => {
    const xlsx = await import('xlsx')
    const workbook = xlsx.read(buffer, { type: 'buffer' })
    const out = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })
    const nextName = name.replace(/\.xls$/i, '.xlsx')
    return new File([out], nextName, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
  }

    useEffect(() => {
    if (!filePath) return
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        setError(null)

        let data: any
        // Use readAssetBlob for binary safety on web/mobile
        if (nodeApi.fsPromises?.readAssetBlob) {
          try {
            const result = await nodeApi.fsPromises.readAssetBlob(filePath)
            if (result?.blob) data = result.blob
          } catch (err) {
            console.warn('[SpreadsheetViewer] readAssetBlob failed', err)
          }
        }

        if (!data) {
          try {
            const buffer = await nodeApi.fsPromises.readFile(filePath)
            data = toBuffer(buffer)
          } catch (err) {
            console.warn('[SpreadsheetViewer] readFileSync failed', err)
          }
        }

        if (!data) {
          throw new Error('Unable to read file data')
        }

        const buffer = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data
        const fileName = String(filePath).split(/[\\/]/).pop() || 'spreadsheet.xlsx'
        const ext = (fileName.split('.').pop() || '').toLowerCase()
        fileTypeRef.current = ext === 'csv' ? 'csv' : 'xlsx'

        // fortune-excel first, exceljs if it fails; formulas, defined names and
        // comments come from exceljs either way (services/conversion/xlsxImport.ts).
        const file =
          ext === 'xls'
            ? await convertXlsToXlsxFile(buffer, fileName)
            : new File([buffer], fileName, {
                type:
                  ext === 'csv'
                    ? 'text/csv'
                    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              })
        const result = await importXlsxFile(
          file,
          () => `sheet-${Math.random().toString(36).slice(2, 10)}`,
          sheetRef
        )
        const imported = JSON.parse(JSON.stringify(result.sheets))
        lossRef.current = { report: result.report, decision: null }
        if (!cancelled && result.report) showImportFidelityReport(result.report)

        if (!cancelled) applySheets(imported || [])
      } catch (err) {
        console.error('[SpreadsheetViewer] Load failed', err)
        if (!cancelled) setError('Failed to parse the Excel file.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [filePath])

  return (
    <div
      className="react-spreadsheet-file-viewer"
      // FortuneSheet only supports LTR layout: keep it LTR under an RTL page
      dir="ltr"
      tabIndex={0}
      onPointerDownCapture={(event) => {
        if (readOnly) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onKeyDownCapture={(event) => {
        if (readOnly) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onContextMenu={(event) => {
        if (readOnly) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      {loading ? (
        <div className="react-spreadsheet-file-loading">Loading spreadsheet…</div>
      ) : error ? (
        <div className="react-spreadsheet-file-loading">{error}</div>
      ) : (
        <Workbook
          key={key}
          ref={sheetRef}
          data={sheets.length ? sheets : [{ id: 'sheet-1', name: 'Sheet1', celldata: [] }]}
          allowEdit={!readOnly}
          showToolbar={!readOnly}
          showFormulaBar={!readOnly}
          onOp={() => scheduleSave()}
        />
      )}
    </div>
  )
}

class ReactSpreadsheetFileViewerElement extends HTMLElement {
  _filePath = ''
  _readOnly = false
  _container: HTMLDivElement | null = null
  _root: ReturnType<typeof createRoot> | null = null

  static get observedAttributes() {
    return ['file-path', 'read-only']
  }

  connectedCallback() {
    // Re-attached before the deferred disconnect cleanup ran
    if (this._root) return

    const filePath = this.getAttribute('file-path') || ''
    const readOnlyAttr = this.getAttribute('read-only')
    const readOnly = readOnlyAttr !== null && readOnlyAttr !== 'false' && readOnlyAttr !== '0'

    this._filePath = filePath
    this._readOnly = readOnly

    this._container = document.createElement('div')
    this._container.style.width = '100%'
    this._container.style.height = '100%'
    this.appendChild(this._container)

    this._root = createRoot(this._container)
    this._render(this._filePath, this._readOnly)
  }

  disconnectedCallback() {
    // Deferred unmount so ProseMirror drag re-attachments don't tear the
    // viewer down; on a real close this runs React effect cleanups
    // (flushing the pending save) and releases the React root.
    setTimeout(() => {
      if (this.isConnected) return
      const root = this._root
      const container = this._container
      this._root = null
      this._container = null
      root?.unmount()
      container?.remove()
    }, 0)
  }

  attributeChangedCallback(name, _oldValue, newValue) {
    if (!this._root) return
    if (name === 'file-path') {
      this._filePath = newValue || ''
    }
    if (name === 'read-only') {
      const readOnlyAttr = this.getAttribute('read-only')
      this._readOnly = readOnlyAttr !== null && readOnlyAttr !== 'false' && readOnlyAttr !== '0'
    }
    this._render(this._filePath, this._readOnly)
  }

  _render(filePath, readOnly) {
    this._root.render(
      <ReactSpreadsheetFileViewer
        key={`${filePath}-${readOnly ? 'ro' : 'rw'}`}
        filePath={filePath}
        readOnly={readOnly}
      />
    )
  }
}

customElements.define('react-spreadsheet-file-viewer', ReactSpreadsheetFileViewerElement)
