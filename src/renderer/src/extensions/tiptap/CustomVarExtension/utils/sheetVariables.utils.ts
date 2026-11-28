// Pure helpers shared by the variable store and the spreadsheet editor.
// No imports on purpose: tests/smoke/sheet-variables.test.mjs compiles this
// file on its own with esbuild.

/**
 * Visibilities whose variables live outside vars.json: in the Desktop scope
 * (desktop, cloud) or in the Organization scope served by the API bridge.
 */
export const GLOBAL_VISIBILITIES = ['desktop', 'cloud', 'organization']

export function isGlobalVisibility(visibility: unknown): boolean {
  return GLOBAL_VISIBILITIES.includes(String(visibility || '').toLowerCase())
}

/** True for a variable of the Organization scope. */
export function isOrganizationVisibility(visibility: unknown): boolean {
  return String(visibility || '').toLowerCase() === 'organization'
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

/**
 * The Desktop and Organization variables together, Desktop first: an
 * organization variable sharing a name (or alias) with one of this
 * computer's is left out, so a personal value wins over the shared one, as a
 * document's own wins over both (selectVisibleGlobals).
 */
export function layerGlobals<T extends NamedVariable>(
  desktopVars: Record<string, T>,
  organizationVars: Record<string, T>
): Record<string, T> {
  const taken = new Set<string>()
  for (const value of Object.values(desktopVars || {})) {
    variableNames(value).forEach((name) => taken.add(name))
  }
  const layered: Record<string, T> = { ...(desktopVars || {}) }
  for (const [id, value] of Object.entries(organizationVars || {})) {
    if (!value || id in layered) continue
    if (variableNames(value).some((name) => taken.has(name))) continue
    layered[id] = value
  }
  return layered
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

/** `@` and a partial name at the end of `textBefore`, by the same grammar. */
export const CELL_VAR_TRIGGER = /(^|[^\p{L}\p{N}_.@])@((?:[\p{L}_][\p{L}\p{N}_]*)?)$/u

// `@` and a partial name anywhere else (web fields, browser inputs): names
// there may also hold `.` and `-`.
const VAR_TRIGGER = /(^|[^\p{L}\p{N}_.@])@([\p{L}\p{N}_.-]*)$/u

/**
 * The `@query` the caret sits right after, if any: the query typed so far and
 * the index of its `@` in `textBefore` (the text before the caret). `cellToken`
 * picks the cell grammar, where a name holds letters, digits and `_` only.
 */
export function findVarTrigger(
  textBefore: string,
  cellToken: boolean
): { query: string; atIndex: number } | null {
  const match = String(textBefore ?? '').match(cellToken ? CELL_VAR_TRIGGER : VAR_TRIGGER)
  if (!match) return null
  const query = match[2] || ''
  return { query, atIndex: textBefore.length - query.length - 1 }
}

/**
 * The text a picked variable replaces: the `@query` as last typed, from its
 * `@` to its end, whatever the caret did since (clicked back to the start of
 * the cell, or into the middle of the name). Clamped to the field's text.
 */
export function queryReplaceRange(
  triggerIndex: number,
  queryEnd: number,
  textLength: number
): { start: number; end: number } {
  const start = Math.max(0, Math.min(triggerIndex, textLength))
  const end = Math.max(start, Math.min(queryEnd, textLength))
  return { start, end }
}

/** A name that can be written as `@name` in a cell. */
export function isCellVarName(name: unknown): boolean {
  return typeof name === 'string' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)
}

/** `name` made into one a cell can read: `mon client` → `mon_client`. */
export function toCellVarName(name: string): string {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return ''
  return /^\p{N}/u.test(cleaned) ? `_${cleaned}` : cleaned
}

/**
 * Why `name` cannot be created from a spreadsheet cell, or null when it can.
 * Checked before anything is created: a name the cell cannot read would be
 * saved and then never inserted.
 */
export function cellVarNameError(name: string): string | null {
  if (isCellVarName(name)) return null
  const suggestion = toCellVarName(name)
  const hint = 'Use letters, digits and _ in a cell (no spaces), not starting with a digit.'
  return suggestion ? `${hint} Try "${suggestion}".` : hint
}

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

/**
 * A number, or text that is a plain decimal (`-12`, `0.25`). Text such as
 * `01234`, `0612345678`, `0x1F` or `1e3` is a code or an identifier more often
 * than a quantity, so it stays text.
 */
export function toPlainNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

const toFormulaLiteral = (value: unknown): string => {
  const number = toPlainNumber(value)
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
    const number = toPlainNumber(value)
    return { kind: 'value', value: number !== null ? number : (value ?? '') }
  }
  return { kind: 'value', value: replace((value) => String(value ?? '')) }
}

/**
 * The text of a text variable that holds plain text (not a formula, no
 * `{name}` reference), as typed; null for anything else. The formula engine
 * reads such text as a number when it can ('01234' as 1234), so what is shown
 * of it comes from here: the cell and the chip both keep '01234'.
 */
export function plainTextValue(
  raw: { type?: unknown; value?: unknown } | null | undefined
): string | null {
  if (!raw || raw.type !== 'text' || typeof raw.value !== 'string') return null
  if (raw.value.trim().startsWith('=') || /\{[^}]+\}/.test(raw.value)) return null
  return raw.value
}

/**
 * What a spreadsheet reference answers while its sheet (or the list of the
 * document's sheets) is still loading: a chip shows it as "…", not as an
 * error.
 */
export const SHEET_REF_LOADING = '#LOADING'

/** A chip's text for a value: "…" while a spreadsheet reference loads. */
export function displayVariableValue(value: unknown): unknown {
  return value === SHEET_REF_LOADING ? '…' : value
}
