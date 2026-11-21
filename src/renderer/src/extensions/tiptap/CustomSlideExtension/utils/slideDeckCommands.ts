import * as Y from 'yjs'
import { get } from 'svelte/store'
import { v4 as uuidv4 } from 'uuid'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { DocumentModel } from '../../../../models/Document'
import { _$_canvasCommands } from '../../../../stores/canvas.store'
import { _$_documentEditorsList, _$_wysiwygEditorsList } from '../../../../stores/editor.store'
import { createCanvasCommands } from '../../../../commands/canvasCommands'
import { encodeSnapshot } from '../../../../utils/canvasSnapshot.utils'
import { writeFileEnsuringDirAsync } from '../../../../utils/documentFileUtils'
import {
  ShapeType,
  type CollaborativeCanvas,
  type Shape,
  type ShapeContent
} from '../../../../utils/canvas.types'
import type { CanvasCommands } from '../../../../commands/canvasCommands.types'
import { nodeApi } from '../../../../utils/shims/node'
import { ensureNodeViewSrc } from '../../utils/utils'
import { createSlide } from '../collab/collab'
import { _$_currentSlideId, registerSlideDeckApi } from '../stores/slide.store'
import { CustomSlideExtensionProps } from './common.utils'
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  applyLayoutToDoc,
  getSlideTheme,
  seedSlideDoc,
  type SlideLayoutId
} from './slideDesign'

// Deck-level operations of a presentation document: its slides are the
// `slide` nodes of the tiptap document, in document order, and each one's
// content is the Y.Doc in its `src` file.

export type DeckSlide = { id: string; src: string; pos: number; node: PMNode }

export function listDeckSlides(editor: Editor | null | undefined): DeckSlide[] {
  const slides: DeckSlide[] = []
  editor?.state?.doc?.descendants((node, pos) => {
    if (node.type.name !== CustomSlideExtensionProps.name) return true
    slides.push({ id: node.attrs.id, src: node.attrs.src, pos, node })
    return false
  })
  return slides
}

/** Runs `fn` on a slide's Y.Doc: the live one when the slide is mounted. */
export async function withSlideCanvas<T>(
  slide: { id: string; src: string },
  fn: (canvas: CollaborativeCanvas) => T
): Promise<T> {
  const canvas = await createSlide(slide.id, slide.src)
  try {
    await canvas.load?.()
    return fn(canvas)
  } finally {
    canvas.release?.()
  }
}

async function writeSlideFile(editorId: string, ydoc: Y.Doc): Promise<string> {
  const src = await ensureNodeViewSrc('', 'slide', DocumentModel.AssetType.SLIDE, editorId)
  await writeFileEnsuringDirAsync(
    src,
    JSON.stringify({ snapshot: encodeSnapshot(ydoc), updates: [] }),
    'utf-8'
  )
  return src
}

function insertSlideNode(
  editor: Editor,
  editorId: string,
  at: number,
  id: string,
  src: string
): void {
  editor
    .chain()
    .insertContentAt(at, {
      type: CustomSlideExtensionProps.name,
      attrs: {
        id,
        src,
        parentFilePath: editorId,
        slideWidth: SLIDE_WIDTH,
        slideHeight: SLIDE_HEIGHT
      }
    })
    .run()
}

function positionAfter(editor: Editor, index: number): number {
  const slides = listDeckSlides(editor)
  const anchor = slides[Math.min(index, slides.length - 1)]
  return anchor ? anchor.pos + anchor.node.nodeSize : editor.state.doc.content.size
}

async function currentThemeId(editor: Editor): Promise<string> {
  const slides = listDeckSlides(editor)
  const current = slides.find((s) => s.id === get(_$_currentSlideId)) ?? slides[0]
  if (!current) return getSlideTheme(null).id
  return withSlideCanvas(current, (canvas) => getSlideTheme(canvas.meta.get('theme')).id)
}

/** Adds a slide with `layout` after slide `afterIndex` (at the end by default). */
export async function addSlide(
  editor: Editor,
  editorId: string,
  layout: SlideLayoutId,
  afterIndex: number = Number.MAX_SAFE_INTEGER
): Promise<string> {
  const ydoc = new Y.Doc()
  seedSlideDoc(ydoc, layout, await currentThemeId(editor), uuidv4)
  const src = await writeSlideFile(editorId, ydoc)
  const id = uuidv4()
  insertSlideNode(editor, editorId, positionAfter(editor, afterIndex), id, src)
  _$_currentSlideId.set(id)
  return id
}

export async function duplicateSlide(
  editor: Editor,
  editorId: string,
  id: string
): Promise<string | null> {
  const slides = listDeckSlides(editor)
  const index = slides.findIndex((s) => s.id === id)
  if (index === -1) return null
  const copy = new Y.Doc()
  await withSlideCanvas(slides[index], (canvas) =>
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(canvas.ydoc))
  )
  const src = await writeSlideFile(editorId, copy)
  const newId = uuidv4()
  insertSlideNode(editor, editorId, positionAfter(editor, index), newId, src)
  _$_currentSlideId.set(newId)
  return newId
}

/** Moves the slide at `from` so that it ends up at index `to`. */
export function moveSlide(editor: Editor, from: number, to: number): boolean {
  const slides = listDeckSlides(editor)
  if (from === to || !slides[from] || !slides[to]) return false
  const moving = slides[from]
  const target = slides[to]
  const tr = editor.state.tr
  tr.delete(moving.pos, moving.pos + moving.node.nodeSize)
  const insertAt = to < from ? target.pos : target.pos + target.node.nodeSize
  tr.insert(tr.mapping.map(insertAt), moving.node)
  // A move, not a deletion: no "Delete embedded content?" prompt.
  tr.setMeta('bypassWarning', true)
  editor.view.dispatch(tr)
  return true
}

export function deleteSlide(editor: Editor, id: string): boolean {
  const slides = listDeckSlides(editor)
  const index = slides.findIndex((s) => s.id === id)
  if (index === -1) return false
  const slide = slides[index]
  // The sorter's delete is explicit (and undoable): no embedded-content prompt.
  editor.view.dispatch(
    editor.state.tr
      .delete(slide.pos, slide.pos + slide.node.nodeSize)
      .setMeta('bypassWarning', true)
  )
  const next = slides[index + 1] ?? slides[index - 1]
  _$_currentSlideId.set(next?.id ?? null)
  return true
}

export async function setSlideLayout(slide: DeckSlide, layout: SlideLayoutId): Promise<void> {
  await withSlideCanvas(slide, (canvas) => applyLayoutToDoc(canvas.ydoc, layout, uuidv4))
}

/** A theme applies to the whole deck; it replaces per-slide backgrounds. */
export async function applyDeckTheme(editor: Editor, themeId: string): Promise<void> {
  for (const slide of listDeckSlides(editor)) {
    await withSlideCanvas(slide, (canvas) =>
      canvas.ydoc.transact(() => {
        canvas.meta.set('theme', themeId)
        canvas.meta.delete('background')
      })
    )
  }
}

/** The canvas commands of a slide, mounted or not. */
async function slideCommands(slide: DeckSlide): Promise<CanvasCommands | null | undefined> {
  const mounted = _$_canvasCommands.get(slide.id)
  if (mounted) return mounted
  return withSlideCanvas(slide, (canvas) =>
    createCanvasCommands(canvas.shapes, canvas.texts, canvas.meta)
  )
}

export type SlideInsertKind =
  'text' | ShapeType.Rect | ShapeType.Ellipse | ShapeType.Triangle | ShapeType.Line

/** Puts a new element on the slide; returns the new text box's id for 'text'. */
export async function insertIntoSlide(
  slide: DeckSlide,
  kind: SlideInsertKind
): Promise<string | null> {
  const commands = await slideCommands(slide)
  if (!commands) return null
  const { accent, count, ids } = await withSlideCanvas(slide, (canvas) => ({
    accent: getSlideTheme(canvas.meta.get('theme')).accent,
    count: canvas.shapes.size,
    ids: new Set(canvas.shapes.keys())
  }))
  // Each new object lands a little lower-right of the previous one.
  const offset = (count % 6) * 24
  if (kind === 'text') {
    commands.addText({
      x: 440 + offset,
      y: 300 + offset,
      w: 400,
      h: 80,
      // No content type: a free text box starts as a paragraph, not a bullet list.
      content: { value: '', placeholder: 'Type text' } as ShapeContent
    })
    // addText does not return the id: it is the one key that is new.
    return withSlideCanvas(
      slide,
      (canvas) => [...canvas.shapes.keys()].find((id) => !ids.has(id)) ?? null
    )
  }
  if (kind === ShapeType.Line) {
    commands.addShape(ShapeType.Line, {
      x: 440 + offset,
      y: 360 + offset,
      w: 400,
      h: 0,
      stroke: accent,
      strokeWidth: 4
    })
    return null
  }
  commands.addShape(kind, { x: 540 + offset, y: 260 + offset, w: 200, h: 200, fill: accent })
  return null
}

/** Copies an image into the document's assets and puts it on the slide. */
export async function insertImageIntoSlide(
  slide: DeckSlide,
  editorId: string,
  file: File
): Promise<void> {
  const document = get(_$_documentEditorsList.get(editorId))?.document
  const ext = nodeApi.path.extname(file.name) || '.png'
  const asset = await DocumentModel.getAssetFilePathFromDocument(
    DocumentModel.AssetType.IMG,
    document,
    `Slide image ${Date.now()}${ext}`
  )
  if (!asset?.filePath) return
  await writeFileEnsuringDirAsync(asset.filePath, new Uint8Array(await file.arrayBuffer()))
  const size = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => resolve({ w: 400, h: 300 })
    img.src = url
  })
  const scale = Math.min(1, 480 / size.w, 360 / size.h)
  const w = Math.round(size.w * scale)
  const h = Math.round(size.h * scale)
  const commands = await slideCommands(slide)
  commands?.addFile(asset.filePath, {
    x: (SLIDE_WIDTH - w) / 2,
    y: (SLIDE_HEIGHT - h) / 2,
    w,
    h,
    src: asset.filePath,
    visible: true
  } as Shape)
}

/** Makes `id` the deck's current slide and the editor's active slide. */
export function selectSlide(editorId: string, id: string): void {
  _$_currentSlideId.set(id)
  _$_wysiwygEditorsList.setActiveNodeview(editorId, id)
}

/** The presentation in the active editor and its current slide, or null. */
export function getActiveDeck(): {
  editor: Editor
  editorId: string
  index: number
  current: DeckSlide
} | null {
  const entry = _$_wysiwygEditorsList.getActiveEntry()
  const slides = listDeckSlides(entry?.editor)
  if (!entry?.editor || !slides.length) return null
  const index = Math.max(
    0,
    slides.findIndex((s) => s.id === get(_$_currentSlideId))
  )
  return {
    editor: entry.editor as Editor,
    editorId: String(entry.id),
    index,
    current: slides[index]
  }
}

registerSlideDeckApi({ addSlide, duplicateSlide, setSlideLayout, applyDeckTheme, getActiveDeck })
