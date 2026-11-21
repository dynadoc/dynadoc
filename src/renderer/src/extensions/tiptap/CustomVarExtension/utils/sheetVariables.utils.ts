// Pure helpers shared by the variable store and the spreadsheet editor.
// No imports on purpose: tests/smoke/sheet-variables.test.mjs compiles this
// file on its own with esbuild.

/** Visibilities whose variables live in the app-wide store, not in vars.json. */
export const GLOBAL_VISIBILITIES = ['desktop', 'cloud']

export function isGlobalVisibility(visibility: unknown): boolean {
  return GLOBAL_VISIBILITIES.includes(String(visibility || '').toLowerCase())
}

type NamedVariable = { name?: string; aliases?: string[]; visibility?: string }

const variableNames = (value: NamedVariable | null | undefined): string[] =>
  [value?.name, ...(Array.isArray(value?.aliases) ? value.aliases : [])]
    .filter(Boolean)
    .map((name) => String(name).trim().toLowerCase())

/**
 * Global variables a document may see. A document-level variable wins on a
 * name clash, so a global variable sharing a name (or alias) with one of the
 * document's own variables is left out. The same id is not a clash: that is
 * the document's stale copy of the global variable itself.
 */
export function selectVisibleGlobals<T extends NamedVariable>(
  documentVars: Record<string, NamedVariable>,
  globalVars: Record<string, T>
): Record<string, T> {
  const taken = new Set<string>()
  for (const [id, value] of Object.entries(documentVars || {})) {
    if (!value || isGlobalVisibility(value.visibility) || globalVars?.[id]) continue
    variableNames(value).forEach((name) => taken.add(name))
  }
  const visible: Record<string, T> = {}
  for (const [id, value] of Object.entries(globalVars || {})) {
    if (!value) continue
    if (variableNames(value).some((name) => taken.has(name))) continue
    visible[id] = value
  }
  return visible
}

/** True for a single cell ref like `A1`, false for a range like `A1:B2`. */
export function isSingleCellRef(ref: string): boolean {
  return /^[A-Z]+[0-9]+$/i.test(String(ref || '').trim())
}

/** A single cell gives its value; a range sums, as it does in arithmetic. */
export function reduceRefValues(ref: string, values: number[]): number | null {
  const numbers = (values || []).filter((value) => Number.isFinite(value))
  if (!numbers.length) return null
  if (isSingleCellRef(ref)) return numbers[0]
  return numbers.reduce((sum, value) => sum + value, 0)
}

// `@name` in a cell. The `@` must not follow a letter, digit, `_`, `.` or `@`,
// so `a@b.com` is an e-mail address, not a variable.
const CELL_VAR_TOKEN = /(^|[^\p{L}\p{N}_.@])@([\p{L}_][\p{L}\p{N}_]*)/gu

export const CELL_VAR_ERROR = '#VAR?'

type Segment = { text: string; quoted: boolean }

// Splits a formula on double-quoted string literals ("" escapes a quote), so
// `@name` inside a string stays text.
function splitQuoted(input: string, isFormula: boolean): Segment[] {
  if (!isFormula) return [{ text: input, quoted: false }]
  const segments: Segment[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        current += '""'
        i++
        continue
      }
      if (!quoted) {
        segments.push({ text: current, quoted: false })
        current = '"'
      } else {
        segments.push({ text: current + '"', quoted: true })
        current = ''
      }
      quoted = !quoted
      continue
    }
    current += char
  }
  segments.push({ text: current, quoted })
  return segments
}

/** Names referenced as `@name` in a cell's input, in order, without duplicates. */
export function findCellVarTokens(input: unknown): string[] {
  if (typeof input !== 'string' || !input.includes('@')) return []
  const names: string[] = []
  for (const segment of splitQuoted(input, input.trim().startsWith('='))) {
    if (segment.quoted) continue
    for (const match of segment.text.matchAll(CELL_VAR_TOKEN)) {
      if (!names.includes(match[2])) names.push(match[2])
    }
  }
  return names
}

export function hasCellVarTokens(input: unknown): boolean {
  return findCellVarTokens(input).length > 0
}

export type CellVarResolution = { found: boolean; value?: unknown }

export type CellVarResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'formula'; formula: string }
  | { kind: 'error'; value: string; missing: string[] }

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

const toFormulaLiteral = (value: unknown): string => {
  const number = toNumber(value)
  if (number !== null) return String(number)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

/**
 * Evaluates what a cell shows for an input that contains `@name` tokens.
 *
 * - `@client` alone gives the variable's value (a numeric value stays a number);
 * - text around tokens (`Dear @client`) gives the text with values spliced in;
 * - a formula (`=B2*@taux`) gives the formula with each token replaced by a
 *   literal: a number as is, anything else as a quoted string.
 *
 * Any unknown name makes the whole cell `#VAR?`.
 */
export function evaluateCellVarInput(
  input: string,
  resolve: (name: string) => CellVarResolution
): CellVarResult {
  const names = findCellVarTokens(input)
  const values = new Map<string, unknown>()
  const missing: string[] = []
  for (const name of names) {
    const resolved = resolve(name)
    if (!resolved?.found) missing.push(name)
    else values.set(name, resolved.value)
  }
  if (missing.length) return { kind: 'error', value: CELL_VAR_ERROR, missing }

  const isFormula = input.trim().startsWith('=')
  const replace = (literal: (value: unknown) => string): string =>
    splitQuoted(input, isFormula)
      .map((segment) =>
        segment.quoted
          ? segment.text
          : segment.text.replace(
              CELL_VAR_TOKEN,
              (_match, prefix, name) => `${prefix}${literal(values.get(name))}`
            )
      )
      .join('')

  if (isFormula) return { kind: 'formula', formula: replace(toFormulaLiteral) }

  const single = /^\s*@([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(input)
  if (single) {
    const value = values.get(single[1])
    const number = toNumber(value)
    return { kind: 'value', value: number !== null ? number : (value ?? '') }
  }
  return { kind: 'value', value: replace((value) => String(value ?? '')) }
}
