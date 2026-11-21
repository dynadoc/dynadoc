<script lang="ts">
  // A slide drawn as static HTML from its Y.Doc: thumbnails and previews.
  // Redraws when the slide changes.
  import { onDestroy, onMount } from 'svelte'
  import { createSlide } from '../../collab/collab'
  import { toAssetUrl } from '../../../../../utils/assetUrl'
  import type { CollaborativeCanvas } from '../../../../../utils/canvas.types'
  import { readSlideData, renderSlideHtml } from '../../utils/slideContent'
  import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../../utils/slideDesign'

  interface Props {
    slideId: string
    src: string
    width?: number
  }

  let { slideId, src, width = 192 }: Props = $props()

  let _html = $state('')
  let _slideWidth = $state(SLIDE_WIDTH)
  let _slideHeight = $state(SLIDE_HEIGHT)
  let _canvas: CollaborativeCanvas | null = null
  let _raf = 0

  const redraw = (): void => {
    if (_raf) return
    _raf = requestAnimationFrame(() => {
      _raf = 0
      if (!_canvas) return
      const data = readSlideData(_canvas.ydoc)
      _slideWidth = data.width
      _slideHeight = data.height
      _html = renderSlideHtml(data, toAssetUrl)
    })
  }

  onMount(async () => {
    _canvas = await createSlide(slideId, src)
    await _canvas.load?.()
    _canvas.ydoc.on('update', redraw)
    redraw()
  })

  onDestroy(() => {
    if (_raf) cancelAnimationFrame(_raf)
    _canvas?.ydoc.off('update', redraw)
    _canvas?.release?.()
    _canvas = null
  })
</script>

<div class="slide-static-frame" style={`width:${width}px;height:${(width * _slideHeight) / _slideWidth}px`}>
  <div style={`transform:scale(${width / _slideWidth});transform-origin:0 0`}>
    <!-- Built by renderSlideHtml, which escapes every text and attribute value. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html _html}
  </div>
</div>

<style>
  .slide-static-frame {
    position: relative;
    overflow: hidden;
    pointer-events: none;
    background: #fff;
  }
  .slide-static-frame :global(.slide-static-text p),
  .slide-static-frame :global(.slide-static-text h1),
  .slide-static-frame :global(.slide-static-text h2),
  .slide-static-frame :global(.slide-static-text h3) {
    margin: 0 0 0.3em;
    line-height: 1.2;
  }
  .slide-static-frame :global(.slide-static-text h1) {
    font-size: 1em;
    font-weight: 700;
  }
  .slide-static-frame :global(.slide-static-text ul) {
    margin: 0;
    padding-left: 1.2em;
    list-style: disc;
  }
  .slide-static-frame :global(.slide-static-text ol) {
    margin: 0;
    padding-left: 1.2em;
    list-style: decimal;
  }
</style>
