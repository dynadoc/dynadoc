import { mount, unmount } from 'svelte'
import { computePosition, offset, flip, shift, size } from '@floating-ui/dom'
import { get } from 'svelte/store'
import CustomVarExtensionDropdown from '../components/CustomVarExtensionDropdown.svelte'
import { listVariables } from '../stores/variableManipulator'
import { _$_documentEditorsList } from '../../../../stores/editor.store'
import { buildVarDropdownItems } from './variableDropdown.utils'
import { formatVariableInsertText } from './variableInsert.utils'
import {
  cellVarNameError,
  findVarTrigger,
  isCellVarName,
  queryReplaceRange
} from './sheetVariables.utils'
import { isCompactViewport } from './variableMenu.utils'

type DropdownItem = {
  name: string
  value?: any
  type?: string
  aliases?: string[]
  rawValue?: any
  displayValue?: string
}

type DropdownState = {
  items: DropdownItem[]
  query: string
  position: { x: number; y: number } | null
  selectItem: (item: DropdownItem) => void
  onAddVariable: (variable: { name: string }) => void
  onClose: () => void
  refocusField: () => void
  onActiveChange: (optionId: string | null) => void
  listboxId: string
  validateName: ((name: string) => string | null) | null
}

type AllowedElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement

const TRIGGER_CHAR = '@'
const ALLOW_ATTR = 'data-var-allow'
const INPUT_TYPE_ATTR = 'data-var-input-type'

function isAllowedElement(target: EventTarget | null): AllowedElement | null {
  if (!(target instanceof HTMLElement)) return null
  const el = target.closest<HTMLElement>(`[${ALLOW_ATTR}="true"]`)
  if (!el) return null
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el
  if (el.isContentEditable) return el
  return null
}

function getInsertionTemplate(el: AllowedElement | null): string {
  if (!el) return 'value'
  const template = el.getAttribute(INPUT_TYPE_ATTR)
  if (!template) return 'value'
  return template.trim()
}

function getActiveDoc() {
  return get(_$_documentEditorsList.getActive())
}

// `@name` inserts are parsed as cell tokens (spreadsheet cells): only names
// that grammar can read are offered there.
const insertsCellToken = (template: string): boolean => template === '@name'

function buildItems(query: string, template: string): DropdownItem[] {
  const activeDoc = getActiveDoc()
  if (!activeDoc) return []
  const items = buildVarDropdownItems(listVariables([], activeDoc), query)
  return insertsCellToken(template) ? items.filter((item) => isCellVarName(item.name)) : items
}

function getInputTextBeforeCaret(el: HTMLInputElement | HTMLTextAreaElement) {
  const caret = el.selectionStart ?? 0
  return { text: el.value.slice(0, caret), caret }
}

function getContentEditableTextBeforeCaret(el: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return { text: '', caret: 0 }
  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer)) return { text: '', caret: 0 }
  const clone = range.cloneRange()
  clone.selectNodeContents(el)
  clone.setEnd(range.startContainer, range.startOffset)
  const text = clone.toString()
  return { text, caret: text.length }
}

// `@` may follow an operator (`=B2*@taux`) but not a word (`a@b.com`).
const findTrigger = (textBefore: string, template: string) =>
  findVarTrigger(textBefore, insertsCellToken(template))

function replaceInputRange(
  el: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  insertText: string
) {
  const value = el.value
  const next = value.slice(0, start) + insertText + value.slice(end)
  el.value = next
  const caretPos = start + insertText.length
  el.setSelectionRange(caretPos, caretPos)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function getTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

function rangeFromCharacterOffsets(root: HTMLElement, start: number, end: number) {
  const nodes = getTextNodes(root)
  let current = 0
  const range = document.createRange()
  let startSet = false

  for (const node of nodes) {
    const len = node.nodeValue?.length || 0
    const next = current + len

    if (!startSet && start <= next) {
      range.setStart(node, Math.max(0, start - current))
      startSet = true
    }
    if (startSet && end <= next) {
      range.setEnd(node, Math.max(0, end - current))
      return range
    }
    current = next
  }
  return null
}

function replaceContentEditableRange(
  el: HTMLElement,
  start: number,
  end: number,
  insertText: string
) {
  const range = rangeFromCharacterOffsets(el, start, end)
  if (!range) return
  const selection = window.getSelection()
  // Inserted as typing would be: into the existing text node, caret after it.
  // Editors that track the caret by node (the spreadsheet cell editor) keep
  // their place; a separate text node left the next keystroke misplaced.
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (document.execCommand?.('insertText', false, insertText)) return
  range.deleteContents()
  range.insertNode(document.createTextNode(insertText))
  if (selection) {
    selection.removeAllRanges()
    const caret = document.createRange()
    caret.setStart(range.endContainer, range.endOffset)
    caret.collapse(true)
    selection.addRange(caret)
  }
}

function getCaretRect(el: AllowedElement) {
  const box = el.getBoundingClientRect()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return { x: box.left, y: box.bottom }
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  // Only while the caret is in the field: once the dropdown's own fields have
  // focus, the selection is theirs and the field's box is the anchor.
  if (!el.contains(range.startContainer)) return { x: box.left, y: box.bottom }
  const rect = range.getBoundingClientRect()
  // A collapsed range in an empty line has an empty rect.
  if (!rect || (!rect.width && !rect.height && !rect.x && !rect.y)) {
    return { x: box.left, y: box.bottom }
  }
  return { x: rect.left, y: rect.bottom }
}

// What is visible of the window: on a phone, the part above the on-screen
// keyboard (`visualViewport`), not the whole layout viewport.
function getVisibleBoundary() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return 'viewport' as const
  return { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height }
}

// A phone or a narrow window: the menu is a bottom sheet it places itself.
const isCompactScreen = (): boolean =>
  typeof window !== 'undefined' &&
  isCompactViewport(window.innerWidth, window.matchMedia?.('(pointer: coarse)').matches ?? false)

const LISTBOX_ID = 'dd-var-listbox-sheet'

const isInputField = (el: AllowedElement): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

export function initGlobalVarDropdown() {
  let activeElement: AllowedElement | null = null
  let triggerIndex = 0
  // Where the `@query` ends, kept for when the field no longer has focus
  // (the user went to the dropdown's own name or value field).
  let queryEnd = 0
  // The last pointer press was in the dropdown: a tap there may leave focus
  // on <body> (WebKit does not focus buttons), which is not "leaving".
  let pointerInDropdown = false
  let isOpen = false
  let container: HTMLElement | null = null
  let component: any = null
  // $state: the mounted dropdown re-renders when these change (a plain object
  // left it hidden, its position never reaching the component).
  const state: DropdownState = $state({
    items: [],
    query: '',
    position: null,
    selectItem: () => undefined,
    onAddVariable: () => undefined,
    onClose: () => undefined,
    refocusField: () => undefined,
    onActiveChange: () => undefined,
    listboxId: LISTBOX_ID,
    validateName: null
  })

  // The field announces the list and its highlighted row (the caret stays in
  // the field, so the list is followed through aria-activedescendant). The
  // menu says which row that is: it moves the highlight itself.
  const ARIA_ATTRS = ['aria-controls', 'aria-expanded', 'aria-activedescendant']
  let activeOptionId: string | null = null
  const syncAria = () => {
    if (!activeElement) return
    activeElement.setAttribute('aria-controls', LISTBOX_ID)
    activeElement.setAttribute('aria-expanded', 'true')
    if (activeOptionId) activeElement.setAttribute('aria-activedescendant', activeOptionId)
    else activeElement.removeAttribute('aria-activedescendant')
  }

  const updatePosition = async () => {
    if (!isOpen || !activeElement || !container) return
    // The bottom sheet sits above the keyboard on its own.
    if (isCompactScreen()) {
      const floating = container.firstElementChild as HTMLElement | null
      floating?.style.removeProperty('max-width')
      floating?.style.removeProperty('max-height')
      state.position = { x: 0, y: 0 }
      return
    }
    const caretRect = getCaretRect(activeElement)
    if (!caretRect) return
    const virtualEl = {
      getBoundingClientRect: () => ({
        x: caretRect.x,
        y: caretRect.y,
        top: caretRect.y,
        bottom: caretRect.y,
        left: caretRect.x,
        right: caretRect.x,
        width: 0,
        height: 0
      })
    }
    const rootBoundary = getVisibleBoundary()
    const { x, y } = await computePosition(virtualEl, container.firstElementChild || container, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [
        offset(8),
        flip({ rootBoundary, padding: 8 }),
        shift({ rootBoundary, padding: 12 }),
        // Kept inside what is visible (small screens, on-screen keyboard):
        // the dropdown scrolls rather than running off the screen.
        size({
          rootBoundary,
          padding: 8,
          apply({ availableWidth, availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              // Never more than what is visible, however little: it scrolls.
              maxWidth: `${Math.max(0, availableWidth)}px`,
              maxHeight: `${Math.max(0, availableHeight)}px`,
              overflowY: 'auto'
            })
          }
        })
      ]
    })
    if (!isOpen) return
    state.position = { x, y }
  }

  const closeDropdown = () => {
    ARIA_ATTRS.forEach((name) => activeElement?.removeAttribute(name))
    if (component) unmount(component)
    component = null
    container?.remove()
    container = null
    isOpen = false
    activeElement = null
    activeOptionId = null
    pointerInDropdown = false
  }

  const fieldHasFocus = (el: AllowedElement) => {
    const focused = document.activeElement
    return !!focused && (focused === el || el.contains(focused))
  }

  // Puts `item` in place of the `@query`, at the caret, and closes.
  const insertItem = (item: DropdownItem) => {
    const el = activeElement
    if (!el) return
    const insertText = formatVariableInsertText(item, getInsertionTemplate(el))
    // The caret may have left the field (for the dropdown's own fields) or
    // moved in it (a click at the start of the cell): the field gets it back,
    // and what is replaced is the `@query` as last typed, not up to the caret.
    if (!fieldHasFocus(el)) el.focus({ preventScroll: true })
    if (isInputField(el)) {
      const { start, end } = queryReplaceRange(triggerIndex, queryEnd, el.value.length)
      replaceInputRange(el, start, end, insertText)
    } else {
      const length = getTextNodes(el).reduce((sum, node) => sum + (node.nodeValue?.length || 0), 0)
      const { start, end } = queryReplaceRange(triggerIndex, queryEnd, length)
      replaceContentEditableRange(el, start, end, insertText)
    }
    closeDropdown()
  }

  // A variable created from the dropdown is inserted like a picked one, so
  // what was typed around the `@query` stays. A name the field cannot take
  // (the cell grammar is stricter) only refreshes the list.
  const handleAddVariable = (variable: { name: string }) => {
    const el = activeElement
    if (!el || !variable?.name) return
    const template = getInsertionTemplate(el)
    const created = buildItems('', template).find((item) => item.name === variable.name)
    if (created) {
      insertItem(created)
      return
    }
    state.items = buildItems(state.query, template)
    el.focus({ preventScroll: true })
  }

  const refocusField = () => activeElement?.focus({ preventScroll: true })

  const handleActiveChange = (optionId: string | null) => {
    activeOptionId = optionId
    syncAria()
  }

  const openDropdown = (items: DropdownItem[], query: string) => {
    if (!container) {
      container = document.createElement('span')
      document.body.appendChild(container)
    }

    state.items = items
    state.query = query
    state.selectItem = insertItem
    state.onAddVariable = handleAddVariable
    state.onClose = () => {
      const el = activeElement
      closeDropdown()
      el?.focus({ preventScroll: true })
    }
    state.refocusField = refocusField
    state.onActiveChange = handleActiveChange
    // A cell reads only `@letters_digits`: say so before creating anything.
    state.validateName =
      activeElement && insertsCellToken(getInsertionTemplate(activeElement))
        ? cellVarNameError
        : null

    if (!component) {
      component = mount(CustomVarExtensionDropdown, {
        target: container,
        props: state
      })
    }
    isOpen = true
    syncAria()
    void updatePosition()
  }

  const updateDropdown = (items: DropdownItem[], query: string) => {
    if (!isOpen) {
      openDropdown(items, query)
      return
    }
    state.items = items
    state.query = query
    syncAria()
    void updatePosition()
  }

  const handleInput = (event: Event) => {
    // Typing in the dropdown's own fields (name, value...) is not typing in
    // the field the dropdown belongs to: it must neither close nor move it.
    const target = event.target as Node | null
    if (isOpen && target && container?.contains(target)) return
    const el = isAllowedElement(event.target)
    if (!el) {
      closeDropdown()
      return
    }

    // Another field: the first one's dropdown (and its aria state) goes.
    if (isOpen && activeElement && activeElement !== el) closeDropdown()
    activeElement = el
    const before = isInputField(el)
      ? getInputTextBeforeCaret(el)
      : getContentEditableTextBeforeCaret(el)
    const textBefore = before.text

    const template = getInsertionTemplate(el)
    const trigger = findTrigger(textBefore, template)
    if (!trigger) {
      closeDropdown()
      return
    }

    triggerIndex = trigger.atIndex
    queryEnd = before.caret
    const items = buildItems(trigger.query, template)
    updateDropdown(items, trigger.query)
  }

  // The menu moves its highlight, picks or creates (handleKey); what it does
  // not use stays the field's. Escape closes; Enter or Tab with nothing to
  // pick closes too and still reaches the field (it commits the cell).
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isOpen) return
    const target = event.target as Node | null
    if (target && container?.contains(target)) {
      if (component?.handleKey?.(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Escape in the menu's own fields: back to the field, closed.
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        const el = activeElement
        closeDropdown()
        el?.focus({ preventScroll: true })
      }
      return
    }
    if (event.isComposing) return
    const el = isAllowedElement(event.target)
    if (!el || el !== activeElement) return

    if (component?.handleKey?.(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      closeDropdown()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeDropdown()
    }
  }

  const handlePointerDown = (event: Event) => {
    if (!isOpen) return
    const target = event.target as Node | null
    if (!target) return
    pointerInDropdown = !!container?.contains(target)
    if (pointerInDropdown) return
    if (activeElement?.contains(target)) return
    closeDropdown()
  }

  // Focus leaving the field closes the dropdown, unless it went to the
  // dropdown (its name or value field) or back to the field. Checked once the
  // focus change is over: `relatedTarget` is null for a tap on a button in
  // WebKit and while the field re-renders, which is not leaving.
  let focusCheck: ReturnType<typeof setTimeout> | undefined
  const handleFocusOut = (event: FocusEvent) => {
    if (!isOpen) return
    const related = event.relatedTarget as Node | null
    if (related && container?.contains(related)) return
    clearTimeout(focusCheck)
    focusCheck = setTimeout(() => {
      if (!isOpen || !activeElement) return
      const focused = document.activeElement
      if (focused && container?.contains(focused)) return
      if (fieldHasFocus(activeElement)) return
      if (pointerInDropdown && (!focused || focused === document.body)) return
      closeDropdown()
    })
  }

  document.addEventListener('input', handleInput, true)
  document.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('pointerdown', handlePointerDown, true)
  document.addEventListener('focusout', handleFocusOut, true)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
  // On-screen keyboard opening or closing.
  window.visualViewport?.addEventListener('resize', updatePosition)
  window.visualViewport?.addEventListener('scroll', updatePosition)

  return () => {
    clearTimeout(focusCheck)
    window.visualViewport?.removeEventListener('resize', updatePosition)
    window.visualViewport?.removeEventListener('scroll', updatePosition)
    document.removeEventListener('input', handleInput, true)
    document.removeEventListener('keydown', handleKeyDown, true)
    document.removeEventListener('pointerdown', handlePointerDown, true)
    document.removeEventListener('focusout', handleFocusOut, true)
    window.removeEventListener('resize', updatePosition)
    window.removeEventListener('scroll', updatePosition, true)
    closeDropdown()
  }
}
