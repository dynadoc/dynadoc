<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { DocumentContentType } from '../../../../models/Document'
  import EditorCommonUtils from '../../../../utils/common.utils'

  interface Props {
    prompt?: string
    selectedType?: DocumentContentType
  }

  let { prompt = $bindable(''), selectedType = 'text' }: Props = $props()

  let textareaEl = $state<HTMLTextAreaElement>()
  let showError = $state(false)

  // Grows with the text, up to 200 px.
  $effect(() => {
    if (textareaEl && prompt !== undefined) {
      textareaEl.style.height = 'auto'
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + 'px'
    }
  })

  const TYPES: Array<{ id: DocumentContentType; labelKey: string; icon: string }> = [
    { id: 'text', labelKey: 'Document', icon: 'ph-file-text' },
    { id: 'design', labelKey: 'Design', icon: 'ph-paint-brush-broad' },
    { id: 'slide', labelKey: 'Presentation', icon: 'ph-presentation-chart' },
    { id: 'sheet', labelKey: 'Spreadsheet', icon: 'ph-table' }
  ]

  // Les suggestions existantes, par type. Le libellé « Suggestions » ne
  // s'affiche que s'il y a quelque chose à suggérer ; un clic remplit le champ.
  const SUGGESTIONS: Partial<Record<DocumentContentType, string[]>> = {
    design: ['Modern Bakery Logo', 'Instagram Story Set'],
    slide: ['Q4 Financial Report', 'Product Pitch Deck']
  }
  let suggestions = $derived(SUGGESTIONS[selectedType] ?? [])

  async function onKeyDown(e: KeyboardEvent): Promise<void> {
    // CMD/CTRL + Enter to submit (standard pro-app behaviour)
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      await handleCreate()
    }
  }

  function useSuggestion(key: string): void {
    prompt = $_(key)
    showError = false
    textareaEl?.focus()
  }

  async function handleCreate(): Promise<void> {
    if (!prompt.trim()) {
      showError = true
      textareaEl?.focus()
      return
    }
    showError = false
    await EditorCommonUtils.addNewDocumentEditor(
      null,
      null,
      () => {},
      selectedType,
      'generative',
      prompt
    )
  }
</script>

<div class="dash-card flex flex-col gap-3">
  <div class="dash-seg self-start" role="group" aria-label={$_('Generate with AI')}>
    {#each TYPES as type (type.id)}
      <button
        class="dash-seg__item gen-type"
        class:dash-seg__item--on={selectedType === type.id}
        aria-pressed={selectedType === type.id}
        onclick={() => (selectedType = type.id)}
      >
        <i class="ph-light {type.icon} text-[15px]" aria-hidden="true"></i>
        {$_(type.labelKey)}
      </button>
    {/each}
  </div>

  <div class="gen-field" class:gen-field--error={showError}>
    <i class="ph-light ph-sparkle gen-field__icon text-[18px]" aria-hidden="true"></i>
    <textarea
      bind:this={textareaEl}
      bind:value={prompt}
      placeholder={$_('Describe what you want to create...')}
      aria-label={$_('Describe what you want to create...')}
      aria-invalid={showError}
      rows="1"
      oninput={() => (showError = false)}
      onkeydown={onKeyDown}
      class="gen-field__input"></textarea>
    <span class="gen-field__hint" aria-hidden="true">
      <kbd>⌘</kbd><kbd>{$_('RET')}</kbd>
    </span>
    <button class="dash-primary shrink-0" onclick={handleCreate}>
      <i class="ph-light ph-sparkle text-[15px]" aria-hidden="true"></i>
      {$_('Generate')}
    </button>
  </div>

  {#if showError}
    <p class="text-xs font-semibold text-error flex items-center gap-1.5" role="alert">
      <i class="ph-light ph-warning-circle text-[14px]" aria-hidden="true"></i>
      {$_('Please enter a description to generate')}
    </p>
  {/if}

  {#if suggestions.length}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-base-content/60">{$_('Suggestions:')}</span>
      {#each suggestions as key (key)}
        <button class="gen-chip" onclick={() => useSuggestion(key)}>{$_(key)}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .gen-type {
    width: auto;
    gap: 6px;
    display: inline-flex;
    align-items: center;
    padding: 0 12px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
  }

  /* Même matière que la recherche du tableau de bord : fond base-200,
     liseré base-300, surface claire et contour teal au focus. */
  .gen-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border-radius: 10px;
    border: 1px solid var(--color-base-300);
    background: var(--color-base-200);
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  .gen-field:focus-within {
    background: var(--color-base-100);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .gen-field--error,
  .gen-field--error:focus-within {
    border-color: var(--color-error);
  }

  .gen-field--error:focus-within {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-error) 18%, transparent);
  }

  .gen-field__icon {
    flex-shrink: 0;
    color: var(--accent-text);
  }

  .gen-field__input {
    flex: 1;
    min-width: 0;
    max-height: 200px;
    padding: 6px 0;
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--color-base-content);
    font: inherit;
    font-size: 15px;
    line-height: 1.5;
  }

  .gen-field__input::placeholder {
    color: color-mix(in srgb, var(--color-base-content) 60%, transparent);
    opacity: 1;
  }

  .gen-field__hint {
    display: inline-flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .gen-field__hint kbd {
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid var(--color-base-300);
    background: var(--color-base-100);
    color: color-mix(in srgb, var(--color-base-content) 65%, transparent);
    font-family: var(--brand-font-mono, ui-monospace, monospace);
    font-size: 10.5px;
  }

  .gen-chip {
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--color-base-300);
    background: var(--color-base-100);
    color: var(--color-base-content);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 150ms ease;
  }

  .gen-chip:hover {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .gen-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    .gen-field__hint {
      display: none;
    }
  }
</style>
