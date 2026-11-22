/**
 * Gate: what a variable chip shows for its value and Excel format.
 *
 * variableFormat.utils.ts formats the value of a variable in a text document.
 * A zip code or a phone number typed as "01234" must not lose its zero under
 * the "General" format: the stored value is right and the spreadsheet already
 * shows 01234, so a chip showing 1234 is a wrong value that looks fine. The
 * rule is the sheet's (toPlainNumber): only a plain decimal is a number.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

let failures = 0
const ok = (what) => console.log(`[variable-format]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[variable-format]   FAIL  ${what}\n                      ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The module imports only `ssf` and the pure sheet helpers: bundled alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'variable-format-'))
const compiled = path.join(outDir, 'variableFormat.utils.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/utils/variableFormat.utils.ts'
    ),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=warning',
    `--outfile=${compiled}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[variable-format] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const { formatVariableValue: format, formatDateTimeVariableValue: formatDateTime } = await import(
  `file://${compiled}`
)

// --- leading zeros and other codes keep what was typed -------------------
check('a zip code keeps its zero', format('01234', 'General'), '01234')
check('a phone number keeps its zero', format('0612345678', 'General'), '0612345678')
check(
  'exponent, hex and zero-led half decimals stay text',
  ['1e3', '0x1F', '01.', '00.5'].map((v) => format(v, 'General')),
  ['1e3', '0x1F', '01.', '00.5']
)
check(
  'a decimal without a digit on one side is a number',
  [format('.5', '0.00'), format('-.25', '0.00'), format('1.', '0.00'), format('0.', '0.0')],
  ['0.50', '-0.25', '1.00', '0.0']
)
check('a code keeps its zero under a number format', format('007', '0.00'), '007')

// --- plain decimals are numbers -----------------------------------------
check(
  'plain decimals are formatted as numbers',
  ['1234', '-12', '0.25', ' 42 ', '0'].map((v) => format(v, 'General')),
  ['1234', '-12', '0.25', '42', '0']
)
check('a number format applies to a plain decimal', format('1234.5', '#,##0.00'), '1,234.50')
check('a number value', format(1234.5, '0.0'), '1234.5')
check('a percentage', format('0.25', '0%'), '25%')

// --- left as is ------------------------------------------------------------
check('no format', format('01234', ''), '01234')
check('empty value', format('', 'General'), '')
check('an error value', format('#REF!', 'General'), '#REF!')
check('plain text', format('ACME Corp', 'General'), 'ACME Corp')

// --- text that JavaScript's Date parser would read as a date ---------------
// new Date('Lyon 69000') is the year 69000 and new Date('Rue 12') is
// 2001-12-01: under General (what a variable made from the @ menu gets) the
// chip showed nothing or a wrong date instead of the address.
const addresses = ['Lyon 69000', 'Rue 12', 'ليون (Lyon) 69000', 'ACME SARL', '12 rue de la Paix']
check(
  'text that a Date parser accepts stays as typed under General',
  addresses.map((v) => format(v, 'General')),
  addresses
)
check(
  'and under a number format',
  addresses.map((v) => format(v, '#,##0.00')),
  addresses
)
check(
  'and even under a date format, unless it is an ISO date',
  addresses.map((v) => format(v, 'yyyy-mm-dd')),
  addresses
)
check('an ISO date under General stays as typed', format('2026-03-05', 'General'), '2026-03-05')
check(
  'numbers keep their rule',
  ['0.2', '0612345678'].map((v) => format(v, 'General')),
  ['0.2', '0612345678']
)
check('a spaced thousand stays as typed', format('1 000', 'General'), '1 000')

// --- dates ---------------------------------------------------------------
check('a date string', format('2026-03-05T12:00:00', 'yyyy-mm-dd'), '2026-03-05')
check(
  'what the date picker writes, under a date format',
  [
    format('2026-03-05T14:30', 'm/d/yy'),
    format('2026-03-05T14:30', 'mmmm d, yyyy'),
    format('2026-03-05T14:30:15', 'h:mm AM/PM')
  ],
  ['3/5/26', 'March 5, 2026', '2:30 PM']
)
check(
  'a date alone is that day where the user is, not UTC midnight',
  format('2026-03-05', 'yyyy-mm-dd'),
  '2026-03-05'
)
check('an impossible ISO date stays as typed', format('2026-02-31', 'yyyy-mm-dd'), '2026-02-31')
check('a format ID for a date', format('2026-03-05T12:00', 14), '3/5/26')
check(
  'a date-time variable is a date under General (its default format)',
  formatDateTime('2026-03-05T14:30', 'General'),
  '3/5/26'
)
check(
  'text in a date-time variable still stays as typed',
  addresses.map((v) => formatDateTime(v, 'General')),
  addresses
)
check(
  'auto-update shows the current time, not the stored one',
  format('ACME', 'yyyy-mm-dd', true, () => new Date(2030, 0, 2)),
  '2030-01-02'
)

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[variable-format] FAILED — ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[variable-format] OK — variable values keep their leading zeros')
