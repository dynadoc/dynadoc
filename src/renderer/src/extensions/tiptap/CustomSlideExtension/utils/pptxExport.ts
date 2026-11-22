import type { Editor } from '@tiptap/core'
import { get } from 'svelte/store'
import { _$_documentEditorsList } from '../../../../stores/editor.store'
import { openAlertModal } from '../../../../stores/alertModal.store'
import { toLocalPath } from '../../../../utils/assetUrl'
import { nodeApi } from '../../../../utils/shims/node'
import { showExportToast } from '../../../../services/export/export.common.utils'
import { getSlideDeckApi } from '../stores/slide.store'
import { buildPptx, type PptxImage } from './pptxMapping'
import { loadDeckData } from './slideRender'

// Export of a presentation to .pptx: the deck's slide data, variables
// resolved to their current values (slideRender.loadDeckData), written as
// OOXML by pptxMapping.buildPptx.

const IMAGE_EXT: Record<string, string> = { jpg: 'jpeg', jpe: 'jpeg', svg: 'svg' }

/** An SVG drawn to a PNG (longest side 1024 to 4096 px); null when it cannot be drawn. */
async function svgToPng(data: Uint8Array): Promise<Uint8Array | null> {
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = (): void => resolve()
      img.onerror = (): void => reject(new Error('SVG could not be loaded'))
      img.src = url
    })
    const width = img.naturalWidth || 512
    const height = img.naturalHeight || 512
    const scale = Math.min(
      4096 / Math.max(width, height),
      Math.max(1, 1024 / Math.max(width, height))
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * An image element's bytes, from a data: URI or a local file; null when
 * unreadable. SVG is rasterised to PNG: a bare SVG blip is not valid in a .pptx.
 */
async function loadImage(src: string): Promise<PptxImage | null> {
  const image = await readImage(src)
  if (image?.ext !== 'svg') return image
  const png = await svgToPng(image.data)
  return png ? { data: png, ext: 'png' } : null
}

async function readImage(src: string): Promise<PptxImage | null> {
  try {
    const dataUri = src.match(/^data:image\/([a-z0-9.+-]+)(;base64)?,(.*)$/is)
    if (dataUri) {
      const ext = dataUri[1].toLowerCase().replace(/\+xml$/, '')
      const data = dataUri[2]
        ? Uint8Array.from(atob(dataUri[3]), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(dataUri[3]))
      return { data, ext: IMAGE_EXT[ext] ?? ext }
    }
    const path = toLocalPath(src)
    if (!path || !nodeApi.fs.existsSync(path)) return null
    const ext = nodeApi.path.extname(path).slice(1).toLowerCase()
    const bytes = await nodeApi.fsPromises.readFile(path)
    return { data: new Uint8Array(bytes), ext: IMAGE_EXT[ext] ?? ext }
  } catch {
    // An image that cannot be read is left out of the file rather than
    // failing the whole export; the slide keeps its other content.
    return null
  }
}

/**
 * Writes the deck as a .pptx to `outputPath`, or where the user chooses when
 * it is not given. Returns the path written, or null when cancelled or failed
 * (the failure is shown to the user).
 */
export async function exportDeckToPptx(
  editor: Editor,
  editorId: string,
  outputPath?: string
): Promise<string | null> {
  const document = get(_$_documentEditorsList.get(editorId))?.document
  const title = String(document?.name || 'Presentation').replace(/\.[^.]+$/, '')
  const dir = document?.dirPath || ''
  outputPath ||=
    (await window.api.saveDialogFile({
      title: 'Export to PPTX',
      defaultPath: dir ? nodeApi.path.join(dir, `${title}.pptx`) : `${title}.pptx`,
      filters: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }]
    })) ?? undefined
  if (!outputPath) return null
  if (!/\.pptx$/i.test(outputPath)) outputPath += '.pptx'
  try {
    const slides = await loadDeckData(editor, editorId)
    const bytes = await buildPptx(slides, loadImage, { title })
    // Written as chosen: the save dialog grants that file, not its folder, so
    // creating the folder first would be refused outside the app's folders.
    await nodeApi.fsPromises.writeFile(outputPath, bytes)
  } catch (error) {
    await openAlertModal({
      title: 'Export failed',
      message: `The presentation could not be exported: ${(error as Error)?.message ?? error}`
    })
    return null
  }
  const written = outputPath
  showExportToast({
    id: 'pptx-export-toast-styles',
    title: 'PPTX export ready',
    path: written,
    onOpen: () => window.api.openFile(written),
    onReveal: () => window.api.openFile(nodeApi.path.dirname(written))
  })
  return written
}

// The File menu reaches the export through the deck API (see slide.store.ts).
const deckApi = getSlideDeckApi()
if (deckApi) {
  deckApi.exportPptx = (editor, editorId, outputPath): Promise<string | null> =>
    exportDeckToPptx(editor as Editor, editorId, outputPath)
}
