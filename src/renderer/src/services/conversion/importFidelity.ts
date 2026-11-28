// What an Office import kept, approximated or dropped, counted per kind of
// content, with where it was. The .xlsx import feeds it today
// (xlsxImportFidelity.ts); it knows nothing about spreadsheets, so the Word
// import (DocxToHtml, #142) and the API bridge can produce the same report.
// The format is documented in docs/import-report.md.
// Pure (no DOM, no stores): tests/smoke runs it.

/** Bumped when the shape changes; parseImportFidelityReport() checks it. */
export const IMPORT_FIDELITY_REPORT_VERSION = 1

/**
 * converted: in the document as it was in the file.
 * approximated: shown or computed differently in Dynadoc, and written back
 *   as it was when the document is exported or saved to the Office format.
 * lost: not in the document, and not in a file exported or saved from it.
 */
export type ImportFidelityStatus = 'converted' | 'approximated' | 'lost'

/** Where an item was in the source. Only the fields that apply are set. */
export type ImportFidelityPlace = {
  sheet?: string
  /** A1 reference, or a range. */
  cell?: string
  /** A package part, e.g. "xl/charts/chart1.xml". */
  part?: string
}

export type ImportFidelityItem = {
  /** One of KIND_LABELS' keys; a reader must accept kinds it does not know. */
  kind: string
  status: ImportFidelityStatus
  count: number
  reason?: string
  /** At most MAX_PLACES; `count` is the real total. */
  places?: ImportFidelityPlace[]
}

export type ImportFidelityReport = {
  version: typeof IMPORT_FIDELITY_REPORT_VERSION
  source: {
    name: string
    kind: 'xlsx' | 'xls' | 'csv' | 'docx' | 'pptx'
    sha256?: string
  }
  /**
   * Why the report may be incomplete (a step that failed, a file converted
   * before the import). Empty when the report covers the whole file.
   */
  unavailable: string[]
  items: ImportFidelityItem[]
}

export type ImportFidelityCollector = {
  add: (
    kind: string,
    status: ImportFidelityStatus,
    count?: number,
    reason?: string,
    place?: ImportFidelityPlace
  ) => void
  unavailable: (reason: string) => void
  report: () => ImportFidelityReport
}

export const MAX_PLACES = 100

export const KIND_LABELS: Record<string, string> = {
  formulas: 'Formulas',
  definedNames: 'Defined names',
  comments: 'Comments',
  images: 'Images',
  shapes: 'Shapes',
  textBoxes: 'Text boxes',
  formControls: 'Form controls',
  charts: 'Charts',
  tables: 'Tables',
  dataValidation: 'Data validation rules',
  conditionalFormatting: 'Conditional formatting rules',
  autoFilter: 'Filters',
  frozenPanes: 'Frozen panes',
  printSettings: 'Print settings',
  sparklines: 'Sparklines',
  slicers: 'Slicers',
  pivotCaches: 'Pivot tables',
  externalLinks: 'External links',
  protection: 'Protection',
  macros: 'Macros',
  otherParts: 'Other content'
}

const KIND_ORDER = Object.keys(KIND_LABELS)

const labelOf = (kind: string): string => KIND_LABELS[kind] || kind

export function createImportFidelityCollector(
  source: ImportFidelityReport['source']
): ImportFidelityCollector {
  const items = new Map<string, ImportFidelityItem>()
  const unavailable: string[] = []
  return {
    add(kind, status, count = 1, reason, place) {
      if (!(count > 0)) return
      const key = `${kind}\u0000${status}\u0000${reason || ''}`
      let item = items.get(key)
      if (!item) {
        item = { kind, status, count: 0, ...(reason ? { reason } : {}) }
        items.set(key, item)
      }
      item.count += count
      if (place) {
        item.places ||= []
        if (item.places.length < MAX_PLACES) item.places.push({ ...place })
      }
    },
    unavailable(reason) {
      if (!unavailable.includes(reason)) unavailable.push(reason)
    },
    report() {
      const order = (kind: string): number =>
        KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length
      const sorted = [...items.values()]
        .map((item) => ({ ...item, ...(item.places ? { places: [...item.places] } : {}) }))
        .sort((a, b) => order(a.kind) - order(b.kind) || a.kind.localeCompare(b.kind))
      return {
        version: IMPORT_FIDELITY_REPORT_VERSION,
        source: { ...source },
        unavailable: [...unavailable],
        items: sorted
      }
    }
  }
}

/**
 * A report read from elsewhere (a stored document, another converter), or
 * null when it is not one this version understands. Kinds it does not know
 * are kept: they are shown by their key.
 */
export function parseImportFidelityReport(value: unknown): ImportFidelityReport | null {
  const data = typeof value === 'string' ? safeJson(value) : value
  if (!data || typeof data !== 'object') return null
  const report = data as Partial<ImportFidelityReport>
  if (report.version !== IMPORT_FIDELITY_REPORT_VERSION) return null
  const source = report.source
  if (!source || typeof source.name !== 'string' || typeof source.kind !== 'string') return null
  if (!Array.isArray(report.items)) return null
  const statuses: ImportFidelityStatus[] = ['converted', 'approximated', 'lost']
  const items = report.items.filter(
    (item): item is ImportFidelityItem =>
      Boolean(item) &&
      typeof item.kind === 'string' &&
      statuses.includes(item.status) &&
      typeof item.count === 'number' &&
      item.count > 0
  )
  return {
    version: IMPORT_FIDELITY_REPORT_VERSION,
    source: { ...source },
    unavailable: Array.isArray(report.unavailable)
      ? report.unavailable.filter((reason) => typeof reason === 'string')
      : [],
    items
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when something did not come through as it was, or the report is incomplete. */
export function hasFidelityLoss(report: ImportFidelityReport): boolean {
  return report.unavailable.length > 0 || report.items.some((item) => item.status !== 'converted')
}

/** True when saving over the source file would remove something, or may. */
export function needsSaveConfirmation(report: ImportFidelityReport): boolean {
  return report.unavailable.length > 0 || report.items.some((item) => item.status === 'lost')
}

/** One line per kind, e.g. "Formulas: 12 kept, 1 approximated". */
export function formatFidelityLines(report: ImportFidelityReport): string[] {
  const kinds: string[] = []
  for (const item of report.items) if (!kinds.includes(item.kind)) kinds.push(item.kind)
  return kinds.map((kind) => {
    const total = (status: ImportFidelityStatus): number =>
      report.items
        .filter((item) => item.kind === kind && item.status === status)
        .reduce((sum, item) => sum + item.count, 0)
    const parts: string[] = []
    if (total('converted')) parts.push(`${total('converted')} kept`)
    if (total('approximated')) parts.push(`${total('approximated')} approximated`)
    if (total('lost')) parts.push(`${total('lost')} lost`)
    return `${labelOf(kind)}: ${parts.join(', ')}`
  })
}

/** Why things were approximated or lost, one line each, with a few places. */
export function formatFidelityNotes(report: ImportFidelityReport): string[] {
  return report.items
    .filter((item) => item.status !== 'converted' && item.reason)
    .map((item) => {
      const places = (item.places || [])
        .slice(0, 3)
        .map((p) => [p.sheet, p.cell].filter(Boolean).join('!') || p.part || '')
        .filter(Boolean)
      const where = places.length
        ? ` (${places.join(', ')}${item.count > places.length ? ', ...' : ''})`
        : ''
      return `${labelOf(item.kind)}: ${item.reason}${where}.`
    })
}

/** What is lost, as "Charts: 2, Pivot tables: 1", for a warning before a save. */
export function describeLostItems(report: ImportFidelityReport): string {
  const totals = new Map<string, number>()
  for (const item of report.items) {
    if (item.status === 'lost') totals.set(item.kind, (totals.get(item.kind) || 0) + item.count)
  }
  return [...totals.entries()].map(([kind, count]) => `${labelOf(kind)}: ${count}`).join(', ')
}
