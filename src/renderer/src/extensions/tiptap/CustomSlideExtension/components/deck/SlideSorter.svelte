<script lang="ts">
  // Slide sorter of a presentation: thumbnails in deck order, drag or move
  // up/down to reorder, add (with a layout), duplicate, delete; plus the
  // slide toolbar (text box, shapes, image, layout, theme).
  import { _ } from 'svelte-i18n'
  import { onDestroy, onMount } from 'svelte'
  import type { Editor } from '@tiptap/core'
  import SlideStatic from './SlideStatic.svelte'
  import { _$_currentSlideId } from '../../stores/slide.store'
  import { ShapeType } from '../../../../../utils/canvas.types'
  import {
    addSlide,
    applyDeckTheme,
    deleteSlide,
    duplicateSlide,
    insertImageIntoSlide,
    insertIntoSlide,
    listDeckSlides,
    moveSlide,
    selectSlide,
    setSlideLayout,
    type DeckSlide,
    type SlideInsertKind
  } from '../../utils/slideDeckCommands'
  import { SLIDE_LAYOUTS, SLIDE_THEMES, type SlideLayoutId } from '../../utils/slideDesign'
  import { startSlideShow } from '../../utils/slideShow'

  interface Props {
    editor: Editor
    editorId: string
  }

  let { editor, editorId }: Props = $props()

  let _slides: { id: string; src: string }[] = $state([])
  let _dragFrom: number | null = $state(null)
  let _dropAt: number | null = $state(null)
  let _menu: 'new' | 'layout' | 'theme' | null = $state(null)
  let _imageInput: HTMLInputElement | null = $state(null)

  const _currentIndex = $derived(_slides.findIndex((s) => s.id === $_$_currentSlideId))

  const refresh = (): void => {
    const next = listDeckSlides(editor).map(({ id, src }) => ({ id, src }))
    const same =
      next.length === _slides.length &&
      next.every((s, i) => s.id === _slides[i].id && s.src === _slides[i].src)
    if (!same) _slides = next
    if (_slides.length && !_slides.some((s) => s.id === $_$_currentSlideId)) {
      _$_currentSlideId.set(_slides[0].id)
    }
  }

  const current = (): DeckSlide | null => {
    const slides = listDeckSlides(editor)
    return slides.find((s) => s.id === $_$_currentSlideId) ?? slides[0] ?? null
  }

  function goTo(id: string): void {
    selectSlide(editorId, id)
    const slide = listDeckSlides(editor).find((s) => s.id === id)
    if (!slide) return
    const dom = editor.view.nodeDOM(slide.pos) as HTMLElement | null
    dom?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  async function newSlide(layout: SlideLayoutId): Promise<void> {
    _menu = null
    const index = _currentIndex === -1 ? _slides.length - 1 : _currentIndex
    const id = await addSlide(editor, editorId, layout, index)
    requestAnimationFrame(() => goTo(id))
  }

  async function duplicate(id: string): Promise<void> {
    const newId = await duplicateSlide(editor, editorId, id)
    if (newId) requestAnimationFrame(() => goTo(newId))
  }

  function move(index: number, delta: number): void {
    const to = index + delta
    if (to < 0 || to >= _slides.length) return
    moveSlide(editor, index, to)
  }

  function remove(id: string): void {
    if (_slides.length <= 1) return
    deleteSlide(editor, id)
  }

  async function insert(kind: SlideInsertKind): Promise<void> {
    const slide = current()
    if (slide) await insertIntoSlide(slide, kind)
  }

  async function onImagePicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    const slide = current()
    if (file && slide) await insertImageIntoSlide(slide, editorId, file)
    input.value = ''
  }

  async function layout(id: SlideLayoutId): Promise<void> {
    _menu = null
    const slide = current()
    if (slide) await setSlideLayout(slide, id)
  }

  async function theme(id: string): Promise<void> {
    _menu = null
    await applyDeckTheme(editor, id)
  }

  function onDragStart(event: DragEvent, index: number): void {
    _dragFrom = index
    event.dataTransfer?.setData('text/plain', String(index))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(event: DragEvent, index: number): void {
    if (_dragFrom === null) return
    event.preventDefault()
    _dropAt = index
  }

  function onDrop(event: DragEvent, index: number): void {
    event.preventDefault()
    if (_dragFrom !== null && _dragFrom !== index) moveSlide(editor, _dragFrom, index)
    _dragFrom = null
    _dropAt = null
  }

  function onKeyDown(event: KeyboardEvent): void {
    const id = $_$_currentSlideId
    if (!id || _currentIndex === -1) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      remove(id)
    } else if (event.key === 'ArrowUp' && event.altKey) {
      event.preventDefault()
      move(_currentIndex, -1)
    } else if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      move(_currentIndex, 1)
    } else if (event.key === 'ArrowUp' && _currentIndex > 0) {
      event.preventDefault()
      goTo(_slides[_currentIndex - 1].id)
    } else if (event.key === 'ArrowDown' && _currentIndex < _slides.length - 1) {
      event.preventDefault()
      goTo(_slides[_currentIndex + 1].id)
    }
  }

  onMount(() => {
    refresh()
    editor.on('update', refresh)
  })

  onDestroy(() => {
    editor.off('update', refresh)
  })
</script>

<aside class="slide-sorter" aria-label={$_('Slides')}>
  <div class="sorter-toolbar">
    <div class="tool-group">
      <div class="menu-anchor">
        <button
          class="tool primary"
          data-action="new-slide"
          title={$_('New slide')}
          onclick={() => (_menu = _menu === 'new' ? null : 'new')}
        >
          <i class="ph-light ph-plus"></i>
          <span>{$_('New slide')}</span>
        </button>
        {#if _menu === 'new'}
          <div class="menu" role="menu">
            {#each SLIDE_LAYOUTS as item (item.id)}
              <button role="menuitem" data-layout={item.id} onclick={() => newSlide(item.id)}
                >{$_(item.name)}</button
              >
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <div class="tool-group">
      <button class="tool" data-insert="text" title={$_('Text box')} onclick={() => insert('text')}>
        <i class="ph-light ph-text-t"></i>
      </button>
      <button
        class="tool"
        data-insert="rect"
        title={$_('Rectangle')}
        onclick={() => insert(ShapeType.Rect)}
      >
        <i class="ph-light ph-square"></i>
      </button>
      <button
        class="tool"
        data-insert="ellipse"
        title={$_('Ellipse')}
        onclick={() => insert(ShapeType.Ellipse)}
      >
        <i class="ph-light ph-circle"></i>
      </button>
      <button
        class="tool"
        data-insert="triangle"
        title={$_('Triangle')}
        onclick={() => insert(ShapeType.Triangle)}
      >
        <i class="ph-light ph-triangle"></i>
      </button>
      <button
        class="tool"
        data-insert="line"
        title={$_('Line')}
        onclick={() => insert(ShapeType.Line)}
      >
        <i class="ph-light ph-line-segment"></i>
      </button>
      <button
        class="tool"
        data-insert="image"
        title={$_('Image')}
        onclick={() => _imageInput?.click()}
      >
        <i class="ph-light ph-image"></i>
      </button>
      <input
        bind:this={_imageInput}
        type="file"
        accept="image/*"
        class="hidden-input"
        onchange={onImagePicked}
      />
    </div>
    <div class="tool-group">
      <button
        class="tool"
        data-action="present-start"
        title={$_('Present from the first slide')}
        onclick={() => startSlideShow(editor, editorId, 'start')}
      >
        <i class="ph-light ph-play"></i>
        <span>{$_('Present')}</span>
      </button>
      <button
        class="tool"
        data-action="present-current"
        title={$_('Present from the current slide')}
        onclick={() => startSlideShow(editor, editorId, 'current')}
      >
        <i class="ph-light ph-presentation"></i>
      </button>
    </div>
    <div class="tool-group">
      <div class="menu-anchor">
        <button
          class="tool"
          data-action="layout"
          title={$_('Slide layout')}
          onclick={() => (_menu = _menu === 'layout' ? null : 'layout')}
        >
          <i class="ph-light ph-layout"></i>
          <span>{$_('Layout')}</span>
        </button>
        {#if _menu === 'layout'}
          <div class="menu" role="menu">
            {#each SLIDE_LAYOUTS as item (item.id)}
              <button role="menuitem" data-layout={item.id} onclick={() => layout(item.id)}
                >{$_(item.name)}</button
              >
            {/each}
          </div>
        {/if}
      </div>
      <div class="menu-anchor">
        <button
          class="tool"
          data-action="theme"
          title={$_('Theme')}
          onclick={() => (_menu = _menu === 'theme' ? null : 'theme')}
        >
          <i class="ph-light ph-palette"></i>
          <span>{$_('Theme')}</span>
        </button>
        {#if _menu === 'theme'}
          <div class="menu" role="menu">
            {#each SLIDE_THEMES as item (item.id)}
              <button role="menuitem" data-theme-id={item.id} onclick={() => theme(item.id)}>
                <span
                  class="swatch"
                  style={`background:${item.background};border-color:${item.accent}`}
                ></span>
                <span style={`font-family:${item.titleFont}`}>{$_(item.name)}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <ol class="sorter-list" tabindex="0" onkeydown={onKeyDown}>
    {#each _slides as slide, index (slide.id)}
      <li
        class="sorter-item"
        class:current={slide.id === $_$_currentSlideId}
        class:drop-before={_dropAt === index && _dragFrom !== null && _dragFrom > index}
        class:drop-after={_dropAt === index && _dragFrom !== null && _dragFrom < index}
        data-slide-id={slide.id}
        draggable="true"
        ondragstart={(e) => onDragStart(e, index)}
        ondragover={(e) => onDragOver(e, index)}
        ondrop={(e) => onDrop(e, index)}
        ondragend={() => {
          _dragFrom = null
          _dropAt = null
        }}
      >
        <span class="number">{index + 1}</span>
        <button
          class="thumb"
          onclick={() => goTo(slide.id)}
          title={$_('Slide') + ' ' + (index + 1)}
        >
          <SlideStatic slideId={slide.id} src={slide.src} width={160} {editorId} />
        </button>
        <div class="item-actions">
          <button
            title={$_('Move up')}
            data-action="up"
            disabled={index === 0}
            onclick={() => move(index, -1)}><i class="ph-light ph-arrow-up"></i></button
          >
          <button
            title={$_('Move down')}
            data-action="down"
            disabled={index === _slides.length - 1}
            onclick={() => move(index, 1)}><i class="ph-light ph-arrow-down"></i></button
          >
          <button
            title={$_('Duplicate slide')}
            data-action="duplicate"
            onclick={() => duplicate(slide.id)}><i class="ph-light ph-copy"></i></button
          >
          <button
            title={$_('Delete slide')}
            data-action="delete"
            disabled={_slides.length <= 1}
            onclick={() => remove(slide.id)}><i class="ph-light ph-trash"></i></button
          >
        </div>
      </li>
    {/each}
  </ol>
</aside>

<style>
  .slide-sorter {
    width: 212px;
    flex: 0 0 212px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--color-base-300, #e5e7eb);
    background: var(--color-base-100, #f8fafc);
  }
  .sorter-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--color-base-300, #e5e7eb);
  }
  .tool-group {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--color-base-content, #1f2937);
  }
  .tool:hover {
    background: var(--color-base-200, #e5e7eb);
  }
  .tool.primary {
    background: var(--brand-tile-presentation, #ea580c);
    color: #fff;
  }
  .tool i {
    font-size: 16px;
  }
  .menu-anchor {
    position: relative;
  }
  .menu {
    position: absolute;
    top: 30px;
    left: 0;
    z-index: 60;
    min-width: 170px;
    padding: 4px;
    border-radius: 8px;
    background: var(--color-base-100, #fff);
    border: 1px solid var(--color-base-300, #e5e7eb);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
  }
  .menu button:hover {
    background: var(--color-base-200, #e5e7eb);
  }
  .swatch {
    width: 16px;
    height: 12px;
    border: 2px solid;
    border-radius: 3px;
  }
  .hidden-input {
    display: none;
  }
  .sorter-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px 24px;
    outline: none;
  }
  .sorter-item {
    position: relative;
    display: flex;
    gap: 6px;
    padding: 6px 4px;
    border-radius: 8px;
  }
  .sorter-item.drop-before {
    box-shadow: 0 -3px 0 0 var(--brand-tile-presentation, #ea580c);
  }
  .sorter-item.drop-after {
    box-shadow: 0 3px 0 0 var(--brand-tile-presentation, #ea580c);
  }
  .number {
    width: 16px;
    font-size: 11px;
    text-align: right;
    color: var(--color-base-content-600, #6b7280);
  }
  .thumb {
    border: 2px solid transparent;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  }
  .sorter-item.current .thumb {
    border-color: var(--brand-tile-presentation, #ea580c);
  }
  .item-actions {
    position: absolute;
    right: 8px;
    bottom: 10px;
    display: none;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: rgba(17, 24, 39, 0.75);
  }
  .sorter-item:hover .item-actions,
  .sorter-item.current .item-actions {
    display: flex;
  }
  .item-actions button {
    width: 22px;
    height: 22px;
    color: #fff;
    border-radius: 4px;
  }
  .item-actions button:disabled {
    opacity: 0.35;
  }
  .item-actions button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }
</style>
