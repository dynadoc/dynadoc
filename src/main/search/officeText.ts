/**
 * The text of a Word (.docx) or Excel (.xlsx) file, part by part, for the
 * multi-file search (#136).
 *
 * Every part a user puts text in is read: for Word the body, headers, footers,
 * footnotes, endnotes, comments and text boxes; for Excel the cells (shared
 * strings, inline strings, values as stored), formulas, sheet names, defined
 * names, comments, threaded comments, headers and footers, and the text of
 * shapes and text boxes in drawings. Each piece of text comes back as a
 * segment with a location a person can read ("header 1, paragraph 2",
 * "Données!B3 (formula)").
 *
 * Search only: nothing here writes a package.
 *
 * Pure: fflate and htmlparser2 (both MIT), no Electron and no Node import, so
 * tests/smoke bundles it on its own and another process can run the same code.
 */

import { strFromU8 } from 'fflate'
import { Parser } from 'htmlparser2'
import { inflateWithinLimits, type ZipLimits } from '../../renderer/src/shared/zipLimits'

export type OfficeKind = 'docx' | 'xlsx'

export type OfficeSegment = {
  /** The package part, e.g. `word/header1.xml`. */
  part: string
  /** Where the text is, for a person. */
  label: string
  /** The text; a line break inside a paragraph is `\n`. */
  text: string
}

export type OfficeExtraction =
  | { ok: true; segments: OfficeSegment[] }
  | {
      ok: false
      reason: string
      /** Not about the file (search cancelled, worker crashed): never cached. */
      transient?: boolean
    }

/** Limits for a package read by the search: smaller than an import's. */
export const OFFICE_SEARCH_ZIP_LIMITS: ZipLimits = {
  maxTotalBytes: 100 * 1024 * 1024,
  maxEntryBytes: 50 * 1024 * 1024,
  maxEntries: 5000
}

export function officeKindOf(filePath: string): OfficeKind | null {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

type Attributes = Record<string, string>

/** `x:c` and `c` are the same SpreadsheetML element: the prefix is free. */
function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

/**
 * Runs a SAX pass over one XML part. With `local`, element names reach the
 * handlers without their namespace prefix (SpreadsheetML written as `x:c` by
 * some producers); WordprocessingML and DrawingML keep their prefixes, which
 * those producers always write.
 */
function parseXml(
  xml: string,
  handlers: {
    open: (name: string, attributes: Attributes) => void
    text: (text: string) => void
    close: (name: string) => void
  },
  local = false
): void {
  const named = local ? localName : (name: string): string => name
  const parser = new Parser(
    {
      onopentag: (name, attributes) => handlers.open(named(name), attributes),
      ontext: (text) => handlers.text(text),
      onclosetag: (name) => handlers.close(named(name))
    },
    { xmlMode: true, decodeEntities: true }
  )
  parser.write(xml)
  parser.end()
}

function numberIn(partName: string): string {
  const match = /(\d+)\.xml$/.exec(partName)
  return match ? match[1] : '1'
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

const DOCX_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/

function docxPartLabel(part: string): string {
  const name = part.replace(/^word\//, '').replace(/\.xml$/, '')
  if (name === 'document') return 'body'
  if (name.startsWith('header')) return `header ${numberIn(part)}`
  if (name.startsWith('footer')) return `footer ${numberIn(part)}`
  return name
}

/**
 * One segment per paragraph (`w:p`). The `w:t` of every run of a paragraph
 * are joined, so a word split by formatting is one word. Deleted text
 * (`w:delText`), field codes (`w:instrText`) and moved-away text are not
 * read. A text box Word stored twice (DrawingML in `mc:Choice`, VML in
 * `mc:Fallback`) is read once, from the DrawingML copy.
 */
function docxPartSegments(part: string, xml: string): OfficeSegment[] {
  const segments: OfficeSegment[] = []
  const partLabel = docxPartLabel(part)
  const stack: string[] = []
  type Paragraph = { text: string; label: string }
  const paragraphs: Paragraph[] = []
  let skipDepth = 0
  let inText = false
  let topParagraphs = 0
  let textBoxes = 0
  const textBoxStack: Array<{ index: number; paragraphs: number; anchor: string }> = []
  let note: string | null = null
  let noteParagraphs = 0

  const SKIP = new Set(['mc:Fallback', 'w:del', 'w:moveFrom', 'w:instrText', 'w:delText'])

  parseXml(xml, {
    open(name, attributes) {
      stack.push(name)
      if (skipDepth > 0 || SKIP.has(name)) {
        skipDepth += 1
        return
      }
      const paragraph = paragraphs[paragraphs.length - 1]
      switch (name) {
        case 'w:footnote':
        case 'w:endnote':
        case 'w:comment': {
          const kind = name.slice(2)
          note = `${kind} ${attributes['w:id'] ?? ''}`.trim()
          noteParagraphs = 0
          break
        }
        case 'w:txbxContent': {
          textBoxes += 1
          // Anchored in the paragraph being read: a body paragraph, or one of
          // the note or comment the box sits in.
          textBoxStack.push({
            index: textBoxes,
            paragraphs: 0,
            anchor: note
              ? `${note}, paragraph ${noteParagraphs}`
              : `${partLabel}, paragraph ${topParagraphs}`
          })
          break
        }
        case 'w:p': {
          let label: string
          const box = textBoxStack[textBoxStack.length - 1]
          if (box) {
            box.paragraphs += 1
            label = `text box ${box.index} (${box.anchor}), paragraph ${box.paragraphs}`
          } else if (note) {
            noteParagraphs += 1
            label = `${note}, paragraph ${noteParagraphs}`
          } else {
            topParagraphs += 1
            label = `${partLabel}, paragraph ${topParagraphs}`
          }
          paragraphs.push({ text: '', label })
          break
        }
        case 'w:t':
          inText = true
          break
        case 'w:tab':
          if (paragraph) paragraph.text += '\t'
          break
        case 'w:br':
        case 'w:cr':
          if (paragraph) paragraph.text += '\n'
          break
        case 'w:noBreakHyphen':
          if (paragraph) paragraph.text += '-'
          break
      }
    },
    text(text) {
      if (skipDepth > 0 || !inText) return
      const paragraph = paragraphs[paragraphs.length - 1]
      if (paragraph) paragraph.text += text
    },
    close(name) {
      stack.pop()
      if (skipDepth > 0) {
        skipDepth -= 1
        return
      }
      switch (name) {
        case 'w:t':
          inText = false
          break
        case 'w:p': {
          const paragraph = paragraphs.pop()
          if (paragraph && paragraph.text.trim()) {
            segments.push({ part, label: paragraph.label, text: paragraph.text })
          }
          break
        }
        case 'w:txbxContent':
          textBoxStack.pop()
          break
        case 'w:footnote':
        case 'w:endnote':
        case 'w:comment':
          note = null
          break
      }
    }
  })
  return segments
}

function docxSegments(files: Record<string, Uint8Array>): OfficeSegment[] {
  const parts = Object.keys(files)
    .filter((name) => DOCX_PARTS.test(name))
    .sort((a, b) => docxOrder(a) - docxOrder(b) || a.localeCompare(b, 'en', { numeric: true }))
  const segments: OfficeSegment[] = []
  for (const part of parts) segments.push(...docxPartSegments(part, strFromU8(files[part])))
  return segments
}

function docxOrder(part: string): number {
  if (part === 'word/document.xml') return 0
  if (part.startsWith('word/header')) return 1
  if (part.startsWith('word/footer')) return 2
  if (part === 'word/footnotes.xml') return 3
  if (part === 'word/endnotes.xml') return 4
  return 5
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

/** Resolves a relationship target against the folder of the part that owns it. */
function resolveTarget(ownerPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const base = ownerPart.split('/').slice(0, -1)
  for (const piece of target.split('/')) {
    if (piece === '..') base.pop()
    else if (piece && piece !== '.') base.push(piece)
  }
  return base.join('/')
}

function relsPathOf(part: string): string {
  if (!part) return '_rels/.rels'
  const pieces = part.split('/')
  const name = pieces.pop()
  return [...pieces, '_rels', `${name}.rels`].join('/')
}

function readRelationships(
  files: Record<string, Uint8Array>,
  ownerPart: string
): Array<{ id: string; type: string; target: string }> {
  const rels = files[relsPathOf(ownerPart)]
  if (!rels) return []
  const out: Array<{ id: string; type: string; target: string }> = []
  parseXml(
    strFromU8(rels),
    {
      open(name, attributes) {
        if (name !== 'Relationship' || attributes.TargetMode === 'External') return
        out.push({
          id: attributes.Id,
          type: attributes.Type || '',
          target: resolveTarget(ownerPart, attributes.Target || '')
        })
      },
      text: () => undefined,
      close: () => undefined
    },
    true
  )
  return out
}

/** Text of a run container (`si`, `is`, a comment's `text`), phonetic hints left out. */
function collectRunText(): {
  open: (name: string) => void
  text: (text: string) => void
  close: (name: string) => void
  take: () => string
} {
  let buffer = ''
  let inT = 0
  let inPhonetic = 0
  return {
    open(name) {
      if (name === 'rPh') inPhonetic += 1
      if (name === 't') inT += 1
    },
    text(text) {
      if (inT > 0 && inPhonetic === 0) buffer += text
    },
    close(name) {
      if (name === 'rPh') inPhonetic -= 1
      if (name === 't') inT -= 1
    },
    take() {
      const value = buffer
      buffer = ''
      return value
    }
  }
}

function sharedStrings(files: Record<string, Uint8Array>, workbookPart: string): string[] {
  const rel = readRelationships(files, workbookPart).find((item) =>
    item.type.endsWith('/sharedStrings')
  )
  const part = rel?.target ?? 'xl/sharedStrings.xml'
  const bytes = files[part]
  if (!bytes) return []
  const strings: string[] = []
  const runs = collectRunText()
  let inItem = false
  parseXml(
    strFromU8(bytes),
    {
      open(name) {
        if (name === 'si') inItem = true
        if (inItem) runs.open(name)
      },
      text(text) {
        if (inItem) runs.text(text)
      },
      close(name) {
        if (inItem) runs.close(name)
        if (name === 'si') {
          strings.push(runs.take())
          inItem = false
        }
      }
    },
    true
  )
  return strings
}

/** Removes the formatting codes of an Excel header or footer (`&L`, `&"Arial,Bold"`, `&12`). */
export function stripHeaderFooterCodes(value: string): string {
  return value
    .replace(/&&/g, '\ue000')
    .replace(/&"[^"]*"/g, '')
    .replace(/&\d+/g, '')
    .replace(/&[LCRPNDTFAZGBIUSXYKHE]/gi, ' ')
    .replace(/\ue000/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function sheetSegments(
  files: Record<string, Uint8Array>,
  sheetName: string,
  part: string,
  strings: string[]
): OfficeSegment[] {
  const bytes = files[part]
  if (!bytes) return []
  const segments: OfficeSegment[] = []
  let cell: { ref: string; type: string } | null = null
  let value = ''
  let formula = ''
  let inValue = false
  let inFormula = false
  let inline = false
  const inlineRuns = collectRunText()
  let headerFooter: string | null = null
  let headerFooterText = ''

  parseXml(
    strFromU8(bytes),
    {
      open(name, attributes) {
        if (name === 'c') {
          cell = { ref: attributes.r || '', type: attributes.t || 'n' }
          value = ''
          formula = ''
          return
        }
        if (!cell) {
          if (/^(odd|even|first)(Header|Footer)$/.test(name)) {
            headerFooter = name
            headerFooterText = ''
          }
          return
        }
        if (name === 'v') inValue = true
        else if (name === 'f') inFormula = true
        else if (name === 'is') inline = true
        if (inline) inlineRuns.open(name)
      },
      text(text) {
        if (headerFooter) headerFooterText += text
        if (!cell) return
        if (inValue) value += text
        else if (inFormula) formula += text
        else if (inline) inlineRuns.text(text)
      },
      close(name) {
        if (headerFooter === name) {
          const text = stripHeaderFooterCodes(headerFooterText)
          const kind = name.replace(/(Header|Footer)$/, ' $1').toLowerCase()
          if (text) segments.push({ part, label: `${sheetName} (${kind})`, text })
          headerFooter = null
          return
        }
        if (!cell) return
        if (inline) inlineRuns.close(name)
        if (name === 'v') inValue = false
        else if (name === 'f') inFormula = false
        else if (name === 'is') inline = false
        else if (name === 'c') {
          const current: { ref: string; type: string } = cell
          let text = ''
          if (current.type === 's') text = strings[Number(value)] ?? ''
          else if (current.type === 'inlineStr') text = inlineRuns.take()
          else if (current.type === 'b')
            text = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
          else text = value
          if (text) segments.push({ part, label: `${sheetName}!${current.ref}`, text })
          // A shared formula has its text on its first cell only; the others are empty.
          if (formula.trim()) {
            segments.push({
              part,
              label: `${sheetName}!${current.ref} (formula)`,
              text: `=${formula}`
            })
          }
          cell = null
        }
      }
    },
    true
  )
  return segments
}

function commentSegments(
  files: Record<string, Uint8Array>,
  sheetName: string,
  part: string,
  threaded: boolean,
  skipRefs: ReadonlySet<string> = new Set()
): OfficeSegment[] {
  const bytes = files[part]
  if (!bytes) return []
  const segments: OfficeSegment[] = []
  const container = threaded ? 'threadedComment' : 'comment'
  let ref: string | null = null
  let buffer = ''
  let inText = 0
  const runs = collectRunText()
  parseXml(
    strFromU8(bytes),
    {
      open(name, attributes) {
        if (name === container) {
          ref = attributes.ref || ''
          buffer = ''
          return
        }
        if (ref === null) return
        if (threaded) {
          if (name === 'text') inText += 1
        } else {
          runs.open(name)
        }
      },
      text(text) {
        if (ref === null) return
        if (threaded) {
          if (inText > 0) buffer += text
        } else {
          runs.text(text)
        }
      },
      close(name) {
        if (ref === null) return
        if (name === container) {
          const text = threaded ? buffer : runs.take()
          if (text.trim() && !skipRefs.has(ref)) {
            segments.push({
              part,
              label: `${sheetName}!${ref} (${threaded ? 'threaded comment' : 'comment'})`,
              text
            })
          }
          ref = null
          return
        }
        if (threaded) {
          if (name === 'text') inText -= 1
        } else {
          runs.close(name)
        }
      }
    },
    true
  )
  return segments
}

/** Text of shapes and text boxes in a drawing: one segment per paragraph (`a:p`). */
function drawingSegments(
  files: Record<string, Uint8Array>,
  sheetName: string,
  part: string
): OfficeSegment[] {
  const bytes = files[part]
  if (!bytes) return []
  const segments: OfficeSegment[] = []
  let shape = 0
  let paragraph: string | null = null
  let paragraphs = 0
  let inText = 0
  let skip = 0
  parseXml(strFromU8(bytes), {
    open(name) {
      if (skip > 0 || name === 'mc:Fallback') {
        skip += 1
        return
      }
      if (name === 'xdr:sp') {
        shape += 1
        paragraphs = 0
      } else if (name === 'a:p') {
        paragraph = ''
        paragraphs += 1
      } else if (name === 'a:t') {
        inText += 1
      } else if (name === 'a:br' && paragraph !== null) {
        paragraph += '\n'
      }
    },
    text(text) {
      if (skip === 0 && inText > 0 && paragraph !== null) paragraph += text
    },
    close(name) {
      if (skip > 0) {
        skip -= 1
        return
      }
      if (name === 'a:t') inText -= 1
      else if (name === 'a:p') {
        if (paragraph && paragraph.trim()) {
          segments.push({
            part,
            label: `${sheetName}, shape ${shape}, paragraph ${paragraphs}`,
            text: paragraph
          })
        }
        paragraph = null
      }
    }
  })
  return segments
}

function xlsxSegments(files: Record<string, Uint8Array>): OfficeSegment[] {
  // The workbook is the package's officeDocument relationship; Excel always
  // puts it at xl/workbook.xml, which is the fallback.
  const workbookPart =
    readRelationships(files, '').find((rel) => rel.type.endsWith('/officeDocument'))?.target ??
    'xl/workbook.xml'
  const workbook = files[workbookPart]
  if (!workbook) return []
  const relations = readRelationships(files, workbookPart)
  const sheets: Array<{ name: string; part: string | null }> = []
  const definedNames: Array<{ name: string; ref: string }> = []
  let definedName: { name: string; ref: string } | null = null

  parseXml(
    strFromU8(workbook),
    {
      open(name, attributes) {
        if (name === 'sheet') {
          const rel = relations.find((item) => item.id === attributes['r:id'])
          sheets.push({ name: attributes.name || '', part: rel?.target ?? null })
        } else if (name === 'definedName') {
          definedName = { name: attributes.name || '', ref: '' }
        }
      },
      text(text) {
        if (definedName) definedName.ref += text
      },
      close(name) {
        if (name === 'definedName' && definedName) {
          definedNames.push(definedName)
          definedName = null
        }
      }
    },
    true
  )

  const strings = sharedStrings(files, workbookPart)
  const segments: OfficeSegment[] = []
  for (const sheet of sheets) {
    segments.push({ part: workbookPart, label: 'sheet name', text: sheet.name })
  }
  for (const item of definedNames) {
    segments.push({
      part: workbookPart,
      label: `defined name ${item.name}`,
      text: `${item.name} = ${item.ref}`
    })
  }
  for (const sheet of sheets) {
    if (!sheet.part) continue
    segments.push(...sheetSegments(files, sheet.name, sheet.part, strings))
    const sheetRels = readRelationships(files, sheet.part)
    // Excel 365 writes each threaded comment twice: in threadedComments, and
    // as a legacy note in commentsN.xml (author `tc={GUID}`) for older
    // readers. Read the threaded one; skip the legacy copy of the same cell.
    const threadedSegments = sheetRels
      .filter((rel) => rel.type.endsWith('/threadedComment'))
      .flatMap((rel) => commentSegments(files, sheet.name, rel.target, true))
    const threadedRefs = new Set(
      threadedSegments.map((segment) => /!([^ ]+) \(/.exec(segment.label)?.[1] ?? '')
    )
    for (const rel of sheetRels) {
      if (rel.type.endsWith('/comments')) {
        segments.push(...commentSegments(files, sheet.name, rel.target, false, threadedRefs))
      } else if (rel.type.endsWith('/drawing')) {
        segments.push(...drawingSegments(files, sheet.name, rel.target))
      }
    }
    segments.push(...threadedSegments)
  }
  return segments
}

/** Every part the search reads, by package kind. */
function wantedPart(kind: OfficeKind, name: string): boolean {
  if (name.endsWith('.rels')) return true
  if (kind === 'docx') return DOCX_PARTS.test(name)
  // Spreadsheet parts are found through relationships, wherever they are.
  return name.endsWith('.xml')
}

/**
 * Reads the text of a package. A file that is not a valid package, or that
 * would unpack past the limits, comes back with `ok: false` and the reason;
 * it never throws.
 */
export function extractOfficeText(
  bytes: Uint8Array,
  kind: OfficeKind,
  limits: ZipLimits = OFFICE_SEARCH_ZIP_LIMITS
): OfficeExtraction {
  // One pass: only the parts read below are inflated, and counted against the
  // limits as they inflate. Images and other media are never inflated.
  const inflated = inflateWithinLimits(
    bytes,
    limits,
    kind === 'docx'
      ? { file: 'Word (.docx) file', thing: 'document' }
      : { file: 'Excel (.xlsx) file', thing: 'workbook' },
    (name) => wantedPart(kind, name)
  )
  if (inflated.problem !== null) return { ok: false, reason: inflated.problem }
  const files = inflated.files
  try {
    return { ok: true, segments: kind === 'docx' ? docxSegments(files) : xlsxSegments(files) }
  } catch {
    return { ok: false, reason: 'unreadable XML' }
  }
}
