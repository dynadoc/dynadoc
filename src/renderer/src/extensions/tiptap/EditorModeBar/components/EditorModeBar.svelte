<script lang="ts">
  /**
   * The editor's mode bar: [Edit mode ▾] | [@ Variables switch] | [AI].
   *
   * Replaces three floating buttons: the review mode pencil
   * (ReviewQuickModeWidget), the "VARS ON/OFF" pill and the sparkle AI button
   * (CustomAIToolbar). Mounted once per editor by attachEditorModeBar.
   *
   * Desktop: one compact bar at the top inline-end corner of the editor area.
   * Spreadsheets: the same bar docked in a strip above the grid, so nothing
   * covers cells, row numbers or column headers.
   * Narrow window or touch screen: a pill showing the mode plus a small @
   * switch, the pill opening a bottom sheet with everything.
   */
  import { _ } from 'svelte-i18n'
  import { onDestroy, onMount, tick } from 'svelte'
  import type { Editor } from '@tiptap/core'
  import { _$_documentEditorsList } from '../../../../stores/editor.store'
  import { GenericFormatingEditorCommands } from '../../../../components/common/actions/formatting'
  import ContextMenuWidget from '../../../../components/common/contextMenu/components/ContextMenuWidget.svelte'
  import { aiGenerationStore } from '../../CustomAIExtension/stores/aiGeneration.store'
  import { abortAIGeneration, buildAIMenuItems } from '../aiMenuItems'
  import {
    COMPACT_MEDIA_QUERY,
    REVIEW_MODES,
    aiPhaseLabelKey,
    moveMenuFocus,
    resolveReviewMode,
    reviewModeCommands,
    reviewModeMeta,
    variablesSwitchState,
    type ReviewMode
  } from '../editorModeBar.utils'

  const {
    editor,
    review = true,
    ai = true,
    root = null,
    host = null
  } = $props<{
    editor: Editor | null
    review?: boolean
    ai?: boolean
    /** The editor's scrolling shell, to measure the free space beside the page. */
    root?: HTMLElement | null
    /** The element this bar is mounted in, which docks as a strip when needed. */
    host?: HTMLElement | null
  }>()

  const uid = Math.random().toString(36).slice(2, 8)
  const ids = {
    modeMenu: `emb-mode-menu-${uid}`,
    varsHint: `emb-vars-hint-${uid}`,
    sheetTitle: `emb-sheet-title-${uid}`
  }

  /* ---------------------------------------------------------------- mode */

  let currentMode = $state<ReviewMode>('edit')

  const activeDocStore = _$_documentEditorsList.getActive()
  const activeDoc = $derived($activeDocStore)

  // Same sources as the former ReviewQuickModeWidget.resolveMode.
  const resolveMode = (): ReviewMode =>
    resolveReviewMode({
      editorTrackChanges: editor?.storage?.review?.enabled,
      configTrackChanges: activeDoc?.document?.config?.reviewSettings?.trackChangesEnabled,
      markupMode: activeDoc?.document?.config?.reviewSettings?.markupMode
    })

  const setMode = (mode: ReviewMode): void => {
    const { trackChanges, markupMode } = reviewModeCommands(mode)
    GenericFormatingEditorCommands.toggleTrackChanges(trackChanges)
    GenericFormatingEditorCommands.setMarkupMode(markupMode)
    currentMode = mode
  }

  const modeMeta = $derived(reviewModeMeta(currentMode))
  const modeLabel = $derived($_(modeMeta.labelKey))

  // The document config can change without an editor transaction (ribbon,
  // review pane): follow it too.
  $effect(() => {
    void activeDoc
    currentMode = resolveMode()
  })

  let detachTransaction: (() => void) | null = null
  onMount(() => {
    currentMode = resolveMode()
    if (!editor) return
    const handler = (): void => {
      currentMode = resolveMode()
    }
    editor.on('transaction', handler)
    detachTransaction = () => editor.off('transaction', handler)
  })

  /* ----------------------------------------------------------- mode menu */

  let modeMenuOpen = $state(false)
  let modeTriggerEl = $state<HTMLButtonElement | null>(null)
  let modeMenuEl = $state<HTMLElement | null>(null)
  let modeFocusIndex = $state(0)

  const focusModeItem = async (index: number): Promise<void> => {
    modeFocusIndex = index
    await tick()
    modeMenuEl?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[index]?.focus()
  }

  const openModeMenu = (focus: 'current' | 'first' | 'last' = 'current'): void => {
    modeMenuOpen = true
    const index =
      focus === 'first'
        ? 0
        : focus === 'last'
          ? REVIEW_MODES.length - 1
          : Math.max(0, REVIEW_MODES.indexOf(currentMode))
    void focusModeItem(index)
  }

  const closeModeMenu = (returnFocus = true): void => {
    if (!modeMenuOpen) return
    modeMenuOpen = false
    if (returnFocus) modeTriggerEl?.focus()
  }

  const onModeTriggerKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openModeMenu('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openModeMenu('last')
    }
  }

  const onModeMenuKeydown = (event: KeyboardEvent): void => {
    const none = REVIEW_MODES.map(() => false)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeModeMenu()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      void focusModeItem(moveMenuFocus(modeFocusIndex, 1, none))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      void focusModeItem(moveMenuFocus(modeFocusIndex, -1, none))
    } else if (event.key === 'Home') {
      event.preventDefault()
      void focusModeItem(moveMenuFocus(modeFocusIndex, 'first', none))
    } else if (event.key === 'End') {
      event.preventDefault()
      void focusModeItem(moveMenuFocus(modeFocusIndex, 'last', none))
    } else if (event.key === 'Tab') {
      closeModeMenu(false)
    }
  }

  const pickMode = async (mode: ReviewMode): Promise<void> => {
    setMode(mode)
    closeModeMenu(false)
    // After the mode commands, which can move focus into the editor.
    await tick()
    modeTriggerEl?.focus()
  }

  /* ----------------------------------------------------------- variables */

  const preferVariables = $derived($aiGenerationStore.preferVariables)
  const varsState = $derived(variablesSwitchState(preferVariables))
  const toggleVariables = (event?: MouseEvent): void => {
    event?.stopPropagation()
    aiGenerationStore.togglePreferVariables()
  }

  /* ------------------------------------------------------------------ AI */

  const aiPhase = $derived($aiGenerationStore.phase)
  const generating = $derived(aiPhase !== 'idle')
  const aiStatusKey = $derived(aiPhaseLabelKey(aiPhase))

  let selectionTick = $state(0)
  $effect(() => {
    if (!editor) return undefined
    const handleSelection = (): void => {
      selectionTick += 1
    }
    editor.on('selectionUpdate', handleSelection)
    return () => {
      editor.off('selectionUpdate', handleSelection)
    }
  })
  const hasSelection = $derived.by(() => {
    void selectionTick
    return GenericFormatingEditorCommands.hasSelection()
  })

  const abort = (): void => abortAIGeneration(editor)
  const aiMenuItems = $derived(buildAIMenuItems({ hasSelection, generating, abort }))

  let aiMenuShow = $state(false)
  let aiMenuX = $state(0)
  let aiMenuY = $state(0)
  let aiMenuRef = $state<HTMLElement | null>(null)
  let aiTriggerEl = $state<HTMLButtonElement | null>(null)
  // Width the AI menu is laid out with (ContextMenuWidget min-width + padding).
  const AI_MENU_WIDTH = 236

  const openAIMenu = (anchor: HTMLElement | null, event?: MouseEvent): void => {
    event?.stopPropagation()
    closeModeMenu(false)
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    // Open under the button, its end edge aligned with the button's. The
    // widget flips and shifts the menu back into the window if needed.
    aiMenuX = Math.max(8, rect.right - AI_MENU_WIDTH)
    aiMenuY = rect.bottom + 2
    aiMenuShow = true
  }

  /* -------------------------------------------------- compact (mobile) */

  let compact = $state(false)
  let detachMedia: (() => void) | null = null
  onMount(() => {
    const query = window.matchMedia?.(COMPACT_MEDIA_QUERY)
    if (!query) return
    const sync = (): void => {
      compact = query.matches
    }
    sync()
    query.addEventListener('change', sync)
    detachMedia = () => query.removeEventListener('change', sync)
  })

  let sheetOpen = $state(false)
  let sheetEl = $state<HTMLElement | null>(null)
  let fabEl = $state<HTMLButtonElement | null>(null)

  const sheetFocusables = (): HTMLElement[] =>
    Array.from(sheetEl?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []).filter(
      (el) => el.offsetParent !== null
    )

  const openSheet = async (): Promise<void> => {
    sheetOpen = true
    await tick()
    sheetFocusables()[0]?.focus()
  }

  const closeSheet = (returnFocus = true): void => {
    if (!sheetOpen) return
    sheetOpen = false
    if (returnFocus) fabEl?.focus()
  }

  const onSheetKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeSheet()
      return
    }
    if (event.key !== 'Tab') return
    // Keep focus inside the open sheet.
    const items = sheetFocusables()
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // The sheet stays open on a mode change; keep focus on the pressed segment
  // (the mode commands can move focus into the editor).
  const pickModeInSheet = async (mode: ReviewMode, segment: HTMLElement): Promise<void> => {
    setMode(mode)
    await tick()
    if (sheetOpen) segment.focus()
  }

  const runFromSheet = (action: () => unknown): void => {
    closeSheet(false)
    action()
  }

  const openAIMenuFromSheet = (): void => {
    closeSheet(false)
    openAIMenu(fabEl)
  }

  // Teleports the bottom sheet to <body>: the editor root clips overflow.
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node)
    return {
      destroy() {
        node.remove()
      }
    }
  }

  /* ------------------------------------------------------------ outside */

  const onWindowPointerDown = (event: PointerEvent): void => {
    if (!modeMenuOpen) return
    const target = event.target as Node
    if (modeMenuEl?.contains(target) || modeTriggerEl?.contains(target)) return
    closeModeMenu(false)
  }

  /* ------------------------------------------------------------ docking
     The bar floats in the free space beside the page. When that space is
     narrower than the bar (narrow window, zoomed page, right-to-left text
     running up to the page edge), the host docks as a strip above the
     editor so the bar never covers text. Spreadsheets always dock (CSS,
     keyed on the document type). */

  let barEl = $state<HTMLElement | null>(null)
  let modeLabelEl = $state<HTMLElement | null>(null)
  let measureCanvas: HTMLCanvasElement | null = null

  // Gap kept between the text and the floating bar, and the bar's inset
  // (keep in sync with .emb's inset-inline-end).
  const DOCK_GAP = 8
  const BAR_INSET = 20

  // Width of the bar with its longest mode label, so that switching modes
  // never moves the page (a docked strip pushes it down).
  const widestBarWidth = (): number => {
    if (!barEl) return 0
    if (!modeLabelEl) return barEl.offsetWidth
    measureCanvas ??= document.createElement('canvas')
    const ctx = measureCanvas.getContext('2d')
    if (!ctx) return barEl.offsetWidth
    const style = getComputedStyle(modeLabelEl)
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const widest = Math.max(
      ...REVIEW_MODES.map((mode) => ctx.measureText($_(reviewModeMeta(mode).labelKey)).width)
    )
    return barEl.offsetWidth - modeLabelEl.offsetWidth + Math.ceil(widest)
  }

  const updateDocking = (): void => {
    if (!root || !host || !editor || !barEl || compact) {
      host?.classList.remove('is-docked')
      return
    }
    const page = editor.view?.dom as HTMLElement | undefined
    if (!page) return
    const shellRect = root.getBoundingClientRect()
    const pageRect = page.getBoundingClientRect()
    if (!shellRect.width || !pageRect.width) return // hidden tab: keep as is
    // Text box = page box minus its padding (the page margins), at the
    // page's current zoom.
    const scale = page.offsetWidth ? pageRect.width / page.offsetWidth : 1
    const style = getComputedStyle(page)
    const textLeft = pageRect.left + parseFloat(style.paddingLeft || '0') * scale
    const textRight = pageRect.right - parseFloat(style.paddingRight || '0') * scale
    const barWidth = widestBarWidth()
    const rtlUi = getComputedStyle(host).direction === 'rtl'
    const fits = rtlUi
      ? shellRect.left + BAR_INSET + barWidth + DOCK_GAP <= textLeft
      : shellRect.right - BAR_INSET - barWidth - DOCK_GAP >= textRight
    host.classList.toggle('is-docked', !fits)
  }

  $effect(() => {
    if (!root || !host || !editor || !barEl) {
      // Compact layout (no bar) or not mounted yet: nothing to dock.
      host?.classList.remove('is-docked')
      return undefined
    }
    // Re-measure when the layout or the language changes.
    void compact
    void $_
    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateDocking)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    const page = editor.view?.dom as HTMLElement | undefined
    if (page) observer.observe(page)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  })

  // Escape also closes when focus has left the menu or sheet (picking a
  // mode runs editor commands that can move focus back into the editor).
  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (sheetOpen) {
      event.preventDefault()
      closeSheet()
    } else if (modeMenuOpen) {
      event.preventDefault()
      closeModeMenu()
    }
  }

  // Leaving compact layout with the sheet open would strand it.
  $effect(() => {
    if (!compact && sheetOpen) sheetOpen = false
    if (compact && modeMenuOpen) modeMenuOpen = false
  })

  onDestroy(() => {
    detachTransaction?.()
    detachMedia?.()
  })
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

{#if !compact}
  <div class="emb" role="toolbar" aria-label={$_('modeBar.toolbar')} bind:this={barEl}>
    {#if review}
      <div class="emb-anchor">
        <button
          type="button"
          class="emb-btn emb-mode"
          class:is-review={modeMeta.tone === 'review'}
          class:is-open={modeMenuOpen}
          bind:this={modeTriggerEl}
          aria-haspopup="menu"
          aria-expanded={modeMenuOpen}
          aria-controls={ids.modeMenu}
          aria-label={$_('modeBar.mode.current', { values: { mode: modeLabel } })}
          title={$_('modeBar.mode.menu')}
          onclick={(e) => {
            e.stopPropagation()
            if (modeMenuOpen) closeModeMenu(false)
            else openModeMenu()
          }}
          onkeydown={onModeTriggerKeydown}
        >
          <i class="{modeMeta.icon} emb-icon" aria-hidden="true"></i>
          <span class="emb-label" bind:this={modeLabelEl}>{modeLabel}</span>
          <i class="ph-bold ph-caret-down emb-caret" aria-hidden="true"></i>
        </button>

        {#if modeMenuOpen}
          <div
            class="emb-menu"
            role="menu"
            tabindex="-1"
            id={ids.modeMenu}
            aria-label={$_('modeBar.mode.menu')}
            bind:this={modeMenuEl}
            onkeydown={onModeMenuKeydown}
          >
            {#each REVIEW_MODES as mode, index (mode)}
              {@const meta = reviewModeMeta(mode)}
              <button
                type="button"
                role="menuitemradio"
                class="emb-menu-item"
                class:is-active={mode === currentMode}
                aria-checked={mode === currentMode}
                tabindex={index === modeFocusIndex ? 0 : -1}
                onclick={() => pickMode(mode)}
              >
                <i class="{meta.icon} emb-menu-icon" aria-hidden="true"></i>
                <span class="emb-menu-text">
                  <span class="emb-menu-label">{$_(meta.labelKey)}</span>
                  <span class="emb-menu-hint">{$_(meta.hintKey)}</span>
                </span>
                {#if mode === currentMode}
                  <i class="ph-bold ph-check emb-menu-check" aria-hidden="true"></i>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if ai}
      {#if review}<span class="emb-sep" aria-hidden="true"></span>{/if}

      <div class="emb-anchor emb-vars-anchor">
        <button
          type="button"
          role="switch"
          class="emb-btn emb-vars"
          class:is-on={preferVariables}
          aria-checked={varsState.ariaChecked}
          aria-describedby={ids.varsHint}
          onclick={toggleVariables}
        >
          <span class="emb-at" aria-hidden="true">@</span>
          <span class="emb-label">{$_('modeBar.vars.label')}</span>
          <span class="emb-track" aria-hidden="true"><span class="emb-knob"></span></span>
        </button>
        <span class="emb-tip" role="tooltip" id={ids.varsHint}>
          <strong>{$_(varsState.stateKey)}</strong>
          {$_(varsState.descriptionKey)}
        </span>
      </div>

      <span class="emb-sep" aria-hidden="true"></span>

      <button
        type="button"
        class="emb-btn emb-ai"
        class:is-open={aiMenuShow}
        class:is-busy={generating}
        bind:this={aiTriggerEl}
        aria-haspopup="menu"
        aria-expanded={aiMenuShow}
        title={$_('AI Tools')}
        onclick={(e) => openAIMenu(aiTriggerEl, e)}
      >
        <span class="emb-ai-icon" aria-hidden="true">
          <i class="ph-bold ph-sparkle emb-icon"></i>
          {#if generating}<span class="emb-pulse"></span>{/if}
        </span>
        <span class="emb-label">{$_('modeBar.ai.label')}</span>
        {#if aiStatusKey}
          <span class="emb-status">{$_(aiStatusKey)}</span>
        {/if}
      </button>
    {/if}
  </div>
{:else}
  <div class="emb-compact">
    {#if ai}
      <button
        type="button"
        role="switch"
        class="emb-fab-vars"
        class:is-on={preferVariables}
        aria-checked={varsState.ariaChecked}
        aria-label={$_('modeBar.vars.label')}
        title={$_(varsState.descriptionKey)}
        onclick={toggleVariables}
      >
        <span class="emb-at" aria-hidden="true">@</span>
        <span class="emb-track" aria-hidden="true"><span class="emb-knob"></span></span>
      </button>
    {/if}
    <button
      type="button"
      class="emb-fab"
      class:is-review={review && modeMeta.tone === 'review'}
      bind:this={fabEl}
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      aria-label={review
        ? $_('modeBar.sheet.open', { values: { mode: modeLabel } })
        : $_('modeBar.ai.menu')}
      onclick={openSheet}
    >
      <span class="emb-ai-icon" aria-hidden="true">
        <i class="{review ? modeMeta.icon : 'ph-bold ph-sparkle'} emb-icon"></i>
        {#if generating}<span class="emb-pulse"></span>{/if}
      </span>
      <span>{review ? modeLabel : $_('modeBar.ai.label')}</span>
    </button>
  </div>
{/if}

<!-- One polite live region for the generation status, in both layouts. -->
<span class="emb-sr-only" role="status" aria-live="polite">
  {aiStatusKey ? $_(aiStatusKey) : ''}
</span>

{#if compact && sheetOpen}
  <div use:portal class="emb-sheet-layer">
    <button
      type="button"
      class="emb-sheet-backdrop"
      tabindex="-1"
      aria-label={$_('modeBar.sheet.close')}
      onclick={() => closeSheet()}
    ></button>
    <div
      class="emb-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ids.sheetTitle}
      tabindex="-1"
      bind:this={sheetEl}
      onkeydown={onSheetKeydown}
    >
      <div class="emb-sheet-grip" aria-hidden="true"></div>
      <div class="emb-sheet-head">
        <h2 class="emb-sheet-title" id={ids.sheetTitle}>{$_('modeBar.sheet.title')}</h2>
        <button
          type="button"
          class="emb-sheet-close"
          aria-label={$_('modeBar.sheet.close')}
          onclick={() => closeSheet()}
        >
          <i class="ph-bold ph-x" aria-hidden="true"></i>
        </button>
      </div>

      {#if review}
        <div class="emb-sheet-section">{$_('modeBar.sheet.mode')}</div>
        <div class="emb-segmented" role="group" aria-label={$_('modeBar.mode.menu')}>
          {#each REVIEW_MODES as mode (mode)}
            {@const meta = reviewModeMeta(mode)}
            <button
              type="button"
              class="emb-segment"
              class:is-active={mode === currentMode}
              class:is-review={mode === currentMode && meta.tone === 'review'}
              aria-pressed={mode === currentMode}
              title={$_(meta.hintKey)}
              onclick={(e) => pickModeInSheet(mode, e.currentTarget)}
            >
              <i class={meta.icon} aria-hidden="true"></i>
              <span>{$_(meta.labelKey)}</span>
            </button>
          {/each}
        </div>
        <p class="emb-sheet-hint">{$_(modeMeta.hintKey)}</p>
      {/if}

      {#if ai}
        <div class="emb-sheet-section">
          {$_('modeBar.sheet.ai')}
          {#if aiStatusKey}<span class="emb-status">· {$_(aiStatusKey)}</span>{/if}
        </div>
        <button
          type="button"
          class="emb-sheet-row"
          disabled={!hasSelection}
          title={hasSelection ? '' : $_('modeBar.ai.selectFirst')}
          onclick={() => runFromSheet(() => GenericFormatingEditorCommands.rewriteWithAI())}
        >
          <i class="ph-bold ph-pen-nib" aria-hidden="true"></i>
          <span>{$_('modeBar.ai.rewrite')}</span>
        </button>
        <button
          type="button"
          class="emb-sheet-row"
          onclick={() => runFromSheet(() => GenericFormatingEditorCommands.insertAI())}
        >
          <i class="ph-bold ph-cursor-text" aria-hidden="true"></i>
          <span>{$_('Insert AI Block')}</span>
        </button>
        {#if generating}
          <button type="button" class="emb-sheet-row" onclick={() => runFromSheet(abort)}>
            <i class="ph-bold ph-stop-circle" aria-hidden="true"></i>
            <span>{$_('Stop Generation')}</span>
          </button>
        {/if}
        <button type="button" class="emb-sheet-row" onclick={openAIMenuFromSheet}>
          <i class="ph-bold ph-sparkle" aria-hidden="true"></i>
          <span>{$_('modeBar.ai.more')}</span>
          <i class="ph-bold ph-caret-right emb-sheet-row-end" aria-hidden="true"></i>
        </button>
        <button
          type="button"
          role="switch"
          class="emb-sheet-row emb-sheet-switch"
          class:is-on={preferVariables}
          aria-checked={varsState.ariaChecked}
          onclick={toggleVariables}
        >
          <span class="emb-at" aria-hidden="true">@</span>
          <span class="emb-sheet-switch-text">
            <span>{$_('modeBar.vars.sheetLabel')}</span>
            <span class="emb-sheet-switch-hint">{$_(varsState.descriptionKey)}</span>
          </span>
          <span class="emb-track emb-track-lg" aria-hidden="true"
            ><span class="emb-knob"></span></span
          >
        </button>
      {/if}
    </div>
  </div>
{/if}

<ContextMenuWidget
  bind:__show={aiMenuShow}
  bind:__menuRef={aiMenuRef}
  __x={aiMenuX}
  __y={aiMenuY}
  __menuItems={aiMenuItems}
/>

<style lang="postcss">
  /* ------------------------------------------------------------ host
     The host sits just before the editor's scrolling shell. Documents: a
     zero-height block, the bar floats over the editor's top inline-end
     corner. Spreadsheets: a docked strip above the grid. */
  :global(.editor-mode-bar-host) {
    position: relative;
    z-index: 120;
    height: 0;
    flex: none;
    /* Local tokens, built on the app's theme variables. */
    --mb-surface: var(--panel, var(--color-base-100, #fff));
    --mb-line: var(--line, color-mix(in srgb, var(--color-base-content) 14%, transparent));
    --mb-text: var(--text, var(--color-base-content));
    /* --inert is the app's readable secondary text (6.3:1 light, 8:1 dark);
       --muted is too light for text on white. */
    --mb-text-2: var(--inert, color-mix(in srgb, var(--color-base-content) 75%, transparent));
    --mb-hover: var(--hover, color-mix(in srgb, var(--color-base-content) 8%, transparent));
    /* --accent is a fill colour (2.3:1 on white); --accent-text is the
       accent as text or as a control on a neutral surface. */
    --mb-accent-text: var(--accent-text, var(--accent));
    --mb-accent-soft: color-mix(in srgb, var(--accent) 12%, var(--mb-surface));
    --mb-accent-line: color-mix(in srgb, var(--accent) 45%, var(--mb-surface));
    --mb-switch-off: color-mix(in srgb, var(--mb-text) 52%, var(--mb-surface));
    --mb-review-bg: #fff7ed;
    --mb-review-text: #9a3412;
    --mb-review-line: #fed7aa;
    --mb-shadow: 0 6px 20px rgba(15, 23, 42, 0.1);
  }
  :global(:is([data-theme='dark'], .dark) .editor-mode-bar-host),
  :global(:is([data-theme='dark'], .dark) .emb-sheet-layer) {
    --mb-review-bg: rgba(251, 146, 60, 0.16);
    --mb-review-text: #fdba74;
    --mb-review-line: rgba(251, 146, 60, 0.45);
    --mb-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  :global(:root[data-doctype='sheets'] .editor-mode-bar-host) {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-inline: 8px;
    background: var(--mb-surface);
    border-bottom: 1px solid var(--mb-line);
  }

  :global(.editor-mode-bar-host.is-docked) {
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-inline: 20px;
    background: var(--bg, var(--color-base-200));
  }
  :global(.editor-mode-bar-host.is-docked) .emb {
    position: static;
  }
  /* The strip already spaces the page from the top: take most of the
     shell's own top padding back so the page moves down as little as
     possible. */
  :global(.editor-mode-bar-host.is-docked + .editor-shell) {
    padding-top: 12px;
  }

  /* ------------------------------------------------------------- bar */
  .emb {
    position: absolute;
    top: 12px;
    /* clears the shell's vertical scrollbar (BAR_INSET in the script) */
    inset-inline-end: 20px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background: var(--mb-surface);
    color: var(--mb-text);
    border: 1px solid var(--mb-line);
    border-radius: 12px;
    box-shadow: var(--mb-shadow);
    font-family: var(--brand-font-sans, system-ui, sans-serif);
    font-size: 13px;
    line-height: 1;
    white-space: nowrap;
  }
  :global(:root[data-doctype='sheets']) .emb {
    position: static;
    padding: 2px;
    border-radius: 10px;
    box-shadow: none;
  }

  .emb-anchor {
    position: relative;
    display: flex;
  }

  .emb-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding-inline: 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }
  :global(:root[data-doctype='sheets']) .emb-btn {
    height: 32px;
    padding-inline: 10px;
    gap: 6px;
  }
  .emb-btn:hover,
  .emb-btn.is-open {
    background: var(--mb-hover);
  }
  .emb-btn:focus-visible,
  .emb-menu-item:focus-visible,
  .emb-fab:focus-visible,
  .emb-fab-vars:focus-visible,
  .emb-segment:focus-visible,
  .emb-sheet-row:focus-visible,
  .emb-sheet-close:focus-visible {
    outline: 2px solid var(--mb-accent-text);
    outline-offset: 2px;
  }

  .emb-icon {
    font-size: 16px;
  }
  .emb-caret {
    font-size: 11px;
    opacity: 0.8;
  }
  .emb-sep {
    width: 1px;
    height: 22px;
    background: var(--mb-line);
    flex: none;
  }

  /* Suggest mode: orange tint, so being in review is visible at a glance. */
  .emb-mode.is-review,
  .emb-fab.is-review {
    background: var(--mb-review-bg);
    color: var(--mb-review-text);
    border-color: var(--mb-review-line);
  }

  /* ------------------------------------------------------- mode menu */
  .emb-menu {
    position: absolute;
    top: calc(100% + 8px);
    inset-inline-end: 0;
    width: 300px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--mb-surface);
    color: var(--mb-text);
    border: 1px solid var(--mb-line);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
    white-space: normal;
  }
  .emb-menu-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .emb-menu-item:hover {
    background: var(--mb-hover);
  }
  .emb-menu-item.is-active {
    background: var(--mb-accent-soft);
  }
  .emb-menu-icon {
    font-size: 18px;
    margin-top: 1px;
    color: var(--mb-accent-text);
  }
  .emb-menu-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .emb-menu-label {
    font-size: 14px;
    font-weight: 600;
  }
  .emb-menu-hint {
    font-size: 12px;
    line-height: 1.35;
    color: var(--mb-text-2);
  }
  .emb-menu-check {
    font-size: 14px;
    margin-top: 2px;
    color: var(--mb-accent-text);
  }

  /* ------------------------------------------------------- variables */
  .emb-at {
    font-size: 15px;
    font-weight: 700;
  }
  .emb-vars {
    color: var(--mb-text-2);
    border-color: var(--mb-line);
  }
  .emb-vars.is-on {
    color: var(--mb-accent-text);
    background: var(--mb-accent-soft);
    border-color: var(--mb-accent-line);
  }
  .emb-track {
    position: relative;
    flex: none;
    width: 30px;
    height: 18px;
    border-radius: 999px;
    background: var(--mb-switch-off);
    transition: background-color 120ms ease;
  }
  .emb-knob {
    position: absolute;
    top: 2px;
    inset-inline-start: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transition: inset-inline-start 120ms ease;
  }
  .is-on .emb-track {
    background: var(--mb-accent-text);
  }
  .is-on .emb-knob {
    inset-inline-start: 14px;
  }
  .emb-track-lg {
    width: 44px;
    height: 26px;
  }
  .emb-track-lg .emb-knob {
    top: 3px;
    inset-inline-start: 3px;
    width: 20px;
    height: 20px;
  }
  .is-on .emb-track-lg .emb-knob {
    inset-inline-start: 21px;
  }

  .emb-tip {
    position: absolute;
    top: calc(100% + 8px);
    inset-inline-end: 0;
    width: 280px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--mb-surface);
    color: var(--mb-text);
    border: 1px solid var(--mb-line);
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
    font-size: 12.5px;
    font-weight: 400;
    line-height: 1.45;
    white-space: normal;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity 120ms ease,
      visibility 120ms ease;
    z-index: 1;
  }
  .emb-tip strong {
    display: block;
    margin-bottom: 2px;
    font-weight: 600;
  }
  .emb-vars-anchor:hover .emb-tip,
  .emb-vars:focus-visible + .emb-tip {
    opacity: 1;
    visibility: visible;
    transition-delay: 350ms;
  }

  /* -------------------------------------------------------------- AI */
  .emb-ai {
    color: var(--mb-accent-text);
  }
  .emb-ai-icon {
    position: relative;
    display: inline-flex;
  }
  .emb-pulse {
    position: absolute;
    top: -3px;
    inset-inline-end: -4px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 80%, transparent);
    animation: mbPulse 1.2s infinite ease-in-out;
  }
  .emb-status {
    font-size: 12px;
    font-weight: 500;
    color: var(--mb-text-2);
  }
  @keyframes mbPulse {
    0% {
      transform: scale(0.85);
      opacity: 0.5;
    }
    60% {
      transform: scale(1.2);
      opacity: 1;
    }
    100% {
      transform: scale(0.9);
      opacity: 0.6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .emb-pulse {
      animation: none;
    }
  }

  /* --------------------------------------------------------- compact */
  .emb-compact {
    position: fixed;
    inset-inline-end: 16px;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    z-index: 130;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* In a spreadsheet even the compact controls stay in the docked strip. */
  :global(:root[data-doctype='sheets']) .emb-compact {
    position: static;
  }
  .emb-fab,
  .emb-fab-vars {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    border-radius: 999px;
    font: inherit;
    font-family: var(--brand-font-sans, system-ui, sans-serif);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  }
  :global(:root[data-doctype='sheets']) :is(.emb-fab, .emb-fab-vars) {
    height: 34px;
    font-size: 13px;
    box-shadow: none;
  }
  .emb-fab {
    padding-inline: 14px 18px;
    border: 1px solid transparent;
    background: var(--mb-accent-text);
    color: var(--mb-surface);
  }
  .emb-fab-vars {
    padding-inline: 14px;
    border: 1px solid var(--mb-line);
    background: var(--mb-surface);
    color: var(--mb-text-2);
  }
  .emb-fab-vars.is-on {
    color: var(--mb-accent-text);
    background: var(--mb-accent-soft);
    border-color: var(--mb-accent-line);
  }

  /* ----------------------------------------------------- bottom sheet */
  :global(.emb-sheet-layer) {
    position: fixed;
    inset: 0;
    z-index: 1100;
    --mb-surface: var(--panel, var(--color-base-100, #fff));
    --mb-line: var(--line, color-mix(in srgb, var(--color-base-content) 14%, transparent));
    --mb-text: var(--text, var(--color-base-content));
    --mb-text-2: var(--inert, color-mix(in srgb, var(--color-base-content) 75%, transparent));
    --mb-hover: var(--hover, color-mix(in srgb, var(--color-base-content) 8%, transparent));
    --mb-accent-text: var(--accent-text, var(--accent));
    --mb-accent-soft: color-mix(in srgb, var(--accent) 12%, var(--mb-surface));
    --mb-accent-line: color-mix(in srgb, var(--accent) 45%, var(--mb-surface));
    --mb-switch-off: color-mix(in srgb, var(--mb-text) 52%, var(--mb-surface));
    --mb-review-bg: #fff7ed;
    --mb-review-text: #9a3412;
    --mb-review-line: #fed7aa;
  }
  .emb-sheet-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgba(15, 23, 42, 0.3);
    cursor: default;
  }
  .emb-sheet {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    max-height: 85vh;
    overflow-y: auto;
    padding: 10px 12px calc(20px + env(safe-area-inset-bottom, 0px));
    background: var(--mb-surface);
    color: var(--mb-text);
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -12px 32px rgba(15, 23, 42, 0.18);
    font-family: var(--brand-font-sans, system-ui, sans-serif);
  }
  .emb-sheet:focus {
    outline: none;
  }
  .emb-sheet-grip {
    width: 40px;
    height: 5px;
    margin: 0 auto 6px;
    border-radius: 3px;
    background: var(--mb-line);
  }
  .emb-sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: 6px;
  }
  .emb-sheet-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .emb-sheet-close {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 12px;
    background: transparent;
    color: var(--mb-text-2);
    font-size: 20px;
    cursor: pointer;
  }
  .emb-sheet-section {
    padding: 12px 6px 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--mb-text-2);
  }
  .emb-sheet-section .emb-status {
    text-transform: none;
    letter-spacing: 0;
  }
  .emb-segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding-inline: 6px;
  }
  .emb-segment {
    min-height: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border-radius: 12px;
    border: 1px solid var(--mb-line);
    background: var(--mb-surface);
    color: var(--mb-text);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .emb-segment i {
    font-size: 18px;
  }
  .emb-segment.is-active {
    border-color: var(--mb-accent-text);
    background: var(--mb-accent-soft);
    color: var(--mb-accent-text);
  }
  .emb-segment.is-review {
    border-color: var(--mb-review-text);
    background: var(--mb-review-bg);
    color: var(--mb-review-text);
  }
  .emb-sheet-hint {
    margin: 8px 6px 0;
    font-size: 13px;
    color: var(--mb-text-2);
  }
  .emb-sheet-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding-inline: 10px;
    border: none;
    border-radius: 12px;
    background: transparent;
    color: var(--mb-text);
    font: inherit;
    font-size: 16px;
    text-align: start;
    cursor: pointer;
  }
  .emb-sheet-row i {
    font-size: 18px;
    color: var(--mb-accent-text);
  }
  .emb-sheet-row:hover:not([disabled]) {
    background: var(--mb-hover);
  }
  .emb-sheet-row[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .emb-sheet-row-end {
    margin-inline-start: auto;
  }
  .emb-sheet-switch {
    margin-top: 4px;
    background: var(--mb-hover);
  }
  .emb-sheet-switch .emb-at {
    color: var(--mb-accent-text);
  }
  .emb-sheet-switch-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
    padding-block: 8px;
  }
  .emb-sheet-switch-hint {
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--mb-text-2);
  }

  .emb-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
