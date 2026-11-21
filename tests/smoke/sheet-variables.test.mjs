/**
 * Gate: variables in spreadsheet cells, and which variables a document sees.
 *
 * sheetVariables.utils.ts decides what a cell shows for `@name` input, so a
 * wrong answer here is a wrong number in somebody's spreadsheet that looks
 * perfectly fine. The cases that are easy to get wrong are asserted directly:
 * a name that is the prefix of another (@tax / @taxe), an e-mail address that
 * contains an `@`, text values inside formulas, and a range that must sum.
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
const ok = (what) => console.log(`[sheet-variables]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[sheet-variables]   FAIL  ${what}\n                      ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The module has no imports on purpose, so esbuild can compile it alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'sheet-variables-'))
const compiled = path.join(outDir, 'sheetVariables.utils.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/utils/sheetVariables.utils.ts'
    ),
    '--format=esm',
    `--outfile=${compiled}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[sheet-variables] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const {
  findCellVarTokens,
  hasCellVarTokens,
  evaluateCellVarInput,
  reduceRefValues,
  isSingleCellRef,
  selectVisibleGlobals,
  isGlobalVisibility,
  toPlainNumber,
  isCellVarName,
  CELL_VAR_TRIGGER
} = await import(`file://${compiled}`)

const vars = { client: 'ACME SARL', taux: 0.2, tax: 5, taxe: 7, qty: '3', quote: 'say "hi"' }
const resolve = (name) => (name in vars ? { found: true, value: vars[name] } : { found: false })

// --- token detection -------------------------------------------------------
check('a lone token', findCellVarTokens('@client'), ['client'])
check('a token after an operator', findCellVarTokens('=B2*@taux'), ['taux'])
check('@taxe is not @tax', findCellVarTokens('=@taxe+1'), ['taxe'])
check('both prefixes, once each', findCellVarTokens('=@tax+@taxe+@tax'), ['tax', 'taxe'])
check('an e-mail address is not a variable', findCellVarTokens('a@b.com'), [])
check('an e-mail in text next to a token', findCellVarTokens('mail a@b.com @client'), ['client'])
check('a token inside a formula string stays text', findCellVarTokens('="@client"&@qty'), ['qty'])
check('no @ at all', hasCellVarTokens('=SUM(A1:A3)'), false)
check('not a string', hasCellVarTokens(42), false)
check('a bare @ is nothing', hasCellVarTokens('@'), false)
check('unicode names', findCellVarTokens('=@prix_ttc*@remise2'), ['prix_ttc', 'remise2'])

// --- evaluation --------------------------------------------------------------
check('plain text value', evaluateCellVarInput('@client', resolve), {
  kind: 'value',
  value: 'ACME SARL'
})
check('a number stays a number', evaluateCellVarInput('@taux', resolve), {
  kind: 'value',
  value: 0.2
})
check('a numeric string becomes a number', evaluateCellVarInput(' @qty ', resolve), {
  kind: 'value',
  value: 3
})
check('text around a token', evaluateCellVarInput('Dear @client,', resolve), {
  kind: 'value',
  value: 'Dear ACME SARL,'
})
check('formula with a number', evaluateCellVarInput('=B2*@taux', resolve), {
  kind: 'formula',
  formula: '=B2*0.2'
})
check('formula with prefix names', evaluateCellVarInput('=@tax+@taxe', resolve), {
  kind: 'formula',
  formula: '=5+7'
})
check('formula with text is quoted', evaluateCellVarInput('=CONCAT("Client: ",@client)', resolve), {
  kind: 'formula',
  formula: '=CONCAT("Client: ","ACME SARL")'
})
check('quotes inside a text value are doubled', evaluateCellVarInput('=@quote', resolve), {
  kind: 'formula',
  formula: '="say ""hi"""'
})
check('formula string literal left alone', evaluateCellVarInput('="@client "&@client', resolve), {
  kind: 'formula',
  formula: '="@client "&"ACME SARL"'
})
check('unknown variable', evaluateCellVarInput('=B2*@nope', resolve), {
  kind: 'error',
  value: '#VAR?',
  missing: ['nope']
})
check('unknown prefix-like variable', evaluateCellVarInput('@taxes', resolve).kind, 'error')
check('e-mail cell is left as text', evaluateCellVarInput('a@b.com', resolve), {
  kind: 'value',
  value: 'a@b.com'
})

// --- only plain decimals become numbers ------------------------------------
check(
  'plain decimals',
  ['0', '42', '-3', '+7', '0.25', ' 12.5 '].map(toPlainNumber),
  [0, 42, -3, 7, 0.25, 12.5]
)
check(
  'look-alikes stay text',
  ['01234', '0612345678', '0x1F', '1e3', '1.', '.5', '', '12a', 'Infinity'].map(toPlainNumber),
  [null, null, null, null, null, null, null, null, null]
)
check('a number stays a number', [toPlainNumber(3), toPlainNumber(NaN)], [3, null])
{
  const codes = { zip: '01234', phone: '0612345678', hex: '0x1F', sci: '1e3' }
  const r = (name) => (name in codes ? { found: true, value: codes[name] } : { found: false })
  check('a zip code keeps its zero', evaluateCellVarInput('@zip', r), {
    kind: 'value',
    value: '01234'
  })
  check('a phone number stays text', evaluateCellVarInput('@phone', r), {
    kind: 'value',
    value: '0612345678'
  })
  check('hex and exponent stay text in formulas', evaluateCellVarInput('=@hex&@sci', r), {
    kind: 'formula',
    formula: '="0x1F"&"1e3"'
  })
}

// --- names the cell grammar can read, and the dropdown trigger -------------
check('cell names', ['client', 'taux_2', '_x', 'prixTTC', 'été'].map(isCellVarName), [
  true,
  true,
  true,
  true,
  true
])
check('names a cell cannot read', ['user name', 'a-b', 'a.b', '2x', '', 42].map(isCellVarName), [
  false,
  false,
  false,
  false,
  false,
  false
])
const trigger = (text) => {
  const m = text.match(CELL_VAR_TRIGGER)
  return m ? m[2] : null
}
check('trigger after an operator', ['=B2*@ta', '@', 'x @cl'].map(trigger), ['ta', '', 'cl'])
check(
  'no trigger in e-mails, after a digit start or past a dash',
  ['a@b', '@2x', '@a-b', '@a.b'].map(trigger),
  [null, null, null, null]
)

// --- spreadsheet refs: a range sums --------------------------------------
check('single cell', isSingleCellRef('C2'), true)
check('a range is not a single cell', isSingleCellRef('A1:B2'), false)
check('single cell keeps its value', reduceRefValues('A1', [4]), 4)
check('range sums', reduceRefValues('A1:B2', [1, 2, 3, 4]), 10)
check('range ignores non-numbers', reduceRefValues('A1:A3', [1, NaN, 2]), 3)
check('empty range', reduceRefValues('A1:A3', []), null)

// --- which global variables a document sees -------------------------------
check(
  'desktop and cloud are global',
  [isGlobalVisibility('desktop'), isGlobalVisibility('Cloud')],
  [true, true]
)
check(
  'document and package are not',
  [isGlobalVisibility('document'), isGlobalVisibility('package'), isGlobalVisibility(undefined)],
  [false, false, false]
)
{
  const documentVars = {
    d1: { name: 'client', visibility: 'package' },
    d2: { name: 'local', aliases: ['alias1'], visibility: 'document' },
    g1: { name: 'taux', visibility: 'desktop' } // the document's own copy of g1
  }
  const globals = {
    g1: { name: 'taux', visibility: 'desktop' },
    g2: { name: 'Client', visibility: 'desktop' }, // clashes with d1: document wins
    g3: { name: 'other', aliases: ['ALIAS1'], visibility: 'cloud' }, // clashes by alias
    g4: { name: 'total', visibility: 'desktop' }
  }
  check('document wins on a name clash', Object.keys(selectVisibleGlobals(documentVars, globals)), [
    'g1',
    'g4'
  ])
  check('no document variables', Object.keys(selectVisibleGlobals({}, globals)), [
    'g1',
    'g2',
    'g3',
    'g4'
  ])
}

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[sheet-variables] FAILED — ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[sheet-variables] OK — cell variables, range sums and visibility behave')
