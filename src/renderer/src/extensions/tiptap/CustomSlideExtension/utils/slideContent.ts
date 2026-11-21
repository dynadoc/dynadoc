import * as Y from 'yjs'
import { ShapeType, type Shape } from '../../../../utils/canvas.types'
import {
  ROLE_TEXT_STYLE,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  getSlideTheme,
  resolveSlideBackground,
  type PlaceholderRole
} from './slideDesign'

// A slide's content read out of its Y.Doc into plain data, and that data as
// static HTML. Thumbnails, the slideshow and the .pptx exporter all read slides
// through here, so a `variable` node shows its current value in every one of
// them. Pure (yjs only) so tests/smoke/slides.test.mjs can load it.

export type TextRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  highlight?: string
  fontSize?: number // px
  fontFamily?: string
  /** Set when the run is a variable's value. */
  variable?: string
}

export type TextBlock = {
  kind: 'heading' | 'paragraph' | 'bullet' | 'number'
  level: number
  align?: string
  runs: TextRun[]
}

export type SlideElement = Shape & { blocks?: TextBlock[]; src?: string }

export type SlideData = {
  width: number
  height: number
  background: SlideBackground
  themeId: string
  notes: string
  elements: SlideElement[]
}

type GradientStop = { color?: string; Color?: string; position?: number; Position?: number }

/** A stored slide background: a CSS colour or gradient, or an imported fill object. */
export type SlideBackground =
  | string
  | {
      color?: string
      fill?: string
      angle?: number
      Angle?: number
      stops?: GradientStop[]
      Stops?: GradientStop[]
    }
  | null
  | undefined

/** Mark attributes y-prosemirror stores on a text run (all styling sits in textStyle here). */
type RunAttributes = {
  textStyle?: Record<string, string | number | null | undefined>
  highlight?: { color?: string }
  bold?: unknown
  italic?: unknown
  underline?: unknown
  strike?: unknown
}

/** A variable's display value, or null when the variable is unknown. */
export type VariableResolver = (name: string) => string | null

const cssPx = (value: unknown): number | undefined => {
  const num = parseFloat(String(value ?? ''))
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function runFromAttributes(text: string, attributes: RunAttributes = {}): TextRun {
  const style = attributes.textStyle || {}
  const decoration = String(style.textDecoration || '')
  const weight = String(style.fontWeight || '')
  const run: TextRun = { text }
  if (attributes.bold || weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600)
    run.bold = true
  if (attributes.italic || style.fontStyle === 'italic' || style.fontStyle === 'oblique')
    run.italic = true
  if (attributes.underline || decoration.includes('underline')) run.underline = true
  if (attributes.strike || decoration.includes('line-through')) run.strike = true
  if (style.color) run.color = String(style.color)
  if (style.backgroundColor || attributes.highlight?.color)
    run.highlight = String(style.backgroundColor || attributes.highlight.color)
  const size = cssPx(style.fontSize)
  if (size) run.fontSize = size
  if (style.fontFamily) run.fontFamily = String(style.fontFamily).replace(/^["']+|["']+$/g, '')
  return run
}

function inlineRuns(el: Y.XmlElement, resolveVariable: VariableResolver): TextRun[] {
  const runs: TextRun[] = []
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: RunAttributes }[]) {
        if (typeof op.insert === 'string' && op.insert)
          runs.push(runFromAttributes(op.insert, op.attributes))
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'variable') {
        const name = String(child.getAttribute('name') ?? '')
        const value = resolveVariable(name) ?? String(child.getAttribute('value') ?? '')
        runs.push({ text: value, variable: name })
      } else if (child.nodeName === 'hardBreak') {
        runs.push({ text: '\n' })
      } else {
        runs.push(...inlineRuns(child, resolveVariable))
      }
    }
  }
  return runs
}

function collectBlocks(
  nodes: (Y.XmlElement | Y.XmlText | Y.XmlHook)[],
  resolveVariable: VariableResolver,
  blocks: TextBlock[],
  list: { kind: 'bullet' | 'number'; level: number } | null
): void {
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) continue
    const name = node.nodeName
    const align = (node.getAttribute('textAlign') as string) || undefined
    if (name === 'paragraph' || name === 'heading') {
      blocks.push({
        kind: list ? list.kind : name === 'heading' ? 'heading' : 'paragraph',
        level: list ? list.level : Number(node.getAttribute('level') ?? 1) || 1,
        align,
        runs: inlineRuns(node, resolveVariable)
      })
    } else if (name === 'bulletList' || name === 'taskList' || name === 'orderedList') {
      const kind = name === 'orderedList' ? 'number' : 'bullet'
      collectBlocks(node.toArray(), resolveVariable, blocks, {
        kind,
        level: list ? list.level + 1 : 0
      })
    } else {
      // listItem, taskItem, blockquote and other wrappers: their children carry the text.
      collectBlocks(node.toArray(), resolveVariable, blocks, list)
    }
  }
}

export function fragmentToBlocks(
  fragment: Y.XmlFragment | null | undefined,
  resolveVariable: VariableResolver = () => null
): TextBlock[] {
  if (!fragment) return []
  const blocks: TextBlock[] = []
  collectBlocks(fragment.toArray(), resolveVariable, blocks, null)
  return blocks
}

export function blocksToPlainText(blocks: TextBlock[]): string {
  return blocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n')
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeAttr = (value: string): string => escapeHtml(value).replace(/'/g, '&#39;')

function runToHtml(run: TextRun): string {
  const css: string[] = []
  if (run.bold) css.push('font-weight:700')
  if (run.italic) css.push('font-style:italic')
  const decoration = [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean)
  if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`)
  if (run.color) css.push(`color:${run.color}`)
  if (run.highlight) css.push(`background:${run.highlight}`)
  if (run.fontSize) css.push(`font-size:${run.fontSize}px`)
  if (run.fontFamily) css.push(`font-family:'${run.fontFamily.replace(/'/g, '')}'`)
  const text = escapeHtml(run.text).replace(/\n/g, '<br>')
  const attrs = run.variable ? ` data-variable="${escapeAttr(run.variable)}"` : ''
  return css.length || attrs ? `<span style="${css.join(';')}"${attrs}>${text}</span>` : text
}

/** Blocks as HTML; consecutive list blocks share one <ul>/<ol>. */
export function blocksToHtml(blocks: TextBlock[]): string {
  let html = ''
  let openList: 'ul' | 'ol' | null = null
  for (const block of blocks) {
    const tag = block.kind === 'bullet' ? 'ul' : block.kind === 'number' ? 'ol' : null
    if (openList && tag !== openList) {
      html += `</${openList}>`
      openList = null
    }
    if (tag && !openList) {
      html += `<${tag}>`
      openList = tag
    }
    const inner = block.runs.map(runToHtml).join('') || '<br>'
    const style = block.align ? ` style="text-align:${block.align}"` : ''
    if (tag) {
      const indent = block.level ? ` style="margin-left:${block.level * 1.5}em"` : ''
      html += `<li${indent}><p${style}>${inner}</p></li>`
    } else if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, block.level))
      html += `<h${level}${style}>${inner}</h${level}>`
    } else {
      html += `<p${style}>${inner}</p>`
    }
  }
  if (openList) html += `</${openList}>`
  return html
}

function fileSrcOf(fragment?: Y.XmlFragment | null): string {
  for (const node of fragment?.toArray() ?? []) {
    if (node instanceof Y.XmlElement) {
      const src = node.getAttribute('src')
      if (src) return String(src)
    }
  }
  return ''
}

/** Everything needed to draw or export a slide, read from its Y.Doc. */
export function readSlideData(
  ydoc: Y.Doc,
  resolveVariable: VariableResolver = () => null
): SlideData {
  const shapes = ydoc.getMap<Shape>('shapes')
  const texts = ydoc.getMap<Y.XmlFragment>('texts')
  const meta = ydoc.getMap<unknown>('meta')
  const elements: SlideElement[] = Array.from(shapes.entries())
    .map(([id, shape]) => ({ ...shape, id }))
    .filter((shape) => shape.visible !== false)
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    .map((shape) => {
      const fragment = texts.get(shape.id)
      if (shape.type === ShapeType.File)
        return { ...shape, src: (shape as SlideElement).src || fileSrcOf(fragment) }
      if (!shape.type || shape.type === ShapeType.Text)
        return { ...shape, blocks: fragmentToBlocks(fragment, resolveVariable) }
      return shape
    })
  return {
    width: Number(meta.get('slideWidth')) || SLIDE_WIDTH,
    height: Number(meta.get('slideHeight')) || SLIDE_HEIGHT,
    background: resolveSlideBackground(meta) as SlideBackground,
    themeId: getSlideTheme(meta.get('theme') as string).id,
    notes: typeof meta.get('notes') === 'string' ? (meta.get('notes') as string) : '',
    elements
  }
}

export function backgroundToCss(background: SlideBackground): string {
  if (!background) return '#ffffff'
  if (typeof background === 'string') return background
  if (background.color || background.fill) return background.color || background.fill
  const stops = background.stops || background.Stops
  if (Array.isArray(stops) && stops.length) {
    const angle = background.angle ?? background.Angle ?? 180
    const parts = stops.map(
      (stop) =>
        `${stop.color ?? stop.Color} ${Math.round((stop.position ?? stop.Position ?? 0) * 100)}%`
    )
    return `linear-gradient(${angle}deg, ${parts.join(', ')})`
  }
  return '#ffffff'
}

/** Base text style of a text element: its role's size and the theme's fonts. */
export function elementTextStyle(
  element: Shape,
  themeId: string
): { fontFamily: string; fontSize: number; color: string } {
  const theme = getSlideTheme(themeId)
  const role = (element.role as PlaceholderRole) || 'body'
  const roleStyle = ROLE_TEXT_STYLE[role] ?? ROLE_TEXT_STYLE.body
  return {
    fontFamily: role === 'title' ? theme.titleFont : theme.bodyFont,
    fontSize: roleStyle.fontSize,
    color: theme.textColor
  }
}

/**
 * A slide as static HTML at its own size (width x height px). Scale it with a
 * CSS transform. `assetUrl` turns a stored image path into a loadable URL.
 */
export function renderSlideHtml(
  slide: SlideData,
  assetUrl: (src: string) => string = (src) => src
): string {
  const theme = getSlideTheme(slide.themeId)
  const parts = slide.elements.map((el) => {
    const box = [
      'position:absolute',
      `left:${el.x}px`,
      `top:${el.y}px`,
      `width:${Math.max(1, el.w)}px`,
      `height:${Math.max(1, el.h)}px`,
      el.rotation ? `transform:rotate(${el.rotation}deg);transform-origin:0 0` : ''
    ]
      .filter(Boolean)
      .join(';')
    const fill = el.fill || 'transparent'
    const stroke = el.stroke ? `${el.strokeWidth ?? 1}px solid ${el.stroke}` : 'none'
    switch (el.type) {
      case ShapeType.File:
        return el.src
          ? `<img src="${escapeAttr(assetUrl(el.src))}" style="${box};object-fit:fill" alt="">`
          : ''
      case ShapeType.Rect:
        return `<div style="${box};background:${fill};border:${stroke};box-sizing:border-box;border-radius:${el.cornerRadius || 0}px"></div>`
      case ShapeType.Ellipse:
      case ShapeType.Circle:
        return `<div style="${box};background:${fill};border:${stroke};box-sizing:border-box;border-radius:50%"></div>`
      case ShapeType.Triangle: {
        // Konva draws a regular triangle inscribed in the box's inner circle.
        const r = Math.max(4, Math.min(el.w, el.h) / 2)
        const cx = el.w / 2
        const cy = el.h / 2
        const pts = [0, 1, 2]
          .map((i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
            return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
          })
          .join(' ')
        return `<svg style="${box};overflow:visible" viewBox="0 0 ${el.w} ${el.h}"><polygon points="${pts}" fill="${fill}" stroke="${el.stroke || 'none'}" stroke-width="${el.stroke ? (el.strokeWidth ?? 1) : 0}"/></svg>`
      }
      case ShapeType.Line:
        return `<svg style="${box};overflow:visible" viewBox="0 0 ${Math.max(1, el.w)} ${Math.max(1, el.h)}"><line x1="0" y1="0" x2="${el.w}" y2="${el.h}" stroke="${el.stroke || '#111827'}" stroke-width="${el.strokeWidth ?? 2}" stroke-linecap="round"/></svg>`
      default: {
        const base = elementTextStyle(el, theme.id)
        const text = blocksToHtml(el.blocks ?? [])
        return `<div class="slide-static-text" style="${box};padding:6px;box-sizing:border-box;overflow:hidden;font-family:'${base.fontFamily}';font-size:${base.fontSize}px;color:${base.color};background:${el.fill || 'transparent'}">${text}</div>`
      }
    }
  })
  return `<div class="slide-static" style="position:relative;overflow:hidden;width:${slide.width}px;height:${slide.height}px;background:${backgroundToCss(slide.background)}">${parts.join('')}</div>`
}

/** CSS the static HTML relies on (headings, lists, paragraph spacing). */
export const SLIDE_STATIC_CSS = `
.slide-static, .slide-static * { box-sizing: border-box; }
.slide-static-text p, .slide-static-text h1, .slide-static-text h2, .slide-static-text h3 { margin: 0 0 0.3em; line-height: 1.2; }
.slide-static-text h1 { font-size: 1em; font-weight: 700; }
.slide-static-text h2 { font-size: 0.85em; font-weight: 700; }
.slide-static-text h3 { font-size: 0.75em; font-weight: 700; }
.slide-static-text ul, .slide-static-text ol { margin: 0; padding-left: 1.2em; }
.slide-static-text ul { list-style: disc; }
.slide-static-text ol { list-style: decimal; }
`
