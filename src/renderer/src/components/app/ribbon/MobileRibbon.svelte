<script lang="ts">
  import { onDestroy } from 'svelte'
  import { _$_documentEditorsList } from '../../../stores/editor.store'
  import { GenericFormatingEditorCommands } from '../../common/actions/formatting'
  import { _ } from 'svelte-i18n'
  import { fluentUIcons } from '../../common/icons/Icons'

  type SheetAction = {
    icon?: string
    /** Raw SVG markup, used instead of `icon` when set */
    svg?: string
    label: string
    /** i18n key, used instead of `label` when set */
    labelKey?: string
    action: () => unknown
  }

  const quickActions = [
    {
      icon: 'ph-bold ph-arrow-counter-clockwise',
      label: 'Undo',
      action: () => GenericFormatingEditorCommands.undo()
    },
    {
      icon: 'ph-bold ph-arrow-clockwise',
      label: 'Redo',
      action: () => GenericFormatingEditorCommands.redo()
    },
    {
      icon: 'ph-bold ph-text-bolder',
      label: 'Bold',
      action: () => GenericFormatingEditorCommands.bold()
    },
    {
      icon: 'ph-bold ph-text-italic',
      label: 'Italic',
      action: () => GenericFormatingEditorCommands.italic()
    },
    {
      icon: 'ph-bold ph-list-bullets',
      label: 'Bullets',
      action: () => GenericFormatingEditorCommands.bulletList()
    }
  ]

  const moreActions: SheetAction[] = [
    {
      icon: 'ph-bold ph-image',
      label: 'Picture',
      action: () => GenericFormatingEditorCommands.insertImageFromDevice()
    },
    {
      icon: 'ph-bold ph-link',
      label: 'Include File',
      action: () => GenericFormatingEditorCommands.includeFile()
    },
    {
      icon: 'ph-bold ph-article',
      label: 'Append File',
      action: () => GenericFormatingEditorCommands.appendFile()
    },
    {
      icon: 'ph-bold ph-clipboard-text',
      label: 'Paste',
      action: () => GenericFormatingEditorCommands.paste()
    },
    {
      icon: 'ph-bold ph-magnifying-glass',
      label: 'Search',
      action: () => GenericFormatingEditorCommands.search()
    },
    {
      icon: 'ph-bold ph-translate',
      label: 'Translate',
      action: () => GenericFormatingEditorCommands.openTranslatePane()
    },
    // Paragraph direction: the desktop ribbon's Paragraph group is not shown
    // on narrow windows, so its LTR / RTL buttons live here (dynadoc#94).
    {
      svg: fluentUIcons.fluentUIconTextParagraphDirectionLeft,
      label: 'Paragraph Direction Left',
      labelKey: 'Paragraph Direction Left',
      action: () => GenericFormatingEditorCommands.setDirectionLTR()
    },
    {
      svg: fluentUIcons.fluentUIconTextParagraphDirectionRight,
      label: 'Paragraph Direction Right',
      labelKey: 'Paragraph Direction Right',
      action: () => GenericFormatingEditorCommands.setDirectionRTL()
    },
    {
      svg: fluentUIcons.fluentUIconTextParagraphDirection,
      label: 'Paragraph Direction',
      labelKey: 'Paragraph Direction',
      action: () => GenericFormatingEditorCommands.toggleDirection()
    }
  ]

  // The app compiles Svelte with runes on: a plain `let` is not reactive, so
  // the More sheet never opened (dynadoc#94).
  let showMore = $state(false)
  let activeEditorName = $state('')

  const activeStore = _$_documentEditorsList.getActive()
  const unsub = activeStore.subscribe((entry) => {
    activeEditorName = entry?.document?.name || ''
  })

  onDestroy(() => {
    unsub?.()
  })
</script>

<div class="mobile-ribbon">
  <div class="mobile-ribbon-bar">
    {#each quickActions as item (item.label)}
      <button class="mobile-ribbon-btn" onclick={item.action} aria-label={item.label}>
        <i class={item.icon}></i>
        <span>{item.label}</span>
      </button>
    {/each}

    <button
      class="mobile-ribbon-btn is-more"
      aria-expanded={showMore}
      onclick={() => (showMore = !showMore)}
    >
      <i class="ph-bold ph-dots-three-outline"></i>
      <span>{$_('More')}</span>
    </button>
  </div>

  {#if showMore}
    <div class="mobile-ribbon-sheet" role="presentation" onclick={() => (showMore = false)}>
      <div class="sheet-card" role="presentation" onclick={(event) => event.stopPropagation()}>
        <div class="sheet-header">
          <span>{$_('Quick Tools')}</span>
          <button onclick={() => (showMore = false)} class="close-btn" aria-label={$_('Close')}>
            <i class="ph-bold ph-x"></i>
          </button>
        </div>
        <div class="sheet-grid">
          {#each moreActions as item (item.label)}
            <button
              class="sheet-item"
              onclick={() => {
                item.action()
                showMore = false
              }}
            >
              {#if item.svg}
                <!-- bundled Fluent UI icon markup, not user content -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <span class="sheet-item-svg" aria-hidden="true">{@html item.svg}</span>
              {:else}
                <i class={item.icon}></i>
              {/if}
              <span>{item.labelKey ? $_(item.labelKey) : item.label}</span>
            </button>
          {/each}
        </div>
        <div class="sheet-footer">
          <span class="text-xs opacity-60">Active: {activeEditorName || 'Document'}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style lang="postcss">
  .mobile-ribbon {
    position: sticky;
    bottom: 0;
    z-index: 50;
    background: #141414;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .mobile-ribbon-bar {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 6px;
    padding: 8px 10px;
  }
  .mobile-ribbon-btn {
    @apply flex flex-col items-center gap-1 rounded-md text-[var(--color-base-content)]/70 text-[10px] py-2 bg-[color-mix(in_srgb,var(--color-base-white)_5%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-base-white)_10%,transparent)];
  }
  .mobile-ribbon-btn i {
    font-size: 18px;
  }
  .mobile-ribbon-btn.is-more {
    background: rgba(0, 190, 172, 0.2);
    color: #9ff6ec;
  }
  .mobile-ribbon-sheet {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: flex-end;
    z-index: 60;
  }
  .sheet-card {
    width: 100%;
    background: #1b1b1b;
    border-radius: 16px 16px 0 0;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    max-height: 70vh;
    overflow-y: auto;
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 12px;
  }
  .sheet-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .sheet-item {
    @apply flex flex-col items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--color-base-white)_5%,transparent)] py-3 text-xs text-[var(--color-base-content)]/80;
  }
  .sheet-item i {
    font-size: 20px;
  }
  .sheet-item-svg {
    display: inline-flex;
    width: 20px;
    height: 20px;
  }
  .sheet-item-svg :global(svg) {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }
  .close-btn {
    @apply text-[var(--color-base-content)]/60 hover:text-[var(--color-base-content)];
  }
  .sheet-footer {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
  }
  @media (min-width: 768px) {
    .mobile-ribbon {
      display: none;
    }
  }
</style>
