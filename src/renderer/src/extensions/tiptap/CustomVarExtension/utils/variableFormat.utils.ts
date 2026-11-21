// How a variable's value is shown with its Excel format (chip in a text
// document). Only `ssf` and the pure sheet helpers are imported, so
// tests/smoke/variable-format.test.mjs can bundle this file on its own.
import SSF from 'ssf'
import { toPlainNumber } from './sheetVariables.utils'

// `.5` and `1.` are decimals too, as Number() read them; `01.` still is not.
const HALF_DECIMAL = /^[+-]?(?:\.\d+|(?:0|[1-9]\d*)\.)$/

function toFormatNumber(value: unknown): number | null {
  const number = toPlainNumber(value)
  if (number !== null) return number
  if (typeof value === 'string' && HALF_DECIMAL.test(value.trim())) return Number(value.trim())
  return null
}

/**
 * @param value The raw value
 * @param format The Excel format string (e.g. "#,##0.00") or ID
 * @param autoUpdate A date-time that shows the current time
 * @param now The current time, for autoUpdate
 */
export function formatVariableValue(
  value: unknown,
  format: string | number,
  autoUpdate?: boolean,
  now: () => Date = () => new Date()
): unknown {
  if (!format || value === null || value === undefined || value === '') return value
  if (typeof value === 'string' && value.trim().startsWith('#')) return value

  let processingValue: unknown = value

  // 1. A number, the way a spreadsheet cell reads it: only a plain decimal
  //    (`-12`, `0.25`), or one written without a digit on one side of the
  //    point (`.5`, `1.`). `01234`, `0612345678`, `1e3` or `0x1F` is a code
  //    more often than a quantity, and stays as typed (the sheet shows it so).
  const number = typeof value === 'boolean' ? null : toFormatNumber(value)
  if (number !== null) {
    processingValue = number
  } else if (typeof value === 'string' && Number.isFinite(Number(value))) {
    return value
  } else if (autoUpdate) {
    processingValue = now()
  } else {
    // 2. Otherwise a date, if it reads as one.
    const parsedDate = new Date(value as string)
    if (!isNaN(parsedDate.getTime())) processingValue = parsedDate
  }

  try {
    // SSF formats numbers and Date objects alike.
    return SSF.format(format, processingValue as number)
  } catch (e) {
    console.error('formatValue error', e)
    return String(value)
  }
}
