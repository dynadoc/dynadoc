/**
 * The one place that turns a search query and its options into a RegExp.
 *
 * Multi-file search, the replace preview and the replace itself all build
 * their matcher here, so a change to how a query matches (whole word on
 * accented letters, accent folding: #138) is made once and reaches all of
 * them, desktop and stub alike.
 *
 * No Electron and no Node import: tests/smoke bundles this file on its own.
 */

export type SearchMatcherOptions = {
  isRegex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Throws on an invalid regular expression; callers report it to the user. */
export function createSearchRegExp(query: string, options: SearchMatcherOptions): RegExp {
  const source = options.isRegex ? query : escapeRegex(query)
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source
  const flags = options.caseSensitive ? 'g' : 'gi'
  return new RegExp(wrapped, flags)
}
