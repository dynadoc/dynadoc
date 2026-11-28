/**
 * The visible text of a document, with a map back to the bytes it came from.
 *
 * Search and replace across files both read a document through this model, so
 * what the Search panel shows is exactly what a replace changes (#137). Before,
 * search ran on text stripped by regular expressions while replace ran on the
 * raw HTML: a replace could rewrite an attribute or a URL, and a match split by
 * formatting (`Acme <b>Corp</b>`) was found but never replaced.
 *
 * How the text is built:
 * - only text nodes contribute. Tag names, attributes (href, src, style, data-*),
 *   comments, `<script>`, `<style>`, `<template>`, `<head>` and the inside of
 *   `<svg>` and `<math>` never do;
 * - inline elements (`<b>`, `<span>`, `<a>`, ...) contribute nothing, so a word
 *   split by formatting reads as one word;
 * - block elements and `<br>` end a line: a match never spans two paragraphs;
 * - an embedded object (`<img>`, `<svg>`, `<iframe>`, ...) reads as U+FFFC, so
 *   text on both sides of an image never matches as one word, and a replace
 *   never removes the object;
 * - runs of white space read as one space, as the browser shows them, except
 *   inside `<pre>`;
 * - character references are decoded (`&amp;` is `&`, `&nbsp;` reads as a space).
 *
 * Text inside a node the editor does not let the user type into (a variable
 * chip, an HTML comment placeholder, anything `contenteditable="false"`) is
 * searchable but protected: a match touching it is listed in the preview as
 * skipped and never written.
 *
 * Replacing writes the whole replacement into the text run of the first
 * matched character, so it takes that character's formatting, and removes the
 * other matched characters from their own runs. Tags are never touched.
 *
 * No Electron and no Node import: tests/smoke bundles this file on its own, and
 * the stub bridge runs the same code for the web build.
 */

/** Character flags in a {@link TextModel}. */
export const CHAR_SYNTHETIC = 1 // line break or object placeholder, not text in the source
export const CHAR_PROTECTED = 2 // inside a node the user cannot type into
export const CHAR_OBJECT = 4 // placeholder for an embedded object

export const OBJECT_PLACEHOLDER = '\uFFFC'

export type TextModel = {
  /** The visible text, `\n` between blocks. */
  text: string
  /** For each character of `text`: where its source starts in the raw input. */
  rawStart: number[]
  /** For each character of `text`: where its source ends in the raw input. */
  rawEnd: number[]
  /** For each character of `text`: CHAR_* flags. */
  flags: number[]
}

export type TextMatch = {
  /** Offsets in `TextModel.text`. */
  start: number
  end: number
  /** 1-based line and column, as the Search panel shows them. */
  line: number
  column: number
  before: string
  match: string
  after: string
  /** Why this match cannot be replaced, when it cannot. */
  blocked?: 'protected' | 'object'
  /** Capture groups of the match, for `$1` in a regular expression replace. */
  captures: Array<string | undefined>
  groups?: Record<string, string | undefined>
}

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** Void elements that show something: they read as one object placeholder. */
const VOID_OBJECTS = new Set(['embed', 'img', 'input'])

/** Elements whose content is read as raw text up to the closing tag, and skipped. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript'])

/** Elements whose content is not document text. */
const HIDDEN_ELEMENTS = new Set(['head', 'template'])

/** Elements shown as one embedded object: their content is not searchable text. */
const OBJECT_ELEMENTS = new Set([
  'audio',
  'canvas',
  'iframe',
  'math',
  'object',
  'select',
  'svg',
  'video'
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  deg: '\u00b0',
  middot: '\u00b7',
  bull: '\u2022',
  times: '\u00d7',
  divide: '\u00f7'
}

type OpenElement = {
  name: string
  protected: boolean
  hidden: boolean
  pre: boolean
}

function isWhiteSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

function isNameStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z]/.test(char)
}

type ParsedTag = {
  name: string
  end: number
  closing: boolean
  selfClosing: boolean
  attributes: Record<string, string>
}

/** Reads a tag starting at `start` (on `<`). Returns null when it is not a tag. */
function readTag(html: string, start: number): ParsedTag | null {
  let index = start + 1
  let closing = false
  if (html[index] === '/') {
    closing = true
    index += 1
  }
  if (!isNameStart(html[index])) return null
  const nameStart = index
  while (index < html.length && /[A-Za-z0-9:_-]/.test(html[index])) index += 1
  const name = html.slice(nameStart, index).toLowerCase()
  const attributes: Record<string, string> = {}
  let selfClosing = false

  while (index < html.length) {
    const char = html[index]
    if (char === '>') {
      return { name, end: index + 1, closing, selfClosing, attributes }
    }
    if (char === '/' && html[index + 1] === '>') {
      selfClosing = true
      index += 1
      continue
    }
    if (isWhiteSpace(char) || char === '/') {
      index += 1
      continue
    }
    const attrStart = index
    while (index < html.length && !isWhiteSpace(html[index]) && !'/>='.includes(html[index])) {
      index += 1
    }
    const attrName = html.slice(attrStart, index).toLowerCase()
    while (index < html.length && isWhiteSpace(html[index])) index += 1
    let value = ''
    if (html[index] === '=') {
      index += 1
      while (index < html.length && isWhiteSpace(html[index])) index += 1
      const quote = html[index]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1)
        if (close === -1) return null
        value = html.slice(index + 1, close)
        index = close + 1
      } else {
        const valueStart = index
        while (index < html.length && !isWhiteSpace(html[index]) && html[index] !== '>') index += 1
        value = html.slice(valueStart, index)
      }
    }
    if (attrName) attributes[attrName] = value
  }
  return null
}

/**
 * Decodes a character reference at `start` (on `&`). Null when it is not one.
 * A well-formed named reference this table does not know comes back with
 * `unknown`: it reads as one opaque character, so nothing matches inside it.
 */
function readEntity(
  html: string,
  start: number
): { value: string; end: number; unknown?: boolean } | null {
  const match = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(
    html.slice(start, start + 40)
  )
  if (!match) return null
  const body = match[1]
  let value: string | undefined
  if (body[0] === '#') {
    const code =
      body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        value = String.fromCodePoint(code)
      } catch {
        value = undefined
      }
    }
  } else {
    value = NAMED_ENTITIES[body]
    if (value === undefined) return { value: '\ufffd', end: start + match[0].length, unknown: true }
  }
  if (value === undefined) return null
  return { value, end: start + match[0].length }
}

function isProtectingElement(tag: ParsedTag): boolean {
  if (tag.name === 'var') return true
  if ('data-variable' in tag.attributes) return true
  if ('data-html-comment' in tag.attributes) return true
  const editable = tag.attributes['contenteditable']
  return editable !== undefined && editable.trim().toLowerCase() === 'false'
}

/** Builds the text model of an HTML document. */
export function htmlTextModel(html: string): TextModel {
  const text: string[] = []
  const rawStart: number[] = []
  const rawEnd: number[] = []
  const flags: number[] = []
  const stack: OpenElement[] = []
  let protectedDepth = 0
  let hiddenDepth = 0
  let preDepth = 0

  const last = (): string => (text.length ? text[text.length - 1] : '\n')
  const push = (char: string, start: number, end: number, flag: number): void => {
    text.push(char)
    rawStart.push(start)
    rawEnd.push(end)
    flags.push(flag | (protectedDepth > 0 ? CHAR_PROTECTED : 0))
  }
  const lineBreak = (at: number): void => {
    if (hiddenDepth > 0) return
    if (last() === '\n') return
    push('\n', at, at, CHAR_SYNTHETIC)
  }
  const objectPlaceholder = (start: number, end: number): void => {
    if (hiddenDepth > 0) return
    push(OBJECT_PLACEHOLDER, start, end, CHAR_SYNTHETIC | CHAR_OBJECT)
  }
  const open = (tag: ParsedTag): void => {
    const element: OpenElement = {
      name: tag.name,
      protected: isProtectingElement(tag),
      hidden: HIDDEN_ELEMENTS.has(tag.name) || OBJECT_ELEMENTS.has(tag.name),
      pre: tag.name === 'pre'
    }
    stack.push(element)
    if (element.protected) protectedDepth += 1
    if (element.hidden) hiddenDepth += 1
    if (element.pre) preDepth += 1
  }
  const close = (name: string): void => {
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      if (stack[depth].name !== name) continue
      while (stack.length > depth) {
        const element = stack.pop() as OpenElement
        if (element.protected) protectedDepth -= 1
        if (element.hidden) hiddenDepth -= 1
        if (element.pre) preDepth -= 1
      }
      return
    }
  }

  let index = 0
  while (index < html.length) {
    const char = html[index]

    if (char === '<') {
      if (html.startsWith('<!--', index)) {
        const end = html.indexOf('-->', index + 4)
        index = end === -1 ? html.length : end + 3
        continue
      }
      if (html[index + 1] === '!' || html[index + 1] === '?') {
        const end = html.indexOf('>', index + 2)
        index = end === -1 ? html.length : end + 1
        continue
      }
      const tag = readTag(html, index)
      if (tag) {
        const tagStart = index
        index = tag.end
        if (tag.closing) {
          if (BLOCK_ELEMENTS.has(tag.name)) lineBreak(tagStart)
          close(tag.name)
          continue
        }
        if (RAW_TEXT_ELEMENTS.has(tag.name)) {
          // Case-insensitive search on the document itself: a lowercased copy
          // can be longer than the original ('\u0130' lowercases to two units),
          // and its offsets would drift.
          const closing = new RegExp(`</${tag.name}(?=[\\s/>])`, 'gi')
          closing.lastIndex = index
          const closeAt = closing.exec(html)?.index ?? -1
          if (closeAt === -1) {
            index = html.length
          } else {
            const closeEnd = html.indexOf('>', closeAt)
            index = closeEnd === -1 ? html.length : closeEnd + 1
          }
          continue
        }
        if (tag.name === 'br') {
          lineBreak(tagStart)
          continue
        }
        if (BLOCK_ELEMENTS.has(tag.name)) lineBreak(tagStart)
        if (VOID_OBJECTS.has(tag.name)) {
          objectPlaceholder(tagStart, tag.end)
          continue
        }
        if (VOID_ELEMENTS.has(tag.name)) continue
        if (OBJECT_ELEMENTS.has(tag.name)) objectPlaceholder(tagStart, tag.end)
        if (tag.selfClosing) continue
        open(tag)
        continue
      }
      // A `<` that opens no tag is text.
    }

    if (hiddenDepth > 0) {
      index += 1
      continue
    }

    if (char === '&') {
      const entity = readEntity(html, index)
      if (entity) {
        const value = entity.value === '\u00a0' ? ' ' : entity.value
        const flag = entity.unknown ? CHAR_SYNTHETIC | CHAR_OBJECT : 0
        // A decoded character, even a pair of UTF-16 units, maps to the whole reference.
        for (let k = 0; k < value.length; k += 1) push(value[k], index, entity.end, flag)
        index = entity.end
        continue
      }
    }

    if (preDepth === 0 && isWhiteSpace(char)) {
      const start = index
      while (index < html.length && isWhiteSpace(html[index])) index += 1
      const previous = last()
      if (previous !== ' ' && previous !== '\n') push(' ', start, index, 0)
      continue
    }

    if (preDepth > 0 && char === '\r' && html[index + 1] === '\n') {
      index += 1
      continue
    }

    push(char === '\u00a0' ? ' ' : char, index, index + 1, 0)
    index += 1
  }

  return { text: text.join(''), rawStart, rawEnd, flags }
}

/** Builds the text model of a plain text file: every character is itself. */
export function plainTextModel(content: string): TextModel {
  const text: string[] = []
  const rawStart: number[] = []
  const rawEnd: number[] = []
  const flags: number[] = []
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    // `\r\n` is one line break, as the search has always read it.
    if (char === '\r' && content[index + 1] === '\n') continue
    text.push(char)
    rawStart.push(index)
    rawEnd.push(index + 1)
    flags.push(0)
  }
  return { text: text.join(''), rawStart, rawEnd, flags }
}

/** True for the files whose text is read through {@link htmlTextModel}. */
export function isHtmlDocumentPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.sddoc')
}

export function textModelFor(filePath: string, content: string): TextModel {
  return isHtmlDocumentPath(filePath) ? htmlTextModel(content) : plainTextModel(content)
}

export type FindOptions = {
  /** Stop after this many matches. */
  limit?: number
}

/**
 * Runs `matcher` over each line of the model. Empty matches are skipped. A
 * match is marked `blocked` when it covers protected text or an object.
 */
export function findInTextModel(
  model: TextModel,
  matcher: RegExp,
  options: FindOptions = {}
): { matches: TextMatch[]; truncated: boolean } {
  const limit = options.limit ?? Infinity
  const matches: TextMatch[] = []
  const pattern = matcher.global ? matcher : new RegExp(matcher.source, matcher.flags + 'g')
  const lines = model.text.split('\n')
  let lineOffset = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineText = lines[lineIndex]
    pattern.lastIndex = 0
    let found: RegExpExecArray | null
    while ((found = pattern.exec(lineText)) !== null) {
      const matched = found[0] || ''
      if (matched.length === 0) {
        pattern.lastIndex += 1
        continue
      }
      const start = lineOffset + found.index
      const end = start + matched.length
      // Without the `u` flag, `.` can match half of a character outside the
      // BMP. Replacing half a character would corrupt it: not a match.
      if (isLowSurrogate(model.text, start) || isLowSurrogate(model.text, end)) continue
      let blocked: TextMatch['blocked']
      for (let k = start; k < end; k += 1) {
        if (model.flags[k] & CHAR_OBJECT) {
          blocked = 'object'
          break
        }
        if (model.flags[k] & CHAR_PROTECTED) blocked = 'protected'
      }
      matches.push({
        start,
        end,
        line: lineIndex + 1,
        column: found.index + 1,
        before: lineText.slice(0, found.index),
        match: matched,
        after: lineText.slice(found.index + matched.length),
        captures: found.slice(1),
        ...(found.groups ? { groups: { ...found.groups } } : {}),
        ...(blocked ? { blocked } : {})
      })
      if (matches.length >= limit) return { matches, truncated: true }
    }
    lineOffset += lineText.length + 1
  }
  return { matches, truncated: false }
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff && index > 0 && isHighSurrogate(text, index - 1)
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code >= 0xd800 && code <= 0xdbff
}

export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type Edit = { start: number; end: number; insert: string }

/**
 * The raw edits that replace one match. The replacement goes where the first
 * matched character is, so it takes that character's formatting; the other
 * matched characters are removed from their own text runs. Only the source of
 * text characters is ever touched: the raw range between two characters that
 * are not adjacent in the source (a tag, skipped white space) is kept.
 */
function editsForMatch(model: TextModel, match: TextMatch, insert: string): Edit[] {
  const edits: Edit[] = []
  let first = true
  let index = match.start
  while (index < match.end) {
    if (model.flags[index] & CHAR_SYNTHETIC) {
      index += 1
      continue
    }
    const runStart = model.rawStart[index]
    let runEnd = model.rawEnd[index]
    let next = index + 1
    while (
      next < match.end &&
      !(model.flags[next] & CHAR_SYNTHETIC) &&
      (model.rawStart[next] === runEnd || model.rawStart[next] === model.rawStart[next - 1])
    ) {
      runEnd = Math.max(runEnd, model.rawEnd[next])
      next += 1
    }
    edits.push({ start: runStart, end: runEnd, insert: first ? insert : '' })
    first = false
    index = next
  }
  if (first) {
    // Nothing but synthetic characters: there is no text to put the replacement in.
    return []
  }
  return edits
}

/**
 * Expands `$$`, `$&`, `` $` ``, `$'`, `$1`..`$99` and `$<name>` in a
 * replacement, as String.prototype.replace does. `` $` `` and `$'` stop at the
 * line, since a match never spans one.
 */
export function expandReplacement(template: string, match: TextMatch): string {
  return template.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (token, kind, name, digits) => {
    if (kind === '$') return '$'
    if (kind === '&') return match.match
    if (kind === '`') return match.before
    if (kind === "'") return match.after
    if (name !== undefined) {
      if (!match.groups) return token
      return match.groups[name] ?? ''
    }
    if (digits !== undefined) {
      const count = match.captures.length
      let index = Number(digits)
      let rest = ''
      if (digits.length === 2 && (index === 0 || index > count)) {
        index = Number(digits[0])
        rest = digits[1]
      }
      if (index === 0 || index > count) return token
      return (match.captures[index - 1] ?? '') + rest
    }
    return token
  })
}

export type ReplaceOptions = {
  /** Expand `$1` and the like (regular expression mode). Otherwise literal. */
  expand?: boolean
  /** Indexes, in `matches`, of the matches the user chose not to replace. */
  skip?: ReadonlySet<number>
}

/** The text that replaces `match`, before any HTML escaping. */
export function replacementFor(
  match: TextMatch,
  replacement: string,
  options: ReplaceOptions = {}
): string {
  return options.expand ? expandReplacement(replacement, match) : replacement
}

export type ReplacePlan = {
  output: string
  /** Every match, in order; `blocked` ones were left as they are. */
  matches: TextMatch[]
  /** For each match: whether it was written. */
  applied: boolean[]
  replaced: number
}

/**
 * Replaces every unblocked match of `matcher` in `raw`, except the ones in
 * `options.skip`. The replacement is escaped for HTML when the file is HTML.
 */
export function planReplace(
  filePath: string,
  raw: string,
  matcher: RegExp,
  replacement: string,
  options: ReplaceOptions = {}
): ReplacePlan {
  const html = isHtmlDocumentPath(filePath)
  const model = html ? htmlTextModel(raw) : plainTextModel(raw)
  const { matches } = findInTextModel(model, matcher)
  const edits: Edit[] = []
  const applied: boolean[] = []
  let replaced = 0
  let lastEnd = 0
  matches.forEach((match, index) => {
    applied.push(false)
    if (match.blocked || options.skip?.has(index)) return
    const text = replacementFor(match, replacement, options)
    const forMatch = editsForMatch(model, match, html ? escapeHtmlText(text) : text)
    if (forMatch.length === 0) return
    // Matches come in document order and their edits in source order. An edit
    // that would reach back over an earlier one (two matches sharing the
    // source of one decoded character) is dropped with its whole match.
    if (forMatch.some((edit, k) => edit.start < (k === 0 ? lastEnd : forMatch[k - 1].end))) return
    edits.push(...forMatch)
    lastEnd = forMatch[forMatch.length - 1].end
    applied[index] = true
    replaced += 1
  })
  // One pass: the untouched source between edits, then each insert.
  const parts: string[] = []
  let cursor = 0
  for (const edit of edits) {
    parts.push(raw.slice(cursor, edit.start), edit.insert)
    cursor = edit.end
  }
  parts.push(raw.slice(cursor))
  return { output: parts.join(''), matches, applied, replaced }
}
