import * as Y from 'yjs'
import { ShapeType, type Shape } from '../../../../utils/canvas.types'

// Layouts and themes of a slide. Pure on purpose (yjs only): the editor, the
// slideshow, the .pptx exporter and tests/smoke/slides.test.mjs share it.

export const SLIDE_WIDTH = 1280
export const SLIDE_HEIGHT = 720

export type SlideLayoutId = 'title' | 'title-content' | 'two-column' | 'blank'
export type PlaceholderRole = 'title' | 'subtitle' | 'body' | 'body2'

export type SlideTheme = {
  id: string
  name: string
  background: string
  titleFont: string
  bodyFont: string
  textColor: string
  accent: string
}

export const SLIDE_THEMES: SlideTheme[] = [
  {
    id: 'default',
    name: 'Office',
    background: '#ffffff',
    titleFont: 'Arial',
    bodyFont: 'Arial',
    textColor: '#1f2937',
    accent: '#2563eb'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    background: '#0f172a',
    titleFont: 'Georgia',
    bodyFont: 'Verdana',
    textColor: '#f1f5f9',
    accent: '#38bdf8'
  },
  {
    id: 'sunrise',
    name: 'Sunrise',
    background: '#fff7ed',
    titleFont: 'Georgia',
    bodyFont: 'Arial',
    textColor: '#431407',
    accent: '#ea580c'
  },
  {
    id: 'forest',
    name: 'Forest',
    background: '#ecfdf5',
    titleFont: 'Trebuchet MS',
    bodyFont: 'Verdana',
    textColor: '#064e3b',
    accent: '#059669'
  }
]

export const SLIDE_LAYOUTS: { id: SlideLayoutId; name: string }[] = [
  { id: 'title', name: 'Title' },
  { id: 'title-content', name: 'Title and content' },
  { id: 'two-column', name: 'Two columns' },
  { id: 'blank', name: 'Blank' }
]

/** Font size (px at 1280x720) and alignment a placeholder's text starts with. */
export const ROLE_TEXT_STYLE: Record<PlaceholderRole, { fontSize: number; align: string }> = {
  title: { fontSize: 44, align: 'left' },
  subtitle: { fontSize: 26, align: 'center' },
  body: { fontSize: 24, align: 'left' },
  body2: { fontSize: 24, align: 'left' }
}

export function getSlideTheme(id?: string | null): SlideTheme {
  return SLIDE_THEMES.find((theme) => theme.id === id) ?? SLIDE_THEMES[0]
}

type PlaceholderSpec = {
  role: PlaceholderRole
  x: number
  y: number
  w: number
  h: number
  placeholder: string
  align?: string
}

/** Placeholder boxes of a layout, in slide pixels (scaled to w x h). */
export function getLayoutPlaceholders(
  layout: SlideLayoutId,
  w: number = SLIDE_WIDTH,
  h: number = SLIDE_HEIGHT
): PlaceholderSpec[] {
  const sx = w / SLIDE_WIDTH
  const sy = h / SLIDE_HEIGHT
  const box = (
    role: PlaceholderRole,
    x: number,
    y: number,
    bw: number,
    bh: number,
    placeholder: string,
    align?: string
  ): PlaceholderSpec => ({ role, x: x * sx, y: y * sy, w: bw * sx, h: bh * sy, placeholder, align })
  const title = box('title', 64, 40, 1152, 110, 'Click to add title')
  switch (layout) {
    case 'title':
      return [
        box('title', 120, 210, 1040, 150, 'Click to add title', 'center'),
        box('subtitle', 120, 380, 1040, 100, 'Click to add subtitle', 'center')
      ]
    case 'title-content':
      return [title, box('body', 64, 170, 1152, 500, 'Click to add text')]
    case 'two-column':
      return [
        title,
        box('body', 64, 170, 556, 500, 'Click to add text'),
        box('body2', 660, 170, 556, 500, 'Click to add text')
      ]
    default:
      return []
  }
}

// Same structure TextShape's editor produces, so a seeded box and a typed one
// look alike: a heading for titles, a bullet list for bodies.
function seedFragment(fragment: Y.XmlFragment, role: PlaceholderRole, align?: string): void {
  const textBlock = (name: string): Y.XmlElement => {
    // Attributes as y-prosemirror stores them (the heading level is a number).
    const el = new Y.XmlElement<{ [key: string]: string | number }>(name)
    if (name === 'heading') el.setAttribute('level', 1)
    if (align) el.setAttribute('textAlign', align)
    el.insert(0, [new Y.XmlText()])
    return el as unknown as Y.XmlElement
  }
  if (role === 'title') {
    fragment.insert(0, [textBlock('heading')])
  } else if (role === 'subtitle') {
    fragment.insert(0, [textBlock('paragraph')])
  } else {
    const list = new Y.XmlElement('bulletList')
    const item = new Y.XmlElement('listItem')
    item.insert(0, [textBlock('paragraph')])
    list.insert(0, [item])
    fragment.insert(0, [list])
  }
}

function placeholderShape(id: string, spec: PlaceholderSpec, z: number): Shape {
  return {
    id,
    name: spec.role === 'title' ? 'Title' : spec.role === 'subtitle' ? 'Subtitle' : 'Content',
    type: ShapeType.Text,
    role: spec.role,
    content: {
      type: spec.role === 'title' ? 'title' : 'content',
      value: '',
      placeholder: spec.placeholder
    },
    x: spec.x,
    y: spec.y,
    w: spec.w,
    h: spec.h,
    z,
    visible: true,
    selected: false
  }
}

function isFragmentEmpty(fragment?: Y.XmlFragment | null): boolean {
  if (!fragment) return true
  const text = fragment
    .toArray()
    .map((node) =>
      node instanceof Y.XmlElement || node instanceof Y.XmlText ? node.toString() : ''
    )
    .join('')
  return !text.replace(/<[^>]*>/g, '').trim() && !text.includes('<variable')
}

/**
 * Gives a slide a layout. Placeholders the layout keeps are moved to its boxes
 * (their text stays), missing ones are created, and empty placeholders it does
 * not have are removed. Shapes the user added are left alone.
 */
export function applyLayoutToDoc(
  ydoc: Y.Doc,
  layout: SlideLayoutId,
  newId: () => string,
  w: number = SLIDE_WIDTH,
  h: number = SLIDE_HEIGHT
): void {
  const shapes = ydoc.getMap<Shape>('shapes')
  const texts = ydoc.getMap<Y.XmlFragment>('texts')
  const meta = ydoc.getMap<unknown>('meta')
  const specs = getLayoutPlaceholders(layout, w, h)
  ydoc.transact(() => {
    const byRole = new Map<string, Shape>()
    shapes.forEach((shape) => {
      if (shape?.role) byRole.set(shape.role, shape)
    })
    for (const [role, shape] of byRole) {
      if (specs.some((spec) => spec.role === role)) continue
      if (!isFragmentEmpty(texts.get(shape.id))) continue
      shapes.delete(shape.id)
      texts.delete(shape.id)
    }
    let z = 0
    shapes.forEach((shape) => {
      z = Math.max(z, (shape.z ?? 0) + 1)
    })
    for (const spec of specs) {
      const existing = byRole.get(spec.role)
      if (existing) {
        shapes.set(existing.id, { ...existing, x: spec.x, y: spec.y, w: spec.w, h: spec.h })
        continue
      }
      const id = newId()
      shapes.set(id, placeholderShape(id, spec, z++))
      const fragment = new Y.XmlFragment()
      texts.set(id, fragment)
      seedFragment(fragment, spec.role, spec.align)
    }
    meta.set('layout', layout)
  })
}

/** Content of a new slide: its layout's placeholders and its theme. */
export function seedSlideDoc(
  ydoc: Y.Doc,
  layout: SlideLayoutId,
  themeId: string | null | undefined,
  newId: () => string,
  w: number = SLIDE_WIDTH,
  h: number = SLIDE_HEIGHT
): void {
  const meta = ydoc.getMap<unknown>('meta')
  ydoc.transact(() => {
    meta.set('theme', getSlideTheme(themeId).id)
    meta.set('slideWidth', w)
    meta.set('slideHeight', h)
  })
  applyLayoutToDoc(ydoc, layout, newId, w, h)
}

/** The background a slide shows: its own, else its theme's. */
export function resolveSlideBackground(meta: { get(key: string): unknown }): unknown {
  return (
    meta.get('background') ||
    (meta.get('master') as { background?: unknown } | undefined)?.background ||
    getSlideTheme(meta.get('theme') as string).background
  )
}
