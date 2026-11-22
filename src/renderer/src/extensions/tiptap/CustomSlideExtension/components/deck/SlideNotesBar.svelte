<script lang="ts">
  // Speaker notes (and comments) of the deck's current slide, under the editor.
  import { _ } from 'svelte-i18n'
  import { onDestroy } from 'svelte'
  import type { Editor } from '@tiptap/core'
  import type * as Y from 'yjs'
  import SlideNotesPanel from '../slides/SlideNotesPanel.svelte'
  import { createSlide } from '../../collab/collab'
  import { _$_currentSlideId } from '../../stores/slide.store'
  import { listDeckSlides } from '../../utils/slideDeckCommands'
  import type { CollaborativeCanvas } from '../../../../../utils/canvas.types'

  let { editor }: { editor: Editor } = $props()

  let _open = $state(false)
  let _meta: Y.Map<unknown> | null = $state(null)
  let _canvas: CollaborativeCanvas | null = null
  let _loading = 0

  const load = async (id: string | null): Promise<void> => {
    const ticket = ++_loading
    _canvas?.release?.()
    _canvas = null
    _meta = null
    const slide = listDeckSlides(editor).find((s) => s.id === id)
    if (!slide) return
    const canvas = await createSlide(slide.id, slide.src)
    await canvas.load?.()
    if (ticket !== _loading) {
      canvas.release?.()
      return
    }
    _canvas = canvas
    _meta = canvas.meta
  }

  $effect(() => {
    void load($_$_currentSlideId)
  })

  onDestroy(() => {
    _loading++
    _canvas?.release?.()
  })
</script>

<section class="slide-notes-bar" class:open={_open}>
  <button class="notes-toggle" onclick={() => (_open = !_open)}>
    <i class="ph-light {_open ? 'ph-caret-down' : 'ph-caret-up'}"></i>
    {$_('Notes')}
  </button>
  {#if _open && _meta}
    {#key _meta}
      <SlideNotesPanel __meta={_meta} />
    {/key}
  {/if}
</section>

<style>
  .slide-notes-bar {
    flex: 0 0 auto;
    max-height: 230px;
    overflow-y: auto;
    /* The status bar is fixed over the bottom 30px of the window. */
    padding: 6px 16px 36px;
    background: #111827;
    color: #e5e7eb;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .notes-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
  }
  .slide-notes-bar :global(.slide-notes-panel) {
    margin-top: 6px;
    padding-top: 6px;
  }
  .slide-notes-bar :global(.notes-input) {
    min-height: 52px;
  }
</style>
