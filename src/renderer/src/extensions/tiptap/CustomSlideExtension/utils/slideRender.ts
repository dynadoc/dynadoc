import type { Editor } from '@tiptap/core'
import { getVariable } from '../../CustomVarExtension/stores/variableManipulator'
import { getVariableDisplayValue } from '../../CustomVarExtension/utils/variableDisplay.utils'
import { listDeckSlides, withSlideCanvas } from './slideDeckCommands'
import { readSlideData, type SlideData, type VariableResolver } from './slideContent'

/**
 * Resolves `variable` chips of a presentation's slides against that
 * presentation's variables (not the active document's), with the same display
 * formatting as the chip in the editor.
 */
export function makeVariableResolver(editorId: string): VariableResolver {
  return (name) => {
    if (!name) return null
    const value = getVariable(name, editorId)
    if (value === undefined) return null
    const rawValue = getVariable(name, editorId, false)
    return getVariableDisplayValue({ value, rawValue }, { plainText: true })
  }
}

/** Every slide of the deck as data, in deck order, variables resolved. */
export async function loadDeckData(editor: Editor, editorId: string): Promise<SlideData[]> {
  const resolve = makeVariableResolver(editorId)
  const slides: SlideData[] = []
  for (const slide of listDeckSlides(editor)) {
    slides.push(await withSlideCanvas(slide, (canvas) => readSlideData(canvas.ydoc, resolve)))
  }
  return slides
}
