<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onDestroy, onMount } from 'svelte'
  import SlideViewport from './SlideViewport.svelte'
  import Platform from '../../../../libs/platform'
  import {
    bufferedSlides,
    nextSlide,
    previousSlide,
    presentation,
    syncFromPayload
  } from '../store/presentation.store'
  import type { PresentationPayload } from '../../../../utils/shared.type'

  // export let editorRoot: HTMLElement
  // let { payload } = $props();

  // let payload: PresentationPayload | null = $state(null)
  let payload = $state<PresentationPayload>(null)

  /* onMount(() => {
    console.log('resentationAPI.onMount', { })
    // snapshotKonva(editorRoot);
    window.presentationAPI.onData((data) => {
      console.log('resentationAPI.onData', { data })
      payload = data
      // currentIndex = data.currentIndex
      totalSlides.set(payload.pageCount)

      presentation.update((p) => ({
        ...p,
        active: true
      }))
    })
    window.presentationAPI.onUpdate((data) => {
      console.log('resentationAPI.onUpdate', { data })

      payload = data
      // currentIndex = data.currentIndex
      totalSlides.set(payload.pageCount)

      presentation.update((p) => ({
        ...p,
        active: true
      }))
    })

    // const breaks = editorRoot.querySelectorAll('.rm-page-break')
    // totalSlides.set(breaks.length + 1)

    // editorHTML = editorRoot.innerHTML

    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') next()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'Escape') exit()
      console.log('keydown , ', { e, payload, currentIndex })
    })
  }) */

  onMount(() => {
    console.log('resentationAPI.onMount', {})
    // snapshotKonva(editorRoot);

    // main.ts waits for the driver before mounting this window (#150); an
    // exception here would also break Svelte's effect flush, so say it instead.
    if (!window.presentationAPI) {
      console.error(
        'Slideshow: window.presentationAPI is missing, the platform driver did not load'
      )
      return
    }

    if (typeof window.presentationAPI.getInitialData === 'function') {
      window.presentationAPI
        .getInitialData()
        .then((data) => {
          if (data) {
            console.log('presentationAPI.getInitialData success', { data })
            payload = data
            syncFromPayload(payload)
          }
        })
        .catch((err) => {
          console.error('Failed to get initial presentation data:', err)
        })
    }

    window.presentationAPI.onData((data) => {
      console.log('resentationAPI.onData', { data })
      payload = data
      syncFromPayload(payload)
    })
    window.presentationAPI.onUpdate((data) => {
      console.log('resentationAPI.onUpdate', { data })

      payload = data
      syncFromPayload(payload)
    })

    // const breaks = editorRoot.querySelectorAll('.rm-page-break')
    // totalSlides.set(breaks.length + 1)

    // editorHTML = editorRoot.innerHTML

    /* window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        window.presentationAPI.navigate(currentIndex + 1)
      }
      // if (e.key === 'ArrowRight' || e.key === ' ') next()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'Escape') exit()
      console.log('keydown , ', { e, payload, currentIndex })
    }) */

    // let currentIndex = 0

    const onKeyDown = (e: KeyboardEvent) => {
      if (!payload) return

      switch (e.key) {
        case ' ':
        case 'ArrowRight':
          e.preventDefault()
          // window.presentationAPI.navigate(currentIndex + 1)
          nextSlide()
          break

        case 'ArrowLeft':
          e.preventDefault()
          // window.presentationAPI.navigate(currentIndex - 1)
          previousSlide()

          break

        case 'PageDown':
          e.preventDefault()
          nextSlide()
          break

        case 'PageUp':
          e.preventDefault()
          previousSlide()
          break

        case 'Home':
          e.preventDefault()
          window.presentationAPI.navigate(0)
          break

        case 'End':
          e.preventDefault()
          window.presentationAPI.navigate((payload.pageCount || 1) - 1)
          break

        case 'Escape':
          exit()
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    const onResize = (): void => {
      _viewport = { width: window.innerWidth, height: window.innerHeight }
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  })

  onDestroy(() => {
    presentation.update((p) => ({
      ...p,
      active: false
    }))
  })

  function exit() {
    window.presentationAPI?.stop('all')
    // The desktop closes its window from the main process. On the web this
    // is a window the app opened, which a script may close.
    if (!Platform.isDesktopPlatform) window.close()
  }

  // The page keeps its own size and is scaled to fill the window.
  let _viewport = $state({ width: window.innerWidth, height: window.innerHeight })
  const _fit = $derived(
    payload
      ? Math.min(_viewport.width / payload.pageWidth, _viewport.height / payload.pageHeight)
      : 1
  )
</script>

{#if payload}
  <!-- <div class="presentation-root"> -->
  <div class="fixed inset-0 bg-black flex justify-center items-center">
    <div
      class="relative w-[{payload.pageWidth}px] h-[{payload.pageHeight}px] overflow-hidden bg-[color-mix(in_srgb,var(--color-base-white)_100%,transparent)] shadow-2xl"
      style="width:{payload.pageWidth}px;height:{payload.pageHeight}px;flex:none;transform:scale({_fit})"
    >
      {#each $bufferedSlides as i (i)}
        <SlideViewport {payload} index={i} />
      {/each}
    </div>
  </div>
{/if}

<style>
  .presentation-root {
    position: fixed;
    inset: 0;
    background: #1d232a;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 80px;
  }
</style>
