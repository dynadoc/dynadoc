// Style values a slide carries (colours, alignment, fonts, numbers) come from
// its Y.Doc, which collaborators and imported files write. Before one is
// placed in markup it is checked against the forms the slide renderer and the
// importer produce; anything else is refused and the caller uses its default.
// No imports: tests/smoke bundles this with the slide modules.

const NAMED_COLORS = new Set([
  'transparent',
  'black',
  'white',
  'gray',
  'grey',
  'silver',
  'red',
  'maroon',
  'orange',
  'gold',
  'yellow',
  'olive',
  'lime',
  'green',
  'teal',
  'aqua',
  'cyan',
  'blue',
  'navy',
  'indigo',
  'purple',
  'violet',
  'fuchsia',
  'magenta',
  'pink',
  'brown'
])

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?'
const ARGUMENT = `${NUMBER}(?:%|deg|rad|grad|turn)?`
const FUNCTION_COLOR = new RegExp(
  `^(?:rgba?|hsla?)\\(\\s*${ARGUMENT}(?:\\s*[,/]?\\s*${ARGUMENT}){2,3}\\s*\\)$`,
  'i'
)
const FONT_FAMILY = /^[A-Za-z0-9 ._-]{1,64}$/
const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify'])

/** A CSS colour in one of the accepted forms, or null. */
export function safeCssColor(value: unknown): string | null {
  // The length cap also bounds the work FUNCTION_COLOR can do on bad input.
  if (typeof value !== 'string' || value.length > 64) return null
  const v = value.trim()
  if (HEX_COLOR.test(v) || FUNCTION_COLOR.test(v)) return v
  return NAMED_COLORS.has(v.toLowerCase()) ? v.toLowerCase() : null
}

/** left | center | right | justify, or null. */
export function safeTextAlign(value: unknown): string | null {
  return typeof value === 'string' && TEXT_ALIGN.has(value) ? value : null
}

/** A single font family name (letters, digits, space, dot, dash, underscore), unquoted, or null. */
export function safeFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().replace(/^["']+|["']+$/g, '')
  return FONT_FAMILY.test(v) ? v : null
}

/** A finite number, or `fallback`. */
export function safeNumber(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(num) ? num : fallback
}

/** Escapes a value for a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
