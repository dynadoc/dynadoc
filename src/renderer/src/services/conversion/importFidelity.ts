// What an Office import kept, approximated or dropped, counted per kind of
// content. The .xlsx import feeds it today (xlsxImportFidelity.ts); it knows
// nothing about spreadsheets so the Word import can feed it the same way.
// Pure (no DOM, no stores): tests/smoke runs it.

export type ImportFidelityOutcome = 'converted' | 'approximated' | 'lost'

export type ImportFidelityKind =
  | 'formulas'
  | 'definedNames'
  | 'comments'
  | 'images'
  | 'shapes'
  | 'textBoxes'
  | 'charts'
  | 'dataValidation'
  | 'conditionalFormatting'
  | 'pivotCaches'
  | 'externalLinks'
  | 'protection'
  | 'macros'

export type ImportFidelityEntry = {
  kind: ImportFidelityKind
  converted: number
  approximated: number
  lost: number
  /** Why something was approximated or lost, one line each, without repeats. */
  notes: string[]
}

export type ImportFidelityReport = {
  source: 'xlsx' | 'docx'
  fileName: string
  /** In the order of KIND_ORDER, only the kinds that were met. */
  entries: ImportFidelityEntry[]
}

export type ImportFidelityCollector = {
  add: (
    kind: ImportFidelityKind,
    outcome: ImportFidelityOutcome,
    count?: number,
    note?: string
  ) => void
  report: () => ImportFidelityReport
}

export const KIND_LABELS: Record<ImportFidelityKind, string> = {
  formulas: 'Formulas',
  definedNames: 'Defined names',
  comments: 'Comments',
  images: 'Images',
  shapes: 'Shapes',
  textBoxes: 'Text boxes',
  charts: 'Charts',
  dataValidation: 'Data validation rules',
  conditionalFormatting: 'Conditional formatting rules',
  pivotCaches: 'Pivot tables',
  externalLinks: 'External links',
  protection: 'Protection',
  macros: 'Macros'
}

const KIND_ORDER = Object.keys(KIND_LABELS) as ImportFidelityKind[]

export function createImportFidelityCollector(
  source: ImportFidelityReport['source'],
  fileName: string
): ImportFidelityCollector {
  const byKind = new Map<ImportFidelityKind, ImportFidelityEntry>()
  return {
    add(kind, outcome, count = 1, note) {
      if (!(count > 0)) return
      let entry = byKind.get(kind)
      if (!entry) {
        entry = { kind, converted: 0, approximated: 0, lost: 0, notes: [] }
        byKind.set(kind, entry)
      }
      entry[outcome] += count
      if (note && !entry.notes.includes(note)) entry.notes.push(note)
    },
    report() {
      const entries = KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => {
        const entry = byKind.get(kind) as ImportFidelityEntry
        return { ...entry, notes: [...entry.notes] }
      })
      return { source, fileName, entries }
    }
  }
}

/** True when something did not come through as it was in the file. */
export function hasFidelityLoss(report: ImportFidelityReport): boolean {
  return report.entries.some((entry) => entry.approximated > 0 || entry.lost > 0)
}

/** One line per kind, e.g. "Formulas: 12 kept, 1 approximated". */
export function formatFidelityLines(report: ImportFidelityReport): string[] {
  return report.entries.map((entry) => {
    const parts: string[] = []
    if (entry.converted) parts.push(`${entry.converted} kept`)
    if (entry.approximated) parts.push(`${entry.approximated} approximated`)
    if (entry.lost) parts.push(`${entry.lost} lost`)
    return `${KIND_LABELS[entry.kind]}: ${parts.join(', ')}`
  })
}
