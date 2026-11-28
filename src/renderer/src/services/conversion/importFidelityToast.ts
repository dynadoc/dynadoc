import {
  formatFidelityLines,
  hasFidelityLoss,
  KIND_LABELS,
  type ImportFidelityReport
} from './importFidelity'

// The short report shown after an Office import: one line per kind, and
// why something was approximated or lost. It stays until it is closed.

const STYLE_ID = 'dynadoc-import-fidelity-report'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .import-fidelity-report {
      position: fixed;
      right: 20px;
      bottom: 24px;
      z-index: 10000;
      width: min(420px, calc(100vw - 32px));
      max-height: 60vh;
      overflow: auto;
      background: rgba(12, 16, 25, 0.96);
      color: #f3f4f6;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 14px 16px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
      font-size: 12px;
      line-height: 1.45;
    }
    .import-fidelity-report h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
    .import-fidelity-report ul { margin: 0; padding-left: 16px; }
    .import-fidelity-report .notes { color: rgba(255, 255, 255, 0.65); margin-top: 8px; }
    .import-fidelity-report button {
      margin-top: 10px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.06);
      color: #fff;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      cursor: pointer;
    }
  `
  document.head.appendChild(style)
}

/** Shows `report`; returns a function that removes it. */
export function showImportFidelityReport(report: ImportFidelityReport): () => void {
  ensureStyles()
  document.querySelectorAll('.import-fidelity-report').forEach((old) => old.remove())

  const panel = document.createElement('section')
  panel.className = 'import-fidelity-report'
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-label', 'Import report')

  const title = document.createElement('h2')
  title.textContent = hasFidelityLoss(report)
    ? `Imported ${report.fileName}, with differences`
    : `Imported ${report.fileName}`
  panel.appendChild(title)

  const list = document.createElement('ul')
  const lines = formatFidelityLines(report)
  for (const line of lines.length ? lines : ['Nothing to report']) {
    const item = document.createElement('li')
    item.textContent = line
    list.appendChild(item)
  }
  panel.appendChild(list)

  const notes = report.entries
    .filter((entry) => entry.notes.length && (entry.approximated || entry.lost))
    .map((entry) => `${KIND_LABELS[entry.kind]}: ${entry.notes.join('; ')}.`)
  if (notes.length) {
    const details = document.createElement('div')
    details.className = 'notes'
    for (const note of notes) {
      const line = document.createElement('div')
      line.textContent = note
      details.appendChild(line)
    }
    panel.appendChild(details)
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  const remove = (): void => panel.remove()
  close.addEventListener('click', remove)
  panel.appendChild(close)

  document.body.appendChild(panel)
  return remove
}
