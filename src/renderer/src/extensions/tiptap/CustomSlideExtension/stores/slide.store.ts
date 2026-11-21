// import { derived, get, writable, type Readable } from 'svelte/store'
// import type { CanvasCommands } from '../utils/slideCommands'

// // export const slideCommandsStore: CanvasCommands | null = $derived(null)
// export const slideCommandsStore = writable<Map<string, CanvasCommands | null>>(new Map())
// // export const slideCommandsStore = writable<CanvasCommands | null>(null)

// export const _$_canvasCommands = {
//     subscribe: slideCommandsStore.subscribe,
//     /** 🔎 Subscribe to commands for a specific slide ID */
//     subscribeById(id: string): Readable<CanvasCommands | null | undefined> {
//         return derived(slideCommandsStore, (map) => map.get(id))
//     },

//     /** 📝 Set / replace commands for a slide */
//     set(id: string, commands: CanvasCommands | null) {
//         slideCommandsStore.update((map) => {
//             const next = new Map(map)
//             next.set(id, commands)
//             return next
//         })
//     },

//     /** 🧹 Remove commands for a slide */
//     unset(id: string) {
//         slideCommandsStore.update((map) => {
//             const next = new Map(map)
//             next.delete(id)
//             return next
//         })
//     },

//     /** 📦 One-shot getter (non-reactive) */
//     get(id: string): CanvasCommands | null | undefined {
//         return get(slideCommandsStore).get(id)
//     },
//     /* set(id: string, commands: CanvasCommands) {
//         slideCommandsStore.update(map => {
//             const next = new Map(map)
//             next.set(id, commands)
//             return next
//         })

//     }, */

//     /* get(id: string): CanvasCommands | undefined {
//         return get(slideCommandsStore).get(id)
//     }, */

//     delete(id: string) {
//         slideCommandsStore.update(map => {
//             const next = new Map(map)
//             next.delete(id)
//             return next
//         })
//     },

//     clear() {
//         slideCommandsStore.set(new Map())
//     },
// }

import { writable } from 'svelte/store'

/** Id of the slide the deck UI works on (thumbnail selection, toolbar, notes). */
export const _$_currentSlideId = writable<string | null>(null)

// The deck commands (utils/slideDeckCommands.ts) register here when a
// presentation is open, so the ribbon reaches them without importing them
// (which would close an import cycle through the editor stores).
export interface SlideDeckApi {
  getActiveDeck(): {
    editor: unknown
    editorId: string
    index: number
    current: { id: string }
  } | null
  addSlide(editor: unknown, editorId: string, layout: string, afterIndex?: number): Promise<unknown>
  duplicateSlide(editor: unknown, editorId: string, id: string): Promise<unknown>
  setSlideLayout(slide: unknown, layout: string): Promise<unknown>
  applyDeckTheme(editor: unknown, themeId: string): Promise<unknown>
  /** Set by utils/slideShow.ts once loaded. */
  startSlideShow?(editor: unknown, editorId: string, from: 'start' | 'current'): Promise<unknown>
}
let _slideDeckApi: SlideDeckApi | null = null
export const registerSlideDeckApi = (api: SlideDeckApi): void => {
  _slideDeckApi = api
}
export const getSlideDeckApi = (): SlideDeckApi | null => _slideDeckApi
