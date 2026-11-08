<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { DocumentContentType } from '../../../models/Document'
  import EditorCommonUtils from '../../../utils/common.utils'
  import GenerativeCreationBar from './components/GenerativeCreationBar.svelte'

  // Même grammaire que les actions de création du tableau de bord : une
  // couleur par type (--brand-tile-* sur --brand-tint-*), libellé sur la
  // couleur de texte normale.
  interface CreationType {
    id: DocumentContentType
    labelKey: string
    subKey: string
    icon: string
    tile: string
    tint: string
  }

  const creationTypes: CreationType[] = [
    {
      id: 'text',
      labelKey: 'Document',
      subKey: 'Standard Text',
      icon: 'ph-file-text',
      tile: 'var(--brand-tile-document)',
      tint: 'var(--brand-tint-document)'
    },
    {
      id: 'sheet',
      // 'Spreadsheet', comme sur le tableau de bord ; 'Worksheet' affichait
      // un autre nom pour le même type.
      labelKey: 'Spreadsheet',
      subKey: 'Data & Formulas',
      icon: 'ph-table',
      tile: 'var(--brand-tile-spreadsheet)',
      tint: 'var(--brand-tint-spreadsheet)'
    },
    {
      id: 'slide',
      labelKey: 'Presentation',
      subKey: 'Animated Slides',
      icon: 'ph-presentation-chart',
      tile: 'var(--brand-tile-presentation)',
      tint: 'var(--brand-tint-presentation)'
    },
    {
      id: 'design',
      labelKey: 'Design',
      subKey: 'Layers & Vector',
      icon: 'ph-paint-brush-broad',
      tile: 'var(--brand-tile-design)',
      tint: 'var(--brand-tint-design)'
    },
    {
      id: 'form',
      labelKey: 'Form',
      subKey: 'Quiz & Surveys',
      icon: 'ph-textbox',
      tile: 'var(--brand-tile-form)',
      tint: 'var(--brand-tint-form)'
    },
    {
      id: 'meeting',
      labelKey: 'Meeting',
      subKey: 'Online Meetings',
      icon: 'ph-video-camera',
      tile: 'var(--brand-tile-meeting)',
      tint: 'var(--brand-tint-meeting)'
    }
  ]

  const typeById = Object.fromEntries(creationTypes.map((type) => [type.id, type])) as Record<
    string,
    CreationType
  >

  // Les catégories filtrent vraiment. Les vignettes sont dessinées sur place
  // (icône du type sur sa teinte) : plus de requête vers placehold.co.
  const categories = ['All', 'Marketing', 'Education', 'Business', 'Personal'] as const
  type Category = (typeof categories)[number]

  const templates: Array<{
    id: number
    titleKey: string
    type: DocumentContentType
    category: Exclude<Category, 'All'>
  }> = [
    { id: 1, titleKey: 'Annual Business Report', type: 'text', category: 'Business' },
    { id: 2, titleKey: 'Social Media Kit', type: 'design', category: 'Marketing' },
    { id: 3, titleKey: 'Product Pitch Deck', type: 'slide', category: 'Marketing' },
    { id: 4, titleKey: 'Financial Forecast', type: 'sheet', category: 'Business' }
  ]

  let selectedCategory = $state<Category>('All')

  let filteredTemplates = $derived(
    selectedCategory === 'All'
      ? templates
      : templates.filter((template) => template.category === selectedCategory)
  )

  async function handleOnClick(type: DocumentContentType): Promise<void> {
    await EditorCommonUtils.addNewDocumentEditor(null, null, () => {}, type)
  }
</script>

<div class="nd brand-ui min-h-full bg-base-200 text-base-content font-sans">
  <div class="max-w-[1180px] mx-auto px-8 py-8 flex flex-col gap-9">
    <header>
      <h1 class="text-[28px] font-semibold tracking-tight leading-tight">
        {$_('New Document')}
      </h1>
      <p class="text-sm text-base-content/60 mt-1">
        {$_('Select a canvas, generate a document or search for a professional template.')}
      </p>
    </header>

    <!-- Partir de zéro : le geste le plus fréquent, en premier. -->
    <section>
      <h2 class="nd-label">{$_('Start from scratch')}</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each creationTypes as type (type.id)}
          <button
            class="dash-create nd-blank"
            data-kind={type.id}
            style="--tile:{type.tile}; --tint:{type.tint}"
            onclick={() => handleOnClick(type.id)}
          >
            <span class="dash-create__icon" aria-hidden="true">
              <i class="ph-light {type.icon} text-[20px]"></i>
            </span>
            <span class="min-w-0 flex-1 text-left">
              <span class="block text-sm font-semibold truncate">{$_(type.labelKey)}</span>
              <span class="block text-xs text-base-content/60 truncate mt-0.5">
                {$_(type.subKey)}
              </span>
            </span>
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="nd-label">{$_('Generate with AI')}</h2>
      <GenerativeCreationBar />
    </section>

    <section>
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 class="nd-label !mb-0">{$_('Templates')}</h2>
        <div class="flex flex-wrap items-center gap-3">
          <div class="dash-seg" role="group" aria-label={$_('Templates')}>
            {#each categories as category (category)}
              <button
                class="dash-seg__item nd-seg-text"
                class:dash-seg__item--on={selectedCategory === category}
                aria-pressed={selectedCategory === category}
                onclick={() => (selectedCategory = category)}
              >
                {$_(category)}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {#each filteredTemplates as template (template.id)}
          {@const type = typeById[template.type]}
          <div class="nd-template" style="--tile:{type.tile}; --tint:{type.tint}">
            <div class="nd-template__thumb">
              <i class="ph-light {type.icon} text-[40px]" aria-hidden="true"></i>
              <div class="nd-template__overlay">
                <button class="dash-primary" onclick={() => handleOnClick(template.type)}>
                  {$_('Use Template')}
                </button>
                <button class="nd-template__secondary">{$_('Quick Preview')}</button>
              </div>
            </div>
            <div class="px-3 py-2.5">
              <div class="text-sm font-semibold truncate">{$_(template.titleKey)}</div>
              <div class="text-xs text-base-content/60 mt-0.5">{$_(type.labelKey)}</div>
            </div>
          </div>
        {:else}
          <div class="dash-empty col-span-full">
            <i class="ph-light ph-layout text-2xl opacity-40" aria-hidden="true"></i>
            <p class="text-xs text-base-content/60 mt-2">
              {$_('No templates in this category yet.')}
            </p>
          </div>
        {/each}

        <button class="nd-template nd-template--add">
          <i class="ph-light ph-plus text-[22px]" aria-hidden="true"></i>
          <span class="text-xs font-semibold mt-2">{$_('Add Custom')}</span>
        </button>
      </div>
    </section>
  </div>
</div>

<style>
  .nd-label {
    margin-bottom: 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--color-base-content) 65%, transparent);
  }

  /* Les tuiles vierges sont l'action principale de l'écran : une surface et
     un sous-titre, là où le tableau de bord n'a qu'une rangée de raccourcis. */
  .nd-blank {
    padding: 14px 16px;
    border-color: var(--color-base-300);
    background: var(--color-base-100);
    box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
  }

  .nd-seg-text {
    width: auto;
    padding: 0 12px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
  }

  .nd-template {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 12px;
    border: 1px solid var(--color-base-300);
    background: var(--color-base-100);
    box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
    transition:
      border-color 180ms ease,
      box-shadow 180ms ease;
  }

  .nd-template:hover,
  .nd-template:focus-within {
    border-color: color-mix(in srgb, var(--tile, var(--accent)) 45%, transparent);
    box-shadow: 0 8px 20px -10px rgb(16 24 40 / 0.25);
  }

  .nd-template__thumb {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 4 / 3;
    background: var(--tint);
    color: var(--tile);
  }

  .nd-template__overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: color-mix(in srgb, var(--color-base-100) 82%, transparent);
    opacity: 0;
    transition: opacity 180ms ease;
  }

  .nd-template:hover .nd-template__overlay,
  .nd-template:focus-within .nd-template__overlay {
    opacity: 1;
  }

  .nd-template__secondary {
    border: 0;
    background: transparent;
    color: var(--color-base-content);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .nd-template__secondary:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .nd-template--add {
    align-items: center;
    justify-content: center;
    min-height: 100%;
    border-style: dashed;
    background: transparent;
    box-shadow: none;
    color: color-mix(in srgb, var(--color-base-content) 65%, transparent);
    cursor: pointer;
  }

  .nd-template--add:hover {
    color: var(--color-base-content);
    border-color: color-mix(in srgb, var(--color-base-content) 30%, transparent);
    box-shadow: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .nd-template,
    .nd-template__overlay {
      transition: none;
    }
  }
</style>
