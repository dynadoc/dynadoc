// Document variables inside a FortuneSheet workbook.
//
// - Typing `@` in the cell editor or the formula bar opens the variable
//   dropdown (the app-wide one from globalVarDropdown, enabled by the
//   data-var-allow attributes set below).
// - A committed input with `@name` tokens is not handed to FortuneSheet as is:
//   the cell gets the resolved value (or the formula with each token replaced
//   by a literal) and keeps the user's input in an extra cell key,
//   VAR_SOURCE_KEY. FortuneSheet keeps unknown cell keys through edits, ops
//   and the snapshot saved in the sheet file, so the source survives a reload.
// - When a variable changes, cells whose source uses it are re-resolved.
// - Editing such a cell, or selecting it, shows the source again.
// - The cell context menu gets "Create variable from cell", which defines a
//   variable whose value follows that cell.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getSheetVariablesApi } from '../../../../../stores/sheetBridge.store'
import {
  evaluateCellVarInput,
  hasCellVarTokens,
  isCellVarName,
  type CellVarResolution
} from '../../../CustomVarExtension/utils/sheetVariables.utils'

export const VAR_SOURCE_KEY = 'varSource'

type SheetCell = { v?: unknown; m?: unknown; f?: string; [key: string]: unknown }

// The part of FortuneSheet's workbook API used here.
type WorkbookApi = {
  getSheet?: () => { id?: string; name?: string; data?: (SheetCell | null)[][] }
  getSelection?: () => { row?: number[]; column?: number[] }[]
  getCellValue?: (row: number, column: number) => unknown
  setCellValue: (row: number, column: number, value: object) => void
  setCellFormat?: (row: number, column: number, attr: string, value: unknown) => void
  calculateFormula?: (id?: string) => void
}

type Options = {
  workbookRef: React.MutableRefObject<WorkbookApi | null>
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  ready: boolean
  rootPath: string
  parentDoc?: unknown
  readOnly?: boolean
}

type SheetHooks = {
  beforeUpdateCell: (row: number, column: number, value: unknown) => boolean
  afterActivateSheet: () => void
}

type CreateForm = {
  row: number
  column: number
  cellRef: string
  sheetName: string
  x: number
  y: number
}

function toA1(row: number, column: number): string {
  let letters = ''
  let c = column + 1
  while (c > 0) {
    const m = (c - 1) % 26
    letters = String.fromCharCode(65 + m) + letters
    c = Math.floor((c - m) / 26)
  }
  return `${letters}${row + 1}`
}

export function useSheetVariables({
  workbookRef,
  containerRef,
  ready,
  rootPath,
  parentDoc,
  readOnly
}: Options): { hooks: SheetHooks; overlay: React.ReactElement } {
  const parentDocRef = useRef(parentDoc)
  parentDocRef.current = parentDoc
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const applied = useRef(new Map<string, string>())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The form keeps its own state: re-rendering the editor re-renders the
  // Workbook, which loses its selection.
  const openForm = useRef<(form: CreateForm) => void>(() => {})

  const resolve = (name: string): CellVarResolution =>
    getSheetVariablesApi()?.resolve(name, parentDocRef.current) || { found: false }

  const applySource = (row: number, column: number, source: string): void => {
    const workbook = workbookRef.current
    if (!workbook) return
    const result = evaluateCellVarInput(source, resolve)
    const sheetId = workbook.getSheet?.()?.id
    applied.current.set(`${sheetId}:${row}:${column}`, JSON.stringify(result))
    if (result.kind === 'formula') {
      workbook.setCellValue(row, column, { f: result.formula, [VAR_SOURCE_KEY]: source })
    } else {
      const value = result.value
      const cell = workbook.getSheet?.()?.data?.[row]?.[column]
      const isTextFormat = (cell?.ct as { fa?: string } | undefined)?.fa === '@'
      // FortuneSheet reads number-like text ('01234', '1e3') as a number unless
      // the cell is formatted as text; a number put back gets General again.
      const ct =
        typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
          ? { fa: '@', t: 's' }
          : typeof value === 'number' && isTextFormat
            ? { fa: 'General', t: 'n' }
            : undefined
      workbook.setCellValue(row, column, {
        v: value,
        ...(ct ? { ct } : {}),
        [VAR_SOURCE_KEY]: source
      })
    }
  }
  const applySourceRef = useRef(applySource)
  applySourceRef.current = applySource

  // Re-resolves the current sheet's variable cells; other sheets are done when
  // they are activated (a formula cell can only be written on the current one).
  const refresh = (attempt = 0): void => {
    const workbook = workbookRef.current
    if (!workbook || readOnly) return
    if (!getSheetVariablesApi()?.isReady(parentDocRef.current)) {
      if (attempt < 20) refreshTimer.current = setTimeout(() => refresh(attempt + 1), 300)
      return
    }
    const sheet = workbook.getSheet?.()
    const rows = sheet?.data || []
    let changed = false
    rows.forEach((cells, row) => {
      cells?.forEach((cell, column) => {
        const source = cell?.[VAR_SOURCE_KEY]
        if (typeof source !== 'string' || !source) return
        const result = evaluateCellVarInput(source, resolve)
        const signature = JSON.stringify(result)
        const key = `${sheet.id}:${row}:${column}`
        if (applied.current.get(key) === signature) return
        const upToDate =
          result.kind === 'formula'
            ? cell.f === result.formula
            : cell.f == null && (cell.v ?? '') === result.value
        if (upToDate) {
          applied.current.set(key, signature)
          return
        }
        applySourceRef.current(row, column, source)
        changed = true
      })
    })
    if (changed) workbook.calculateFormula?.(sheet.id)
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const scheduleRefresh = (): void => {
    clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => refreshRef.current(), 60)
  }

  const hooks = useMemo<SheetHooks>(
    () => ({
      // Runs inside FortuneSheet's state update, so writes wait until it is
      // done. Delete and "Clear content" empty the whole cell, source included;
      // any other input that has no `@name` replaces the variable.
      beforeUpdateCell: (row, column, value) => {
        if (readOnlyRef.current || typeof value !== 'string') return true
        if (!hasCellVarTokens(value)) {
          const cell = workbookRef.current?.getSheet?.()?.data?.[row]?.[column]
          if (cell?.[VAR_SOURCE_KEY]) {
            setTimeout(() =>
              workbookRef.current?.setCellFormat?.(row, column, VAR_SOURCE_KEY, null)
            )
          }
          return true
        }
        setTimeout(() => applySourceRef.current(row, column, value))
        return false
      },
      afterActivateSheet: () => scheduleRefresh()
    }),
    []
  )

  useEffect(() => {
    if (!ready || readOnly) return
    const api = getSheetVariablesApi()
    void api?.load(parentDocRef.current).then(() => scheduleRefresh())
    const unsubscribe = api?.onChange(() => scheduleRefresh())
    return () => {
      unsubscribe?.()
      clearTimeout(refreshTimer.current)
    }
  }, [ready, readOnly, rootPath])

  // DOM side: dropdown opt-in, showing the source, context-menu item.
  useEffect(() => {
    if (!ready || readOnly) return
    const root = containerRef.current
    const cellInput = root?.querySelector<HTMLElement>('#luckysheet-rich-text-editor')
    const fxInput = root?.querySelector<HTMLElement>('#luckysheet-functionbox-cell')
    const inputBox = root?.querySelector<HTMLElement>('.luckysheet-input-box')
    if (!root || !cellInput || !fxInput || !inputBox) return

    for (const el of [cellInput, fxInput]) {
      el.setAttribute('data-var-allow', 'true')
      el.setAttribute('data-var-input-type', '@name')
    }

    const selectedSource = (): string | null => {
      const workbook = workbookRef.current
      const selection = workbook?.getSelection?.()?.[0]
      if (!selection) return null
      const cell = workbook.getSheet?.()?.data?.[selection.row?.[0]]?.[selection.column?.[0]]
      const source = cell?.[VAR_SOURCE_KEY]
      return typeof source === 'string' && source ? source : null
    }

    let editing = false
    const boxObserver = new MutationObserver(() => {
      const nowEditing = inputBox.style.zIndex === '19'
      if (nowEditing && !editing) {
        const source = selectedSource()
        // Empty when typing over the cell: then the typed text wins.
        if (source && cellInput.innerText.trim() !== '') {
          cellInput.textContent = source
          fxInput.textContent = source
        }
      }
      editing = nowEditing
    })
    boxObserver.observe(inputBox, { attributes: true, attributeFilter: ['style'] })

    const fxObserver = new MutationObserver(() => {
      if (editing || document.activeElement === fxInput) return
      const source = selectedSource()
      if (source && fxInput.innerText !== source) fxInput.textContent = source
    })
    fxObserver.observe(fxInput, { childList: true, characterData: true, subtree: true })

    const menuObserver = new MutationObserver(() => {
      const menu = root.querySelector<HTMLElement>(
        '.fortune-context-menu:not(.fortune-sheet-list):not(.fortune-filter-menu)'
      )
      if (!menu || menu.querySelector('[data-dd-var-item]')) return
      const item = document.createElement('div')
      item.className = 'luckysheet-cols-menuitem luckysheet-mousedown-cancel'
      item.setAttribute('data-dd-var-item', 'true')
      const label = document.createElement('div')
      label.className = 'luckysheet-cols-menuitem-content'
      label.textContent = 'Create variable from cell…'
      item.appendChild(label)
      // Kept from FortuneSheet's own mouse handling, which would read the
      // click as a click on the grid.
      for (const type of ['mousedown', 'mouseup']) {
        item.addEventListener(type, (event) => {
          event.preventDefault()
          event.stopPropagation()
        })
      }
      item.addEventListener('click', (event) => {
        event.stopPropagation()
        const workbook = workbookRef.current
        const selection = workbook?.getSelection?.()?.[0]
        if (!selection) return
        const row = selection.row?.[0]
        const column = selection.column?.[0]
        const rect = menu.getBoundingClientRect()
        // Closes the menu the way a click beside it does. The click lands on
        // the selected cell (where the input box sits), so the grid, which
        // also sees it, keeps that selection.
        const cellRect = inputBox.getBoundingClientRect()
        root.querySelector('.fortune-popover-backdrop')?.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            clientX: cellRect.left + 2,
            clientY: cellRect.top + 2
          })
        )
        openForm.current({
          row,
          column,
          cellRef: toA1(row, column),
          sheetName: workbook.getSheet?.()?.name || '',
          x: rect.left,
          y: rect.top
        })
      })
      menu.appendChild(item)
    })
    menuObserver.observe(root, { childList: true, subtree: true })

    return () => {
      boxObserver.disconnect()
      fxObserver.disconnect()
      menuObserver.disconnect()
    }
  }, [ready, readOnly, rootPath])

  const createVariable = (form: CreateForm, name: string, visibility: string): string | null => {
    const api = getSheetVariablesApi()
    if (!api) return 'Variables are not available here.'
    if (!isCellVarName(name)) {
      return 'Use letters, digits and _ only, not starting with a digit.'
    }
    if (api.exists(name, parentDocRef.current)) return `Variable "${name}" already exists.`
    const value = workbookRef.current?.getCellValue?.(form.row, form.column)
    const id = api.defineFromCell(
      name,
      {
        source: { path: rootPath, sheet: form.sheetName, cell: form.cellRef },
        visibility,
        value: value ?? ''
      },
      parentDocRef.current
    )
    if (!id) return 'No document is open for this spreadsheet.'
    return null
  }
  const createRef = useRef(createVariable)
  createRef.current = createVariable

  // Back to the grid, so typing goes to a cell again.
  const focusGrid = (): void =>
    containerRef.current?.querySelector<HTMLElement>('#luckysheet-rich-text-editor')?.focus()

  const overlay = (
    <CreateVariableHost openRef={openForm} createRef={createRef} onClose={focusGrid} />
  )

  return { hooks, overlay }
}

function CreateVariableHost({
  openRef,
  createRef,
  onClose
}: {
  openRef: React.MutableRefObject<(form: CreateForm) => void>
  createRef: React.MutableRefObject<
    (form: CreateForm, name: string, visibility: string) => string | null
  >
  onClose: () => void
}): React.ReactElement | null {
  const [form, setForm] = useState<CreateForm | null>(null)
  openRef.current = setForm
  if (!form) return null
  const close = (): void => {
    setForm(null)
    onClose()
  }
  return (
    <CreateVariableForm
      form={form}
      onCancel={close}
      onCreate={(name, visibility) => {
        const error = createRef.current(form, name, visibility)
        if (!error) close()
        return error
      }}
    />
  )
}

function CreateVariableForm({
  form,
  onCancel,
  onCreate
}: {
  form: CreateForm
  onCancel: () => void
  onCreate: (name: string, visibility: string) => string | null
}): React.ReactElement {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState('package')
  const [error, setError] = useState('')
  const submit = (): void => setError(onCreate(name.trim(), visibility) || '')
  const field: React.CSSProperties = {
    width: '100%',
    padding: '3px 6px',
    fontSize: 11,
    background: 'var(--color-base-100, #1e1e1e)',
    color: 'inherit',
    border: '1px solid var(--color-base-200, #444)',
    borderRadius: 2
  }
  return (
    <div
      className="dd-sheet-var-form"
      style={{
        position: 'fixed',
        left: form.x,
        top: form.y,
        zIndex: 10000,
        width: 240,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
        background: 'var(--color-base-300, #2a2a2a)',
        color: 'var(--color-base-content, #ddd)',
        border: '1px solid var(--color-base-100, #444)',
        borderRadius: 3,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') onCancel()
      }}
    >
      <div style={{ opacity: 0.7 }}>
        Variable from {form.sheetName ? `${form.sheetName}!` : ''}
        {form.cellRef}
      </div>
      <input
        autoFocus
        style={field}
        placeholder="Variable name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select style={field} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
        <option value="document">Document</option>
        <option value="package">Package</option>
        <option value="desktop">Desktop</option>
        <option value="cloud">Cloud</option>
      </select>
      {error ? <div style={{ color: '#f87171' }}>{error}</div> : null}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" style={{ ...field, width: 'auto' }} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" style={{ ...field, width: 'auto' }} onClick={submit}>
          Create
        </button>
      </div>
    </div>
  )
}
