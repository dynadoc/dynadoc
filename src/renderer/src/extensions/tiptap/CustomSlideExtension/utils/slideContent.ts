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
import {
  escapeHtmlAttribute,
  safeCssColor,
  safeFontFamily,
  safeNumber,
  safeTextAlign
} from './cssValues'

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

const escapeAttr = escapeHtmlAttribute

// Every style value below is checked (cssValues.ts) before it is written, and
// the whole attribute is escaped as well.
const styleAttr = (css: (string | false | null | undefined)[]): string =>
  ` style="${escapeHtml(css.filter(Boolean).join(';'))}"`

function runToHtml(run: TextRun): string {
  const css: string[] = []
  if (run.bold) css.push('font-weight:700')
  if (run.italic) css.push('font-style:italic')
  const decoration = [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean)
  if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`)
  const color = safeCssColor(run.color)
  if (color) css.push(`color:${color}`)
  const highlight = safeCssColor(run.highlight)
  if (highlight) css.push(`background:${highlight}`)
  const fontSize = safeNumber(run.fontSize)
  if (fontSize > 0) css.push(`font-size:${fontSize}px`)
  const fontFamily = safeFontFamily(run.fontFamily)
  if (fontFamily) css.push(`font-family:'${fontFamily}'`)
  const text = escapeHtml(run.text).replace(/\n/g, '<br>')
  const attrs = run.variable ? ` data-variable="${escapeAttr(run.variable)}"` : ''
  return css.length || attrs ? `<span${styleAttr(css)}${attrs}>${text}</span>` : text
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
    const align = safeTextAlign(block.align)
    const style = align ? styleAttr([`text-align:${align}`]) : ''
    if (tag) {
      const level = safeNumber(block.level)
      const indent = level ? styleAttr([`margin-left:${level * 1.5}em`]) : ''
      html += `<li${indent}><p${style}>${inner}</p></li>`
    } else if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, Math.round(safeNumber(block.level, 1))))
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

/** A slide background as a CSS value; white when it is not a valid colour or gradient. */
export function backgroundToCss(background: SlideBackground): string {
  if (!background) return '#ffffff'
  if (typeof background === 'string') return safeCssColor(background) ?? '#ffffff'
  if (background.color || background.fill)
    return safeCssColor(background.color || background.fill) ?? '#ffffff'
  const stops = background.stops || background.Stops
  if (Array.isArray(stops) && stops.length) {
    const angle = safeNumber(background.angle ?? background.Angle, 180)
    const parts: string[] = []
    for (const stop of stops) {
      const color = safeCssColor(stop?.color ?? stop?.Color)
      const position = Math.round(safeNumber(stop?.position ?? stop?.Position) * 100)
      if (color) parts.push(`${color} ${position}%`)
    }
    if (parts.length === 1) return parts[0].split(' ')[0]
    if (parts.length) return `linear-gradient(${angle}deg, ${parts.join(', ')})`
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
    const x = safeNumber(el.x)
    const y = safeNumber(el.y)
    const w = safeNumber(el.w)
    const h = safeNumber(el.h)
    const rotation = safeNumber(el.rotation)
    const box = [
      'position:absolute',
      `left:${x}px`,
      `top:${y}px`,
      `width:${Math.max(1, w)}px`,
      `height:${Math.max(1, h)}px`,
      rotation ? `transform:rotate(${rotation}deg);transform-origin:0 0` : ''
    ]
      .filter(Boolean)
      .join(';')
    const fill = safeCssColor(el.fill) ?? 'transparent'
    const strokeColor = safeCssColor(el.stroke)
    const strokeWidth = safeNumber(el.strokeWidth, 1)
    const stroke = strokeColor ? `${strokeWidth}px solid ${strokeColor}` : 'none'
    switch (el.type) {
      case ShapeType.File:
        return el.src
          ? `<img src="${escapeAttr(assetUrl(String(el.src)))}"${styleAttr([box, 'object-fit:fill'])} alt="">`
          : ''
      case ShapeType.Rect:
        return `<div${styleAttr([box, `background:${fill}`, `border:${stroke}`, 'box-sizing:border-box', `border-radius:${safeNumber(el.cornerRadius)}px`])}></div>`
      case ShapeType.Ellipse:
      case ShapeType.Circle:
        return `<div${styleAttr([box, `background:${fill}`, `border:${stroke}`, 'box-sizing:border-box', 'border-radius:50%'])}></div>`
      case ShapeType.Triangle: {
        // Konva draws a regular triangle inscribed in the box's inner circle.
        const r = Math.max(4, Math.min(w, h) / 2)
        const cx = w / 2
        const cy = h / 2
        const pts = [0, 1, 2]
          .map((i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
            return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
          })
          .join(' ')
        return `<svg${styleAttr([box, 'overflow:visible'])} viewBox="0 0 ${w} ${h}"><polygon points="${pts}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(strokeColor ?? 'none')}" stroke-width="${strokeColor ? strokeWidth : 0}"/></svg>`
      }
      case ShapeType.Line:
        return `<svg${styleAttr([box, 'overflow:visible'])} viewBox="0 0 ${Math.max(1, w)} ${Math.max(1, h)}"><line x1="0" y1="0" x2="${w}" y2="${h}" stroke="${escapeAttr(strokeColor ?? '#111827')}" stroke-width="${safeNumber(el.strokeWidth, 2)}" stroke-linecap="round"/></svg>`
      default: {
        const base = elementTextStyle(el, theme.id)
        const text = blocksToHtml(el.blocks ?? [])
        const fontFamily = safeFontFamily(base.fontFamily)
        return `<div class="slide-static-text"${styleAttr([box, 'padding:6px', 'box-sizing:border-box', 'overflow:hidden', fontFamily && `font-family:'${fontFamily}'`, `font-size:${safeNumber(base.fontSize, 24)}px`, `color:${safeCssColor(base.color) ?? '#111827'}`, `background:${fill}`])}>${text}</div>`
      }
    }
  })
  return `<div class="slide-static"${styleAttr(['position:relative', 'overflow:hidden', `width:${safeNumber(slide.width, SLIDE_WIDTH)}px`, `height:${safeNumber(slide.height, SLIDE_HEIGHT)}px`, `background:${backgroundToCss(slide.background)}`])}>${parts.join('')}</div>`
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
