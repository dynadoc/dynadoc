/**
 * Gate: what the `@` variable menu lists, in which order, and how it looks.
 *
 * variableMenu.utils.ts decides which variables answer the `@query` being
 * typed (the name, an alias or a word of the name starting with it), ranks
 * them, cuts out the part to highlight, offers to create `@query` only when no
 * variable has that name, moves the highlight with ↑/↓ and says when the menu
 * is a bottom sheet (narrow window or touch screen) and how far above the
 * on-screen keyboard it sits.
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
const ok = (what) => console.log(`[variable-menu]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[variable-menu]   FAIL  ${what}\n                    ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The module imports only the pure sheet helpers: bundled alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'variable-menu-'))
const compiled = path.join(outDir, 'variableMenu.utils.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/utils/variableMenu.utils.ts'
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
  console.error(`[variable-menu] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const {
  matchRank,
  rankVariableMatches,
  splitMatch,
  variableScope,
  scopeVisibility,
  canCreateVariable,
  moveActiveRow,
  isCompactViewport,
  keyboardInset,
  COMPACT_MAX_WIDTH
} = await import(`file://${compiled}`)

const vars = [
  { name: 'total', source: 'user' },
  { name: 'client_ville', source: 'user' },
  { name: 'taux', source: 'user', aliases: ['rate'] },
  { name: 'client', source: 'user' },
  { name: 'Clinique', source: 'ai' },
  { name: 'cli', source: 'ai' },
  { name: 'acme_client', source: 'user' }
]
const names = (list) => list.map((item) => item.name)

// ── matching and ranking ─────────────────────────────────────────────────────
check('an empty query lists everything', rankVariableMatches(vars, '').length, vars.length)
check(
  'an empty query lists the user’s own first, then by name',
  names(rankVariableMatches(vars, '')),
  ['acme_client', 'client', 'client_ville', 'taux', 'total', 'cli', 'Clinique']
)
check(
  '`cli`: the exact name first, then names, then a word of a name',
  names(rankVariableMatches(vars, 'cli')),
  ['cli', 'client', 'client_ville', 'Clinique', 'acme_client']
)
check('case does not matter', names(rankVariableMatches(vars, 'CLIENT_V')), ['client_ville'])
check('an alias finds its variable', names(rankVariableMatches(vars, 'ra')), ['taux'])
check('a word of the name finds it', names(rankVariableMatches(vars, 'ville')), ['client_ville'])
check('the middle of a word does not', names(rankVariableMatches(vars, 'lient')), [])
check('no match, no rows', names(rankVariableMatches(vars, 'zzz')), [])
check('a missing list is no rows', rankVariableMatches(undefined, 'a'), [])
check('displayName wins over name', matchRank({ name: 'uuid-1', displayName: 'tva' }, 'tv'), 1)
check('exact name ranks 0', matchRank({ name: 'taux' }, 'TAUX'), 0)
check('no match ranks null', matchRank({ name: 'taux' }, 'x'), null)

// ── highlight ────────────────────────────────────────────────────────────────
check('the typed start is highlighted', splitMatch('client', 'cli'), {
  before: '',
  match: 'cli',
  after: 'ent'
})
check('as written, whatever the case typed', splitMatch('Client', 'CL'), {
  before: '',
  match: 'Cl',
  after: 'ient'
})
check('a matched word is highlighted', splitMatch('client_ville', 'vil'), {
  before: 'client_',
  match: 'vil',
  after: 'le'
})
check('nothing matched, nothing highlighted', splitMatch('taux', 'rate'), {
  before: 'taux',
  match: '',
  after: ''
})

// ── scope ────────────────────────────────────────────────────────────────────
check('desktop is a global variable', variableScope({ visibility: 'desktop' }), 'desktop')
check('cloud is a global variable', variableScope({ visibility: 'Cloud' }), 'desktop')
check('package is the document’s', variableScope({ visibility: 'package' }), 'doc')
check('no visibility is the document’s', variableScope(undefined), 'doc')
check('created for all files: desktop', scopeVisibility('desktop'), 'desktop')
check('created for this document: package', scopeVisibility('doc'), 'package')

// ── create row ───────────────────────────────────────────────────────────────
check('nothing typed, nothing to create', canCreateVariable('', vars), false)
check('spaces only, nothing to create', canCreateVariable('  ', vars), false)
check('a new name can be created', canCreateVariable('clie', vars), true)
check('an existing name cannot', canCreateVariable('Client', vars), false)
check('with no list, any name can', canCreateVariable('x', undefined), true)

// ── keyboard ─────────────────────────────────────────────────────────────────
check('↓ moves down', moveActiveRow(0, 1, 3), 1)
check('↓ on the last row wraps to the first', moveActiveRow(2, 1, 3), 0)
check('↑ on the first row wraps to the last', moveActiveRow(0, -1, 3), 2)
check('no rows stays at 0', moveActiveRow(4, 1, 0), 0)

// ── bottom sheet ─────────────────────────────────────────────────────────────
check('the breakpoint is 600px', COMPACT_MAX_WIDTH, 600)
check('a 390px phone is compact', isCompactViewport(390, false), true)
check('600px is compact', isCompactViewport(600, false), true)
check('601px with a mouse is not', isCompactViewport(601, false), false)
check('a touch screen is compact at any width', isCompactViewport(1280, true), true)
check('no keyboard, no inset', keyboardInset(844, { height: 844, offsetTop: 0 }), 0)
check('the keyboard lifts the sheet', keyboardInset(844, { height: 508, offsetTop: 0 }), 336)
check('a scrolled visual viewport counts', keyboardInset(844, { height: 508, offsetTop: 40 }), 296)
check('no visual viewport, no inset', keyboardInset(844, null), 0)

rmSync(outDir, { recursive: true, force: true })
if (failures) {
  console.error(`[variable-menu] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('[variable-menu] all checks passed')
