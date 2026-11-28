/**
 * Runs a search over the text of a .docx or .xlsx file (#136), and returns the
 * matches in the shape of the multi-file search, each with its location.
 *
 * Pure: no Electron and no Node import (tests/smoke bundles it).
 */

import { extractOfficeText, officeKindOf, type OfficeSegment } from './officeText'

export type OfficeMatch = {
  /** The segment's position in the file, from 1: stands in for a line number. */
  line: number
  column: number
  length: number
  preview: string
  before: string
  match: string
  after: string
  location: { part: string; label: string }
}

export type OfficeSearchResult = {
  matches: OfficeMatch[]
  truncated: boolean
  /** Why the file was not read, when it was not. */
  skipped?: string
}

/**
 * `matcher` must be global (the search builds it with `g`). A segment is
 * matched line by line, like a text file, so a match never spans a line break
 * inside a paragraph or a cell.
 */
export function searchOfficeFile(
  filePath: string,
  bytes: Uint8Array,
  matcher: RegExp,
  limit: number
): OfficeSearchResult {
  const kind = officeKindOf(filePath)
  if (!kind) return { matches: [], truncated: false, skipped: 'not a .docx or .xlsx file' }
  const extracted = extractOfficeText(bytes, kind)
  if (!extracted.ok) return { matches: [], truncated: false, skipped: extracted.reason }
  return matchSegments(extracted.segments, matcher, limit)
}

export function matchSegments(
  segments: OfficeSegment[],
  matcher: RegExp,
  limit: number
): OfficeSearchResult {
  const pattern = matcher.global ? matcher : new RegExp(matcher.source, `${matcher.flags}g`)
  const matches: OfficeMatch[] = []
  for (const [index, segment] of segments.entries()) {
    for (const lineText of segment.text.split('\n')) {
      pattern.lastIndex = 0
      let found: RegExpExecArray | null
      while ((found = pattern.exec(lineText)) !== null) {
        const matched = found[0]
        if (!matched) {
          pattern.lastIndex += 1
          continue
        }
        matches.push({
          line: index + 1,
          column: found.index + 1,
          length: matched.length,
          preview: lineText.trim(),
          before: lineText.slice(0, found.index),
          match: matched,
          after: lineText.slice(found.index + matched.length),
          location: { part: segment.part, label: segment.label }
        })
        if (matches.length >= limit) return { matches, truncated: true }
      }
    }
  }
  return { matches, truncated: false }
}
