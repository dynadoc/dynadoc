<script module lang="ts">
  let nextListboxId = 0

  // The last variables inserted from here, kept while the app runs (the menu
  // is mounted again each time `@` is typed).
  let recentHistory: { name: string; type?: string }[] = []
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { _$_documentEditorsList } from '../../../../stores/editor.store'
  import {
    listVariables,
    defineVariable,
    setVariable,
    renameVariable,
    listSpreadsheetPointers,
    VariableManipulatorUtils,
    type Variable
  } from '../stores/variableManipulator'
  import {
    buildVariablePayload,
    requiresValue,
    normalizeVariableName,
    isNameTaken
  } from '../utils/variableForm.utils'
  import { displayVariableValue } from '../utils/sheetVariables.utils'
  import {
    canCreateVariable,
    isCompactViewport,
    keyboardInset,
    moveActiveRow,
    scopeVisibility,
    splitMatch,
    variableScope
  } from '../utils/variableMenu.utils'
  import { formatSpreadsheetRefName } from '../utils/utils'
  import { nodeApi } from '../../../../utils/shims/node'

  // The `@` variable menu. What is typed stays in the field (document,
  // spreadsheet cell...): the host passes the `@query` and the variables that
  // answer it, best first, and forwards the field's keys to `handleKey`.
  // Each row is `@name`, its value and its scope; the last rows create
  // `@query` (or edit a variable) in a compact form, and insert a spreadsheet
  // cell reference. On a phone or a narrow window it is a bottom sheet.
  let {
    items = [],
    // Followed when the host moves it; the menu moves it itself in handleKey.
    activeIndex = 0,
    query = '',
    position = { x: 0, y: 0 },
    selectItem = () => {},
    // Called with the variable created or updated, for the host to insert it.
    onAddVariable = null,
    handleEditRichText = () => {},
    // A name the field can take, checked before anything is created: the
    // message, or null. A spreadsheet cell only reads `@letters_digits`.
    validateName = null,
    // Closes the menu (the bottom sheet's close button).
    onClose = null,
    // Gives the caret back to the field, after the menu's own fields.
    refocusField = null,
    // The id of the highlighted row, for the field's aria-activedescendant.
    onActiveChange = null,
    // The list's id, for a field that points at it (aria-controls).
    listboxId = `dd-var-listbox-${++nextListboxId}`
  } = $props()

  const optionId = (index: number): string => `${listboxId}-option-${index}`
  const VAR_TYPE = VariableManipulatorUtils.VAR_TYPE
  const GENERAL = VariableManipulatorUtils.EXCEL_FORMATS.GENERAL

  type Mode = 'list' | 'form' | 'sheetRef'
  // A listed variable (a row) or one of the document's: what the menu reads.
  type MenuVariable = {
    name?: string
    displayName?: string
    value?: unknown
    displayValue?: string
    type?: string
    source?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store's own type
    rawValue?: any
  }
  type DialogApi = {
    openDialogFile?: () => Promise<string | null>
    openDialogDirectory?: () => Promise<string | null>
  }
  let mode = $state<Mode>('list')
  // Follows the host when it moves the highlight (hosts that handle the keys
  // themselves); the menu moves it itself in handleKey.
  let active = $derived(activeIndex)
  let listEl = $state<HTMLElement>()
  let nameInput = $state<HTMLInputElement>()
  let valueInput = $state<HTMLInputElement>()
  let sheetRefSelect = $state<HTMLSelectElement>()

  const activeDocStore = _$_documentEditorsList.getActive()
  let activeDoc = $derived($activeDocStore)

  // ── Rows: the variables, then "Create", then "From a spreadsheet cell" ──
  let spreadsheetPointers = $derived(listSpreadsheetPointers(activeDoc))
  let typedName = $derived(normalizeVariableName(String(query || '')))
  let showCreate = $derived(!typedName || canCreateVariable(typedName, items))
  let showSheetRef = $derived(spreadsheetPointers.length > 0)
  let createIndex = $derived(showCreate ? items.length : -1)
  let sheetRefIndex = $derived(showSheetRef ? items.length + (showCreate ? 1 : 0) : -1)
  let rowCount = $derived(items.length + (showCreate ? 1 : 0) + (showSheetRef ? 1 : 0))
  let recent = $state(recentHistory)
  // Only those this field lists (another document's variables, or a name a
  // cell cannot read, are not offered here).
  let recentShown = $derived(recent.filter((hist) => items.some((i) => i.name === hist.name)))

  // ── The form: create a variable, or edit one ──
  let newVarName = $state('')
  let newVarValue = $state('')
  let newVarFormat = $state(GENERAL)
  let newVarAutoUpdate = $state(false)
  let selectedType = $state<string>(VAR_TYPE.text)
  let valueDirty = $state(false)
  let nameError = $state('')
  let editingOriginalName = $state<string | null>(null)
  let showAdvanced = $state(false)
  let advAliases = $state('')
  let advDescription = $state('')
  let advVisibility = $state('package')
  let advAccess = $state('')
  let advRead = $state('')
  let advWrite = $state('')

  // Typing more starts over on the best match, in the list.
  let lastQuery: string | null = null
  $effect(() => {
    const next = String(query || '')
    if (next === lastQuery) return
    lastQuery = next
    active = 0
  })

  $effect(() => {
    if (active >= rowCount) active = Math.max(0, rowCount - 1)
  })

  $effect(() => {
    const id = mode === 'list' && rowCount ? optionId(active) : null
    onActiveChange?.(id)
    if (!id || !listEl) return
    listEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' })
  })

  // ── Compact screens: a bottom sheet above the on-screen keyboard ──
  let compact = $state(false)
  let bottomInset = $state(0)
  let visibleHeight = $state(0)
  const measure = (): void => {
    if (typeof window === 'undefined') return
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
    compact = isCompactViewport(window.innerWidth, coarse)
    const vv = window.visualViewport
    bottomInset = keyboardInset(window.innerHeight, vv)
    visibleHeight = vv?.height ?? window.innerHeight
  }
  measure()
  onMount(() => {
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  })

  // The handle drags the sheet down; far enough closes it.
  let dragStart: number | null = null
  let dragOffset = $state(0)
  const onHandleDown = (event: PointerEvent): void => {
    dragStart = event.clientY
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  const onHandleMove = (event: PointerEvent): void => {
    if (dragStart === null) return
    dragOffset = Math.max(0, event.clientY - dragStart)
  }
  const onHandleUp = (): void => {
    if (dragStart === null) return
    const close = dragOffset > 80
    dragStart = null
    dragOffset = 0
    if (close) onClose?.()
  }

  const TYPE_TABS = [
    { type: VAR_TYPE.text, icon: 'ph-text-t', label: 'Text' },
    { type: VAR_TYPE.ai, icon: 'ph-sparkle', label: 'AI' },
    { type: VAR_TYPE.file, icon: 'ph-file-plus', label: 'File' },
    { type: VAR_TYPE.folder, icon: 'ph-folder-plus', label: 'Folder' },
    { type: VAR_TYPE.richtext, icon: 'ph-article', label: 'Rich Text' }
  ]

  const listToInput = (value?: string[] | null): string =>
    Array.isArray(value) ? value.filter(Boolean).join(', ') : ''
  const parseListInput = (value: string): string[] =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  const parsePermissionInput = (value: string): string[] | null => {
    const trimmed = value.trim()
    if (!trimmed) return null
    return parseListInput(trimmed)
  }

  const displayNameOf = (v: MenuVariable | null | undefined): string => {
    const base = v?.rawValue?.name || v?.name || ''
    if (v?.rawValue?.type !== VAR_TYPE.spreadsheet) return base
    const stripped = formatSpreadsheetRefName(base)
    return stripped || base
  }

  const findVariable = (name: string): Variable | null => {
    if (!activeDoc || !name) return null
    const needle = name.toLowerCase()
    return (
      listVariables([], activeDoc).find((v) => displayNameOf(v).toLowerCase() === needle) || null
    )
  }

  function resetForm(): void {
    newVarName = ''
    newVarValue = ''
    newVarFormat = GENERAL
    newVarAutoUpdate = false
    selectedType = VAR_TYPE.text
    valueDirty = false
    nameError = ''
    editingOriginalName = null
    showAdvanced = false
    advAliases = ''
    advDescription = ''
    advVisibility = 'package'
    advAccess = ''
    advRead = ''
    advWrite = ''
  }

  // Fills the form from an existing variable: what Update then changes.
  function loadVariable(match: MenuVariable): void {
    editingOriginalName = match.name
    const raw = match.rawValue || {}
    const type = raw.type || VAR_TYPE.text
    selectedType = type
    newVarFormat = raw.format || GENERAL
    newVarAutoUpdate = Boolean(raw.autoUpdate)
    if (type === VAR_TYPE.ai) newVarValue = raw.prompt || ''
    else if (type === VAR_TYPE.file || type === VAR_TYPE.folder) newVarValue = raw.url || ''
    else newVarValue = String(raw.value ?? match.value ?? '')
    advAliases = listToInput(raw.aliases)
    advDescription = raw.description || ''
    advVisibility = raw.visibility || 'package'
    advAccess = listToInput(raw.permissions?.access)
    advRead = listToInput(raw.permissions?.read)
    advWrite = listToInput(raw.permissions?.write)
    valueDirty = false
  }

  async function openForm(existing: MenuVariable | null = null): Promise<void> {
    resetForm()
    if (existing) {
      const match = findVariable(displayNameOf(existing)) || existing
      newVarName = displayNameOf(match)
      loadVariable(match)
    } else {
      newVarName = typedName
      nameError = (newVarName && validateName?.(newVarName)) || ''
    }
    mode = 'form'
    await tick()
    const target = newVarName ? valueInput || nameInput : nameInput
    target?.focus({ preventScroll: true })
  }

  // A name typed in the form that is an existing variable's edits it, as
  // long as nothing else was typed yet.
  function onNameInput(): void {
    nameError = ''
    if (editingOriginalName || valueDirty) return
    const match = findVariable(normalizeVariableName(newVarName))
    if (match) loadVariable(match)
  }

  function backToList(): void {
    mode = 'list'
    nameError = ''
    refocusField?.()
  }

  async function handlePick(kind: 'file' | 'folder'): Promise<void> {
    const api = (window as unknown as { api?: DialogApi }).api
    const result =
      kind === 'file' ? await api?.openDialogFile?.() : await api?.openDialogDirectory?.()
    if (!result) return
    newVarValue = result
    selectedType = kind === 'file' ? VAR_TYPE.file : VAR_TYPE.folder
    valueDirty = true
  }

  function addToHistory(variable: { name: string; type?: string }): void {
    recentHistory = [variable, ...recentHistory.filter((h) => h.name !== variable.name)].slice(0, 3)
    recent = recentHistory
  }

  function submitForm(): void {
    const name = normalizeVariableName(newVarName)
    const input = String(newVarValue || '').trim()
    if (!name) {
      nameError = $_('Please enter a variable name.')
      nameInput?.focus({ preventScroll: true })
      return
    }
    const invalid = validateName?.(name)
    if (invalid) {
      nameError = invalid
      return
    }
    if (!activeDoc) return
    const vars = listVariables([], activeDoc)
    const existingVar = editingOriginalName
      ? vars.find((v) => v.name === editingOriginalName)
      : null
    const currentName = existingVar ? displayNameOf(existingVar) : ''
    const isRename = Boolean(existingVar && currentName && currentName !== name)
    if (isNameTaken(name, vars) && (!existingVar || isRename)) {
      nameError = $_('Variable "{name}" already exists.', { values: { name } })
      return
    }
    if (requiresValue(selectedType) && !input) {
      nameError = $_('Enter a value.')
      valueInput?.focus({ preventScroll: true })
      return
    }

    const payload = buildVariablePayload(
      selectedType,
      input,
      existingVar?.rawValue,
      newVarFormat,
      newVarAutoUpdate
    )
    const advancedPayload = {
      name,
      aliases: parseListInput(advAliases),
      description: advDescription?.trim() || undefined,
      visibility: advVisibility || undefined,
      permissions: {
        access: parsePermissionInput(advAccess),
        read: parsePermissionInput(advRead),
        write: parsePermissionInput(advWrite)
      }
    }
    if (existingVar) {
      if (isRename) renameVariable(existingVar.name, name, activeDoc)
      setVariable(existingVar.name, { ...payload, ...advancedPayload }, activeDoc)
    } else {
      defineVariable(name, { ...payload, ...advancedPayload }, true, activeDoc)
    }

    const type = selectedType
    addToHistory({ name, type })
    resetForm()
    mode = 'list'
    onAddVariable?.({ name, type, value: input })
  }

  function activate(index: number): void {
    if (index < items.length) {
      addToHistory({ name: items[index].name, type: items[index].type })
      selectItem(items[index])
      return
    }
    if (index === createIndex) {
      void openForm()
      return
    }
    if (index === sheetRefIndex) void openSheetRef()
  }

  // The cell view takes the keyboard: what is typed next is its cell.
  async function openSheetRef(): Promise<void> {
    mode = 'sheetRef'
    await tick()
    sheetRefSelect?.focus({ preventScroll: true })
  }

  /**
   * A key pressed in the field (or in the menu): true when the menu used it,
   * and the field must not. Escape is the host's (it closes), except in the
   * form or the cell view, where it goes back to the list.
   */
  export function handleKey(key: string): boolean {
    if (mode !== 'list') {
      if (key !== 'Escape') return false
      backToList()
      return true
    }
    if (!rowCount) return false
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      active = moveActiveRow(active, key === 'ArrowDown' ? 1 : -1, rowCount)
      return true
    }
    if (key === 'Enter' || key === 'Tab') {
      activate(active)
      return true
    }
    return false
  }

  // ── Spreadsheet cell reference ──
  let sheetRefId = $state('')
  let sheetRefName = $state('')
  let sheetCellRef = $state('A1')
  let sheetUseName = $state(true)

  $effect(() => {
    if (!spreadsheetPointers.length || sheetRefId) return
    sheetRefId = spreadsheetPointers[0].id
    sheetRefName = spreadsheetPointers[0].name || 'Sheet1'
  })

  const getWorkbookLabel = (path?: string): string => {
    if (!path) return ''
    try {
      const ext = nodeApi?.path?.extname?.(path) || ''
      return nodeApi?.path?.basename?.(path, ext) || path
    } catch {
      return path
    }
  }

  const getSpreadsheetPointerLabel = (pointer: {
    id?: string
    name?: string
    path?: string
  }): string => {
    const sheetLabel = pointer?.name || pointer?.id
    const workbookLabel = getWorkbookLabel(pointer?.path)
    return workbookLabel ? `${sheetLabel} • ${workbookLabel}` : sheetLabel
  }

  function buildSpreadsheetReference(): string {
    if (!sheetRefId || !sheetCellRef) return ''
    const cleanCell = sheetCellRef.trim().toUpperCase()
    if (sheetUseName && sheetRefName) return `${sheetRefId}!${sheetRefName}!${cleanCell}`
    return `${sheetRefId}!${cleanCell}`
  }

  function insertSpreadsheetReference(): void {
    const ref = buildSpreadsheetReference()
    if (!ref) return
    selectItem?.({ name: ref, value: ref })
  }

  // ── Display ──
  const TYPE_ICONS: Record<string, string> = {
    text: 'ph-text-t',
    ai: 'ph-sparkle',
    file: 'ph-file',
    folder: 'ph-folder',
    richtext: 'ph-article',
    datetime: 'ph-calendar-blank',
    spreadsheet: 'ph-table'
  }

  const itemName = (item: MenuVariable): string => {
    const name = String(item?.displayName || item?.name || '')
    const stripped = formatSpreadsheetRefName(name)
    return stripped || name
  }

  const itemValue = (item: MenuVariable): string => {
    const value = displayVariableValue(item?.displayValue ?? item?.value)
    if (value === null || value === undefined) return ''
    return typeof value === 'object'
      ? String((value as { value?: unknown }).value ?? '')
      : String(value)
  }

  const isAiItem = (item: MenuVariable): boolean =>
    (item?.rawValue?.source || item?.source) === 'ai'

  // A recent entry inserts the variable as listed now (value included).
  const pickRecent = (hist: { name: string; type?: string }): void => {
    const item = items.find((i) => i.name === hist.name)
    if (!item) return
    addToHistory(hist)
    selectItem(item)
  }

  // Picked on mousedown, so the field keeps its caret; on click too when the
  // click comes from the keyboard (Enter or Space on the row).
  const pickOnMouseDown = (index: number) => (event: MouseEvent) => {
    event.preventDefault()
    activate(index)
  }
  const pickOnKeyboardClick = (index: number) => (event: MouseEvent) => {
    if (event.detail === 0) activate(index)
  }

  const isDocScope = (): boolean => variableScope({ visibility: advVisibility }) === 'doc'

  let sheetStyle = $derived(
    compact
      ? `bottom:${bottomInset}px;max-height:${Math.max(160, Math.round(visibleHeight * 0.75))}px;transform:translateY(${dragOffset}px)`
      : ''
  )
</script>

<div
  class="var-menu"
  class:var-menu--sheet={compact}
  style:left={compact ? null : `${position?.x ?? 0}px`}
  style:top={compact ? null : `${position?.y ?? 0}px`}
  style:visibility={compact || position?.x ? 'visible' : 'hidden'}
  style={sheetStyle}
  role="dialog"
  tabindex="-1"
  aria-label={$_('Insert a variable')}
  onkeydown={(e) => {
    // Escape in the form or the cell view: back to the list.
    if (e.key === 'Escape' && mode !== 'list') {
      e.preventDefault()
      e.stopPropagation()
      backToList()
    }
  }}
>
  {#if compact}
    <div
      class="var-menu__handle"
      role="presentation"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleUp}
    >
      <span></span>
    </div>
    <div class="var-menu__header">
      <div class="var-menu__title">{$_('Insert a variable')}</div>
      {#if onClose}
        <button
          type="button"
          class="var-menu__close"
          aria-label={$_('Close')}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => onClose?.()}
        >
          <i class="ph-light ph-x"></i>
        </button>
      {/if}
    </div>
    {#if mode === 'list'}
      <div class="var-menu__filter">{$_('Filter: @{query}', { values: { query } })}</div>
    {/if}
  {/if}

  {#if mode === 'list'}
    <div
      bind:this={listEl}
      id={listboxId}
      class="var-menu__list"
      role="listbox"
      tabindex="-1"
      aria-label={$_('Variables')}
      aria-activedescendant={rowCount ? optionId(active) : undefined}
    >
      {#each items as item, i (item.id ?? item.name ?? i)}
        {@const parts = splitMatch(itemName(item), query)}
        {@const scope = variableScope(item.rawValue)}
        <div class="var-menu__item" class:is-active={i === active}>
          <button
            type="button"
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            class="var-menu__row"
            onmousedown={pickOnMouseDown(i)}
            onclick={pickOnKeyboardClick(i)}
          >
            <i class="var-menu__icon ph-light {TYPE_ICONS[item.type] || 'ph-brackets-curly'}"></i>
            <span class="var-menu__name"
              >@{parts.before}<mark>{parts.match}</mark>{parts.after}</span
            >
            <span class="var-menu__value">{itemValue(item)}</span>
            {#if isAiItem(item)}
              <span class="var-menu__badge var-menu__badge--ai">{$_('AI')}</span>
            {/if}
            <span class="var-menu__badge" class:is-global={scope === 'desktop'}>
              {scope === 'desktop' ? $_('Desktop') : $_('Doc')}
            </span>
          </button>
          <button
            type="button"
            class="var-menu__edit"
            tabindex="-1"
            title={$_('Edit')}
            aria-label={$_('Edit "@{name}"', { values: { name: itemName(item) } })}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => void openForm(item)}
          >
            <i class="ph-light ph-pencil-simple"></i>
          </button>
        </div>
      {/each}

      {#if !items.length}
        <div class="var-menu__empty">
          {query
            ? $_('No variable starts with "{query}"', { values: { query } })
            : $_('No variables yet')}
        </div>
      {/if}

      {#if showCreate || showSheetRef}
        <div class="var-menu__divider" role="separator"></div>
      {/if}

      {#if showCreate}
        <div class="var-menu__item" class:is-active={createIndex === active}>
          <button
            type="button"
            id={optionId(createIndex)}
            role="option"
            aria-selected={createIndex === active}
            class="var-menu__row var-menu__row--create"
            onmousedown={pickOnMouseDown(createIndex)}
            onclick={pickOnKeyboardClick(createIndex)}
          >
            <i class="var-menu__icon var-menu__icon--create ph-bold ph-plus"></i>
            <span>
              {typedName
                ? $_('Create "@{name}"', { values: { name: typedName } })
                : $_('New variable…')}
            </span>
          </button>
        </div>
      {/if}

      {#if showSheetRef}
        <div class="var-menu__item" class:is-active={sheetRefIndex === active}>
          <button
            type="button"
            id={optionId(sheetRefIndex)}
            role="option"
            aria-selected={sheetRefIndex === active}
            class="var-menu__row"
            onmousedown={pickOnMouseDown(sheetRefIndex)}
            onclick={pickOnKeyboardClick(sheetRefIndex)}
          >
            <i class="var-menu__icon var-menu__icon--sheet ph-light ph-function"></i>
            <span>{$_('From a spreadsheet cell…')}</span>
          </button>
        </div>
      {/if}
    </div>

    {#if recentShown.length && !query}
      <div class="var-menu__recent">
        <div class="var-menu__section">
          <span>{$_('Recent')}</span>
          <i class="ph-light ph-clock-counter-clockwise"></i>
        </div>
        {#each recentShown as hist (hist.name)}
          <button
            type="button"
            class="var-menu__row var-menu__row--recent"
            onmousedown={(e) => {
              e.preventDefault()
              pickRecent(hist)
            }}
            onclick={(e) => {
              if (e.detail === 0) pickRecent(hist)
            }}
          >
            <i class="var-menu__icon ph-light {TYPE_ICONS[hist.type] || 'ph-brackets-curly'}"></i>
            <span class="var-menu__name">@{formatSpreadsheetRefName(hist.name) || hist.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  {:else if mode === 'form'}
    <form
      class="var-menu__form"
      onsubmit={(e) => {
        e.preventDefault()
        submitForm()
      }}
    >
      <div class="var-menu__form-title">
        {editingOriginalName ? $_('Edit variable') : $_('New variable')}
        {#if newVarName}<b>@{normalizeVariableName(newVarName)}</b>{/if}
      </div>

      <div class="var-menu__types" role="group" aria-label={$_('Type')}>
        {#each TYPE_TABS as tab (tab.type)}
          <button
            type="button"
            class="var-menu__type"
            aria-pressed={selectedType === tab.type}
            title={$_(tab.label)}
            aria-label={$_(tab.label)}
            onclick={() => (selectedType = tab.type)}
          >
            <i class="ph-light {tab.icon}"></i>
          </button>
        {/each}
      </div>

      <div class="var-menu__pair">
        <div class="var-menu__field">
          <label class="var-menu__label" for="{listboxId}-name">{$_('Name')}</label>
          <input
            bind:this={nameInput}
            id="{listboxId}-name"
            class="var-menu__input"
            type="text"
            autocomplete="off"
            placeholder={$_('Variable name...')}
            bind:value={newVarName}
            oninput={onNameInput}
          />
        </div>
        <div class="var-menu__field">
          {#if selectedType === VAR_TYPE.file || selectedType === VAR_TYPE.folder}
            <span class="var-menu__label">{$_('Value')}</span>
            <button
              type="button"
              class="var-menu__btn var-menu__btn--block"
              title={newVarValue}
              onclick={() => handlePick(selectedType === VAR_TYPE.file ? 'file' : 'folder')}
            >
              <i
                class="ph-light {selectedType === VAR_TYPE.file
                  ? 'ph-file-plus'
                  : 'ph-folder-plus'}"
              ></i>
              {newVarValue
                ? newVarValue.split(/[\\/]/).pop()
                : selectedType === VAR_TYPE.file
                  ? $_('Pick File')
                  : $_('Pick Folder')}
            </button>
          {:else if selectedType === VAR_TYPE.richtext}
            <span class="var-menu__label">{$_('Value')}</span>
            <button
              type="button"
              class="var-menu__btn var-menu__btn--block"
              onclick={() => handleEditRichText?.(newVarName)}
            >
              <i class="ph-light ph-article"></i>
              {$_('Edit Text')}
            </button>
          {:else}
            <label class="var-menu__label" for="{listboxId}-value">
              {selectedType === VAR_TYPE.ai ? $_('AI prompt') : $_('Value')}
            </label>
            <input
              bind:this={valueInput}
              id="{listboxId}-value"
              class="var-menu__input"
              type="text"
              autocomplete="off"
              placeholder={selectedType === VAR_TYPE.ai ? $_('AI prompt...') : $_('Value...')}
              bind:value={newVarValue}
              oninput={() => (valueDirty = true)}
            />
          {/if}
        </div>
      </div>

      {#if selectedType === VAR_TYPE.text || selectedType === VAR_TYPE.datetime}
        <div class="var-menu__pair">
          <select class="var-menu__input" aria-label={$_('Format')} bind:value={newVarFormat}>
            {#each Object.entries(VariableManipulatorUtils.FORMAT_LABELS) as [value, label] (value)}
              <option value={VariableManipulatorUtils.EXCEL_FORMATS[value]}>{label}</option>
            {/each}
          </select>
          {#if selectedType === VAR_TYPE.datetime}
            <label class="var-menu__check">
              <input
                type="checkbox"
                checked={newVarAutoUpdate}
                onchange={(e) => (newVarAutoUpdate = (e.target as HTMLInputElement).checked)}
              />
              {$_('Auto')}
            </label>
          {/if}
        </div>
      {/if}

      <div class="var-menu__scopes" role="group" aria-label={$_('Scope')}>
        <button
          type="button"
          class="var-menu__scope-btn"
          aria-pressed={isDocScope()}
          onclick={() => {
            if (!isDocScope()) advVisibility = scopeVisibility('doc')
          }}>{$_('This document')}</button
        >
        <button
          type="button"
          class="var-menu__scope-btn"
          aria-pressed={!isDocScope()}
          onclick={() => {
            if (isDocScope()) advVisibility = scopeVisibility('desktop')
          }}>{$_('All my files')}</button
        >
      </div>

      {#if showAdvanced}
        <div class="var-menu__advanced">
          <label class="var-menu__label" for="{listboxId}-aliases">{$_('Aliases')}</label>
          <input
            id="{listboxId}-aliases"
            class="var-menu__input"
            placeholder={$_('Comma separated')}
            bind:value={advAliases}
          />
          <label class="var-menu__label" for="{listboxId}-description">{$_('Description')}</label>
          <input
            id="{listboxId}-description"
            class="var-menu__input"
            placeholder={$_('Optional description')}
            bind:value={advDescription}
          />
          <label class="var-menu__label" for="{listboxId}-visibility">{$_('Visibility')}</label>
          <select id="{listboxId}-visibility" class="var-menu__input" bind:value={advVisibility}>
            <option value="document">{$_('Document')}</option>
            <option value="package">{$_('Package')}</option>
            <option value="desktop">{$_('Desktop')}</option>
            <option value="cloud">{$_('Cloud')}</option>
          </select>
          <label class="var-menu__label" for="{listboxId}-access">{$_('Access')}</label>
          <input
            id="{listboxId}-access"
            class="var-menu__input"
            placeholder={$_('Emails (empty = everyone)')}
            bind:value={advAccess}
          />
          <label class="var-menu__label" for="{listboxId}-read">{$_('Read')}</label>
          <input
            id="{listboxId}-read"
            class="var-menu__input"
            placeholder={$_('Emails (empty = everyone)')}
            bind:value={advRead}
          />
          <label class="var-menu__label" for="{listboxId}-write">{$_('Write')}</label>
          <input
            id="{listboxId}-write"
            class="var-menu__input"
            placeholder={$_('Emails (empty = everyone)')}
            bind:value={advWrite}
          />
        </div>
      {/if}

      {#if nameError}
        <div class="var-menu__error" role="alert">{nameError}</div>
      {/if}

      <div class="var-menu__actions">
        <button
          type="button"
          class="var-menu__link"
          aria-expanded={showAdvanced}
          onclick={() => (showAdvanced = !showAdvanced)}
        >
          {showAdvanced ? $_('Fewer options') : $_('More options')}
        </button>
        <button type="button" class="var-menu__btn" onclick={backToList}>{$_('Cancel')}</button>
        <button type="submit" class="var-menu__btn var-menu__btn--primary">
          {editingOriginalName ? $_('Update and insert') : $_('Create and insert')}
        </button>
      </div>
    </form>
  {:else}
    <div class="var-menu__form">
      <div class="var-menu__form-title">{$_('Spreadsheet Reference')}</div>
      <select
        bind:this={sheetRefSelect}
        class="var-menu__input"
        aria-label={$_('Spreadsheet Reference')}
        bind:value={sheetRefId}
        onchange={() => {
          const match = spreadsheetPointers.find((s) => s.id === sheetRefId)
          sheetRefName = match?.name || 'Sheet1'
        }}
      >
        {#each spreadsheetPointers as sheet (sheet.id)}
          <option value={sheet.id}>{getSpreadsheetPointerLabel(sheet)}</option>
        {/each}
      </select>
      <div class="var-menu__pair">
        <input
          type="text"
          class="var-menu__input"
          aria-label={$_('Sheet1')}
          placeholder={$_('Sheet1')}
          bind:value={sheetRefName}
          disabled={!sheetUseName}
        />
        <input
          type="text"
          class="var-menu__input"
          aria-label={$_('A1 or A1:B2')}
          placeholder={$_('A1 or A1:B2')}
          bind:value={sheetCellRef}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              insertSpreadsheetReference()
            }
          }}
        />
      </div>
      <label class="var-menu__check">
        <input type="checkbox" bind:checked={sheetUseName} />
        {$_('Use sheet name')}
      </label>
      <div class="var-menu__ref">{buildSpreadsheetReference()}</div>
      <div class="var-menu__actions">
        <button type="button" class="var-menu__btn" onclick={backToList}>{$_('Cancel')}</button>
        <button
          type="button"
          class="var-menu__btn var-menu__btn--primary"
          onclick={insertSpreadsheetReference}
        >
          {$_('Insert')}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .var-menu {
    position: fixed;
    z-index: 10000;
    width: 23rem;
    max-width: calc(100vw - 16px);
    max-height: 26rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 6px;
    background: var(--color-base-100);
    color: var(--color-base-content);
    border: 1px solid color-mix(in srgb, var(--color-base-content) 14%, transparent);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
    font-size: 13px;
    font-family: inherit;
    overflow: hidden;
  }

  .var-menu__list {
    overflow-y: auto;
    min-height: 0;
    flex: 0 1 auto;
  }

  .var-menu__item {
    display: flex;
    align-items: center;
    border-radius: 8px;
  }
  .var-menu__item:hover {
    background: color-mix(in srgb, var(--color-base-content) 6%, transparent);
  }
  .var-menu__item.is-active {
    background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  }

  .var-menu__row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .var-menu__row--create {
    color: color-mix(in srgb, var(--color-primary) 80%, var(--color-base-content));
  }
  .var-menu__row--recent {
    padding-block: 4px;
    opacity: 0.75;
  }
  .var-menu__row--recent:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--color-base-content) 6%, transparent);
  }

  .var-menu__edit {
    flex: none;
    width: 28px;
    height: 28px;
    margin-right: 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    opacity: 0;
    cursor: pointer;
  }
  .var-menu__item:hover .var-menu__edit,
  .var-menu__item.is-active .var-menu__edit,
  .var-menu__edit:focus-visible {
    opacity: 0.7;
  }
  .var-menu__edit:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--color-base-content) 10%, transparent);
  }

  .var-menu__icon {
    flex: none;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    font-size: 13px;
    background: color-mix(in srgb, var(--color-base-content) 8%, transparent);
  }
  .var-menu__icon--create {
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
    color: var(--color-primary);
  }
  .var-menu__icon--sheet {
    background: color-mix(in srgb, #f59e0b 22%, transparent);
  }

  .var-menu__name {
    flex: none;
    max-width: 50%;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .var-menu__name mark {
    background: transparent;
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .var-menu__value {
    flex: 1;
    min-width: 0;
    text-align: right;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .var-menu__badge {
    flex: none;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-base-content) 9%, transparent);
  }
  .var-menu__badge.is-global {
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
    color: color-mix(in srgb, var(--color-primary) 75%, var(--color-base-content));
  }
  .var-menu__badge--ai {
    background: color-mix(in srgb, #a855f7 20%, transparent);
    color: color-mix(in srgb, #a855f7 75%, var(--color-base-content));
  }

  .var-menu__empty {
    padding: 8px 10px;
    font-size: 12px;
    opacity: 0.65;
  }
  .var-menu__divider {
    height: 1px;
    margin: 4px 0;
    background: color-mix(in srgb, var(--color-base-content) 12%, transparent);
  }
  .var-menu__recent {
    flex: none;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid color-mix(in srgb, var(--color-base-content) 12%, transparent);
  }
  .var-menu__section {
    display: flex;
    justify-content: space-between;
    padding: 2px 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.55;
  }

  .var-menu__form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px;
    overflow-y: auto;
    min-height: 0;
  }
  .var-menu__form-title {
    font-size: 13px;
  }
  .var-menu__types {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-base-content) 6%, transparent);
  }
  .var-menu__type {
    flex: 1;
    padding: 4px 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 15px;
    opacity: 0.5;
    cursor: pointer;
  }
  .var-menu__type[aria-pressed='true'] {
    background: var(--color-base-100);
    color: var(--color-primary);
    opacity: 1;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
  }
  .var-menu__field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .var-menu__label {
    font-size: 11px;
    opacity: 0.7;
  }
  .var-menu__input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 20%, transparent);
    border-radius: 8px;
    background: var(--color-base-100);
    color: inherit;
    font: inherit;
    outline: none;
  }
  .var-menu__input:focus {
    border-color: var(--color-primary);
  }
  .var-menu__advanced {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .var-menu__error {
    font-size: 11px;
    color: var(--color-error);
  }
  .var-menu__scopes,
  .var-menu__pair {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }
  .var-menu__scope-btn {
    flex: 1;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 20%, transparent);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .var-menu__scope-btn[aria-pressed='true'] {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    font-weight: 600;
  }
  .var-menu__actions {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }
  .var-menu__link {
    margin-right: auto;
    border: none;
    background: none;
    padding: 0;
    color: var(--color-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .var-menu__link:hover {
    text-decoration: underline;
  }
  .var-menu__btn {
    padding: 6px 10px;
    border: 1px solid color-mix(in srgb, var(--color-base-content) 20%, transparent);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .var-menu__btn--block {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .var-menu__btn--primary {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: var(--color-primary-content);
    font-weight: 600;
  }
  .var-menu__check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.75;
    white-space: nowrap;
  }
  .var-menu__ref {
    font-size: 11px;
    opacity: 0.6;
    word-break: break-all;
  }

  /* Phones and narrow windows: a bottom sheet, rows large enough to touch. */
  .var-menu--sheet {
    left: 0;
    right: 0;
    width: auto;
    max-width: none;
    padding: 4px 12px calc(12px + env(safe-area-inset-bottom, 0px));
    border-radius: 20px 20px 0 0;
    border-bottom: none;
    box-shadow: 0 -12px 32px rgba(15, 23, 42, 0.18);
    font-size: 16px;
  }
  .var-menu__handle {
    display: flex;
    justify-content: center;
    padding: 6px 0 8px;
    touch-action: none;
    cursor: grab;
  }
  .var-menu__handle span {
    width: 40px;
    height: 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--color-base-content) 25%, transparent);
  }
  .var-menu__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 4px;
  }
  .var-menu__title {
    font-size: 15px;
    font-weight: 600;
  }
  .var-menu__close {
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font-size: 22px;
    cursor: pointer;
  }
  .var-menu__filter {
    padding: 0 6px 6px;
    font-size: 13px;
    opacity: 0.7;
  }
  .var-menu--sheet .var-menu__row {
    min-height: 52px;
    padding: 8px 10px;
    border-radius: 12px;
    gap: 12px;
  }
  .var-menu--sheet .var-menu__row--recent {
    min-height: 44px;
  }
  .var-menu--sheet .var-menu__row--create {
    font-weight: 600;
  }
  .var-menu--sheet .var-menu__edit {
    width: 44px;
    height: 44px;
    opacity: 0.6;
  }
  .var-menu--sheet .var-menu__input,
  .var-menu--sheet .var-menu__btn,
  .var-menu--sheet .var-menu__scope-btn,
  .var-menu--sheet .var-menu__type {
    min-height: 44px;
    font-size: 16px;
  }
  .var-menu--sheet .var-menu__badge {
    font-size: 11px;
  }
</style>
