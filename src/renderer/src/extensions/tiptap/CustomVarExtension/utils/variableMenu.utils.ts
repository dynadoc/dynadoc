// Pure helpers of the `@` variable menu: which variables answer what was
// typed, in which order, what part of the name to highlight, and whether the
// menu is a bottom sheet. Imports only the pure sheet helpers on purpose:
// tests/smoke/variable-menu.test.mjs compiles this file on its own.

import { isGlobalVisibility } from './sheetVariables.utils'

export type MenuCandidate = {
  name?: string
  displayName?: string
  aliases?: string[]
  source?: string
}

// Rank of a match, best first.
const RANK_EXACT = 0
const RANK_PREFIX = 1
const RANK_ALIAS = 2
const RANK_WORD = 3

const nameOf = (item: MenuCandidate): string => String(item?.displayName || item?.name || '')

// Where each word of a name starts: `client_ville` → 0, 7.
const wordStarts = (name: string): number[] => {
  const starts: number[] = []
  for (let i = 0; i < name.length; i++) {
    if (i === 0 || /[\s_.-]/.test(name[i - 1])) starts.push(i)
  }
  return starts
}

/**
 * How well `item` answers `query`, or null when it does not: the name itself,
 * then a name starting with it, an alias starting with it, a word of the name
 * starting with it (`ville` finds `client_ville`). Case does not matter. An
 * empty query matches everything.
 */
export function matchRank(item: MenuCandidate, query: string): number | null {
  const needle = String(query ?? '').toLowerCase()
  const name = nameOf(item).toLowerCase()
  if (!needle) return RANK_PREFIX
  if (name === needle) return RANK_EXACT
  if (name.startsWith(needle)) return RANK_PREFIX
  const aliases = Array.isArray(item?.aliases) ? item.aliases : []
  if (
    aliases.some((alias) =>
      String(alias ?? '')
        .toLowerCase()
        .startsWith(needle)
    )
  ) {
    return RANK_ALIAS
  }
  if (wordStarts(name).some((start) => name.startsWith(needle, start))) return RANK_WORD
  return null
}

/**
 * The variables that answer `query`, best match first; within a rank, the
 * user's own before the AI's, then by name.
 */
export function rankVariableMatches<T extends MenuCandidate>(items: T[], query: string): T[] {
  return (items || [])
    .map((item) => ({ item, rank: matchRank(item, query) }))
    .filter((entry): entry is { item: T; rank: number } => entry.rank !== null)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      const aAi = a.item.source === 'ai' ? 1 : 0
      const bAi = b.item.source === 'ai' ? 1 : 0
      if (aAi !== bAi) return aAi - bAi
      return nameOf(a.item).localeCompare(nameOf(b.item))
    })
    .map((entry) => entry.item)
}

/**
 * `name` cut around the part `query` matched, for the menu to highlight it:
 * the start of the name, or the start of one of its words. All in `before`
 * when nothing matched.
 */
export function splitMatch(
  name: string,
  query: string
): { before: string; match: string; after: string } {
  const text = String(name ?? '')
  const needle = String(query ?? '').toLowerCase()
  const lower = text.toLowerCase()
  if (needle) {
    const start = wordStarts(lower).find((index) => lower.startsWith(needle, index))
    if (start !== undefined) {
      return {
        before: text.slice(0, start),
        match: text.slice(start, start + needle.length),
        after: text.slice(start + needle.length)
      }
    }
  }
  return { before: text, match: '', after: '' }
}

export type VariableScope = 'desktop' | 'doc'

/** Desktop: a global variable, seen by every file. Doc: this document's own. */
export function variableScope(raw: { visibility?: unknown } | null | undefined): VariableScope {
  return isGlobalVisibility(raw?.visibility) ? 'desktop' : 'doc'
}

/** The visibility a variable created from the menu is saved with. */
export function scopeVisibility(scope: VariableScope): string {
  return scope === 'desktop' ? 'desktop' : 'package'
}

/**
 * The menu offers to create `@query` when something was typed and no listed
 * variable already has that name.
 */
export function canCreateVariable(query: string, items: MenuCandidate[]): boolean {
  const name = String(query ?? '').trim()
  if (!name) return false
  const needle = name.toLowerCase()
  return !(items || []).some((item) => nameOf(item).toLowerCase() === needle)
}

/** The row ↑ (-1) or ↓ (+1) moves to, wrapping around; 0 with no rows. */
export function moveActiveRow(current: number, delta: number, rowCount: number): number {
  if (rowCount <= 0) return 0
  const from = Number.isInteger(current) ? current : 0
  return (((from + delta) % rowCount) + rowCount) % rowCount
}

/** Widest viewport, in CSS pixels, where the menu is a bottom sheet. */
export const COMPACT_MAX_WIDTH = 600

/** A phone or a narrow window: the menu is a bottom sheet, not a dropdown. */
export function isCompactViewport(width: number, coarsePointer: boolean): boolean {
  return Boolean(coarsePointer) || (Number.isFinite(width) && width <= COMPACT_MAX_WIDTH)
}

/**
 * How far above the bottom of the layout viewport the visible part ends: the
 * height of the on-screen keyboard, which the bottom sheet sits on. 0 without
 * a visual viewport.
 */
export function keyboardInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | null | undefined
): number {
  if (!visual || !Number.isFinite(layoutHeight)) return 0
  return Math.max(0, Math.round(layoutHeight - visual.offsetTop - visual.height))
}
