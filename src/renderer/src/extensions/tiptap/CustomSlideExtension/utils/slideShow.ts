import { get } from 'svelte/store'
import type { Editor } from '@tiptap/core'
import { IPC_PRESENTATION_START, IPC_PRESENTATION_UPDATE } from '../../../../shared/ipc'
import type { PresentationPayload } from '../../../../utils/shared.type'
import { toAssetUrl } from '../../../../utils/assetUrl'
import { setPresentationUpdateHandler } from '../../../../utils/canvas.utils'
import { onVariableChange } from '../../CustomVarExtension/stores/variableManipulator'
import {
  currentSlide,
  presentation,
  visibleSlideIndexes
} from '../../CustomPresentationExtension/store/presentation.store'
import { _$_currentSlideId, getSlideDeckApi } from '../stores/slide.store'
import { listDeckSlides } from './slideDeckCommands'
import { loadDeckData } from './slideRender'
import { SLIDE_STATIC_CSS, renderSlideHtml } from './slideContent'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './slideDesign'

// The slideshow of a presentation. It goes through the existing presentation
// windows (CustomPresentationExtension: PresentationWindow for the audience,
// PresenterWindowModal for the presenter), which show `payload.html` one page
// at a time. Konva canvases do not survive being copied as HTML, so the deck
// is drawn from its slide data instead: one static page per slide, stacked.

/** The deck as a presentation payload, opened at slide `currentIndex`. */
export async function buildSlideShowPayload(
  editor: Editor,
  editorId: string,
  currentIndex: number
): Promise<PresentationPayload> {
  const slides = await loadDeckData(editor, editorId)
  const width = slides[0]?.width || SLIDE_WIDTH
  const height = slides[0]?.height || SLIDE_HEIGHT
  const pages = slides
    .map(
      (slide) =>
        `<div style="position:relative;overflow:hidden;width:${width}px;height:${height}px">${renderSlideHtml(slide, toAssetUrl)}</div>`
    )
    .join('')
  return {
    html: `<style>${SLIDE_STATIC_CSS}</style><div class="slide-show-deck" style="width:${width}px">${pages}</div>`,
    pageCount: slides.length,
    pageWidth: width,
    pageHeight: height,
    currentIndex: Math.max(0, Math.min(currentIndex, slides.length - 1)),
    notesList: slides.map((slide) => slide.notes || ''),
    fullscreen: true,
    editorPaginationOptions: { hiddenPages: [] } as PresentationPayload['editorPaginationOptions']
  }
}

let _refreshTimer: ReturnType<typeof setTimeout> | null = null
let _stopWatching: (() => void) | null = null

/** Index (in the deck) of the slide the show is on. */
function shownIndex(): number {
  const visible = get(currentSlide)
  return get(visibleSlideIndexes)?.[visible] ?? visible
}

/** Starts the show from the first slide or from the deck's current slide. */
export async function startSlideShow(
  editor: Editor,
  editorId: string,
  from: 'start' | 'current'
): Promise<void> {
  const slides = listDeckSlides(editor)
  const current = Math.max(
    0,
    slides.findIndex((slide) => slide.id === get(_$_currentSlideId))
  )
  const payload = await buildSlideShowPayload(editor, editorId, from === 'start' ? 0 : current)
  presentation.update((state) => ({ ...state, active: true }))
  window.presentationAPI?.sendData(IPC_PRESENTATION_START, payload)
  watchDeck(editor, editorId)
}

// The status bar's slideshow button (CustomPresentationExtension) reaches the
// show through the deck API; slideDeckCommands registers it before this loads.
const deckApi = getSlideDeckApi()
if (deckApi) {
  deckApi.startSlideShow = (editor, editorId, from): Promise<void> =>
    startSlideShow(editor as Editor, editorId, from)
}

/**
 * While the show runs, edits to the deck (or its slides) and changes to the
 * variables it shows reach the screen.
 */
function watchDeck(editor: Editor, editorId: string): void {
  _stopWatching?.()
  const refresh = (): void => {
    if (_refreshTimer) clearTimeout(_refreshTimer)
    _refreshTimer = setTimeout(async () => {
      _refreshTimer = null
      if (!get(presentation).active || editor.isDestroyed) return
      const payload = await buildSlideShowPayload(editor, editorId, shownIndex())
      window.presentationAPI?.sendData(IPC_PRESENTATION_UPDATE, payload)
    }, 300)
  }
  // Put back on stop: documents' own shows use the handler that was there.
  const previousHandler = setPresentationUpdateHandler(refresh)
  editor.on('update', refresh)
  const stopVariables = onVariableChange(refresh)
  // The stop of a show ended just before this one started can arrive after
  // this one has started (the windows' events are not ordered). A show that
  // really ended stays inactive: stop watching only if it is still inactive
  // a moment later.
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = presentation.subscribe((state) => {
    if (state.active) {
      if (stopTimer) clearTimeout(stopTimer)
      stopTimer = null
      return
    }
    stopTimer ??= setTimeout(() => {
      stopTimer = null
      if (!get(presentation).active) _stopWatching?.()
    }, 2000)
  })
  _stopWatching = (): void => {
    _stopWatching = null
    if (stopTimer) clearTimeout(stopTimer)
    setPresentationUpdateHandler(previousHandler)
    editor.off('update', refresh)
    stopVariables()
    queueMicrotask(unsubscribe)
  }
}
