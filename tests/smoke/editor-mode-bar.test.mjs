/**
 * Gate: the logic behind the editor mode bar (mode, @ Variables, AI).
 *
 * editorModeBar.utils.ts decides which mode the bar shows (from the editor's
 * review storage and the document's review settings), what picking a mode
 * does to track changes and markup, how the variables switch is announced and
 * when the bar folds into the compact (phone / touch) layout. A wrong answer
 * there means the bar says "Editing" while every keystroke becomes a
 * suggestion, so it is checked here without starting the app.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

let failures = 0
const ok = (what) => console.log(`[editor-mode-bar]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[editor-mode-bar]   FAIL  ${what}\n                      ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The module has no imports: bundled alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'editor-mode-bar-'))
const compiled = path.join(outDir, 'editorModeBar.utils.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(repoRoot, 'src/renderer/src/extensions/tiptap/EditorModeBar/editorModeBar.utils.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=warning',
    `--outfile=${compiled}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[editor-mode-bar] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const m = await import(`file://${compiled}`)

// --- which mode the bar shows -------------------------------------------
check('nothing known: edit', m.resolveReviewMode({}), 'edit')
check(
  'track changes on in the editor: suggest',
  m.resolveReviewMode({ editorTrackChanges: true }),
  'suggest'
)
check(
  'the editor flag wins over the document config',
  [
    m.resolveReviewMode({ editorTrackChanges: false, configTrackChanges: true }),
    m.resolveReviewMode({ editorTrackChanges: true, configTrackChanges: false })
  ],
  ['edit', 'suggest']
)
check(
  'no editor flag: the document config decides',
  m.resolveReviewMode({ editorTrackChanges: undefined, configTrackChanges: true }),
  'suggest'
)
check(
  'hidden markup is view mode',
  ['original', 'none'].map((markupMode) => m.resolveReviewMode({ markupMode })),
  ['view', 'view']
)
check(
  'visible markup is edit mode',
  ['all', 'simple', '', null].map((markupMode) => m.resolveReviewMode({ markupMode })),
  ['edit', 'edit', 'edit', 'edit']
)
check(
  'track changes wins over hidden markup',
  m.resolveReviewMode({ editorTrackChanges: true, markupMode: 'original' }),
  'suggest'
)

// --- what picking a mode does --------------------------------------------
check(
  'mode commands',
  m.REVIEW_MODES.map((mode) => m.reviewModeCommands(mode)),
  [
    { trackChanges: false, markupMode: 'all' },
    { trackChanges: true, markupMode: 'all' },
    { trackChanges: false, markupMode: 'original' }
  ]
)
check(
  'every mode reads back as itself',
  m.REVIEW_MODES.map((mode) => {
    const c = m.reviewModeCommands(mode)
    return m.resolveReviewMode({ editorTrackChanges: c.trackChanges, markupMode: c.markupMode })
  }),
  ['edit', 'suggest', 'view']
)
check('modes cycle in bar order', m.REVIEW_MODES.map(m.nextReviewMode), ['suggest', 'view', 'edit'])

// --- labels ----------------------------------------------------------------
check(
  'only suggest mode is tinted as review',
  m.REVIEW_MODES.map((mode) => m.reviewModeMeta(mode).tone),
  ['neutral', 'review', 'neutral']
)
check('an unknown mode falls back to edit', m.reviewModeMeta('bogus').mode, 'edit')

const locales = ['en', 'fr', 'ja']
const lookup = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict)
for (const lang of locales) {
  const dict = JSON.parse(
    readFileSync(
      path.join(repoRoot, `src/renderer/src/assets/locales/${lang}/modeBar.json`),
      'utf-8'
    )
  )
  const keys = [
    ...m.REVIEW_MODES.flatMap((mode) => [
      m.reviewModeMeta(mode).labelKey,
      m.reviewModeMeta(mode).hintKey
    ]),
    ...[true, false].flatMap((on) => [
      m.variablesSwitchState(on).stateKey,
      m.variablesSwitchState(on).descriptionKey
    ])
  ]
  const missing = keys.filter((key) => typeof lookup(dict, key) !== 'string')
  check(`${lang}: every mode and switch label is translated`, missing, [])
}

// --- variables switch ------------------------------------------------------
check('switch on', m.variablesSwitchState(true), {
  ariaChecked: 'true',
  stateKey: 'modeBar.vars.on',
  descriptionKey: 'modeBar.vars.onHint'
})
check('switch off', m.variablesSwitchState(false).ariaChecked, 'false')

// --- AI status ---------------------------------------------------------------
check(
  'AI status labels',
  ['idle', 'running', 'repairing', 'long-running', 'error', undefined].map(m.aiPhaseLabelKey),
  [null, 'Generating', 'Repairing JSON', 'Still working', 'Error', null]
)

// --- compact layout ----------------------------------------------------------
check(
  'compact at 600px and below, or on a touch screen',
  [
    m.isCompactLayout({ width: 390, coarsePointer: false }),
    m.isCompactLayout({ width: 600, coarsePointer: false }),
    m.isCompactLayout({ width: 601, coarsePointer: false }),
    m.isCompactLayout({ width: 1440, coarsePointer: true })
  ],
  [true, true, false, true]
)
check(
  'the media query says the same',
  m.COMPACT_MEDIA_QUERY,
  '(max-width: 600px), (pointer: coarse)'
)

// --- menu keyboard navigation -----------------------------------------------
const none = [false, false, false]
check('down wraps', [m.moveMenuFocus(0, 1, none), m.moveMenuFocus(2, 1, none)], [1, 0])
check('up wraps', [m.moveMenuFocus(0, -1, none), m.moveMenuFocus(1, -1, none)], [2, 0])
check(
  'first and last',
  [m.moveMenuFocus(1, 'first', none), m.moveMenuFocus(1, 'last', none)],
  [0, 2]
)
check(
  'disabled entries are skipped',
  [m.moveMenuFocus(0, 1, [false, true, false]), m.moveMenuFocus(0, 'last', [false, false, true])],
  [2, 1]
)
check('empty menu', m.moveMenuFocus(0, 1, []), -1)

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[editor-mode-bar] FAILED: ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[editor-mode-bar] OK: the mode bar shows the mode the editor is really in')
