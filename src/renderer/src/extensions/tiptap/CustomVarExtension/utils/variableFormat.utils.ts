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

// A date or a date-time as an ISO string, which is what the date picker
// (`datetime-local`) writes: `2026-03-05`, `2026-03-05T14:30[:15[.250]]`,
// optionally with `Z` or an offset. Nothing looser: `new Date()` reads
// "Lyon 69000" as the year 69000 and "Rue 12" as 2001-12-01.
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** The date an ISO string names, or null; without a zone it is local time. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const match = ISO_DATE.exec(text)
  if (!match) return null
  const [, y, mo, d, h, mi, sec, zone] = match
  const [year, month, day] = [Number(y), Number(mo), Number(d)]
  const [hours, minutes, seconds] = [Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0)]
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  // 2026-02-31 is not a day (Date would roll it over to March 3rd).
  const day0 = new Date(year, month - 1, day)
  if (day0.getFullYear() !== year || day0.getMonth() !== month - 1 || day0.getDate() !== day) {
    return null
  }
  // A date alone is that day where the user is (Date reads it as UTC midnight).
  const date = zone ? new Date(text) : new Date(year, month - 1, day, hours, minutes, seconds)
  return isNaN(date.getTime()) ? null : date
}

/** Whether an Excel format (a string or a built-in ID) shows a date or a time. */
export function isDateFormat(format: string | number): boolean {
  const code = typeof format === 'number' ? SSF.get_table()[format] : format
  if (typeof code !== 'string' || !code) return false
  try {
    return SSF.is_date(code)
  } catch {
    return false
  }
}

type FormatOptions = {
  /** A date-time that shows the current time. */
  autoUpdate?: boolean
  /** A date-time variable's value: an ISO date is a date under any format. */
  dateTime?: boolean
  /** The current time, for autoUpdate. */
  now: () => Date
}

function formatValue(value: unknown, format: string | number, options: FormatOptions): unknown {
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
  } else if (options.autoUpdate) {
    processingValue = options.now()
  } else if (value instanceof Date) {
    if (isNaN(value.getTime())) return String(value)
  } else {
    // 2. A date only when it is meant as one: an ISO date (what the date
    //    picker writes) under a date format, or in a date-time variable.
    //    Any other text is shown as typed, whatever Date() makes of it.
    const date = options.dateTime || isDateFormat(format) ? parseIsoDate(value) : null
    if (!date) return value
    processingValue = date
  }

  try {
    // SSF formats numbers and Date objects alike.
    return SSF.format(format, processingValue as number)
  } catch (e) {
    console.error('formatValue error', e)
    return String(value)
  }
}

/**
 * What a variable shows for its value: a plain decimal is formatted as a
 * number, an ISO date as a date under a date format, any other text as is.
 *
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
  return formatValue(value, format, { autoUpdate, now })
}

/**
 * What a date-time variable shows: its ISO value (from the date picker) is a
 * date under any format, "General" included; other text stays as typed.
 */
export function formatDateTimeVariableValue(
  value: unknown,
  format: string | number,
  autoUpdate?: boolean,
  now: () => Date = () => new Date()
): unknown {
  return formatValue(value, format, { autoUpdate, now, dateTime: true })
}
