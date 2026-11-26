#!/usr/bin/env node
// Checks that Ctrl+S / Cmd+S reach the application's save pipeline and never
// the browser's own "Save page as".
//
// Why this exists
//   On the web, Ctrl+S opened the browser's "Save page" dialog and offered to
//   download the application's HTML: nothing in the page handled the key. On
//   desktop the only handler was the menu accelerator, which does not fire
//   where the platform hides the menu bar. The shortcut is now handled in the
//   page, for every target, by src/renderer/src/services/save/saveShortcut.ts.
//
// Usage
//   npm run test:smoke:save-shortcut

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'renderer', 'src', 'services', 'save', 'saveShortcut.ts')
const MAIN_SVELTE = path.join(repoRoot, 'src', 'renderer', 'src', 'Main.svelte')
const PIPELINE = path.join(
  repoRoot,
  'src',
  'renderer',
  'src',
  'services',
  'save',
  'savePipeline.service.ts'
)

const log = (...args) => console.log('[save-shortcut]', ...args)
let failures = 0

function check(name, actual, expected) {
  if (actual === expected) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-save-shortcut-'))
try {
  const compiled = path.join(work, 'saveShortcut.mjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [SOURCE, '--bundle', '--platform=neutral', '--format=esm', `--outfile=${compiled}`],
    { encoding: 'utf8' }
  )
  if (build.status !== 0) {
    console.error(`[save-shortcut] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const { matchSaveShortcut, installSaveShortcut, isMacPlatform } = await import(
    `file://${compiled}`
  )

  // --- matching -------------------------------------------------------------
  const key = (k, mods = {}) => ({ key: k, code: 'KeyS', ...mods })
  check(
    'Ctrl+S saves (Windows, Linux)',
    matchSaveShortcut(key('s', { ctrlKey: true }), false),
    'save'
  )
  check(
    'Ctrl+Shift+S is Save As',
    matchSaveShortcut(key('S', { ctrlKey: true, shiftKey: true }), false),
    'save-as'
  )
  check('Cmd+S saves (macOS)', matchSaveShortcut(key('s', { metaKey: true }), true), 'save')
  check(
    'Cmd+Shift+S is Save As (macOS)',
    matchSaveShortcut(key('s', { metaKey: true, shiftKey: true }), true),
    'save-as'
  )
  check('Ctrl+S is left alone on macOS', matchSaveShortcut(key('s', { ctrlKey: true }), true), null)
  check(
    'Cmd+S is left alone off macOS',
    matchSaveShortcut(key('s', { metaKey: true }), false),
    null
  )
  check(
    'Ctrl+Alt+S (Save All, AltGr) is not a plain save',
    matchSaveShortcut(key('s', { ctrlKey: true, altKey: true }), false),
    null
  )
  check('plain S types a letter', matchSaveShortcut(key('s'), false), null)
  check(
    'Ctrl+D is not a save',
    matchSaveShortcut({ key: 'd', code: 'KeyD', ctrlKey: true }, false),
    null
  )
  check(
    'a layout where the S key types another letter still saves',
    matchSaveShortcut({ key: 'ы', code: 'KeyS', ctrlKey: true }, false),
    'save'
  )
  check(
    'IME composition is left alone',
    matchSaveShortcut(key('s', { ctrlKey: true, isComposing: true }), false),
    null
  )
  check('isMacPlatform: macOS', isMacPlatform({ platform: 'MacIntel' }), true)
  check(
    'isMacPlatform: Linux',
    isMacPlatform({ platform: 'Linux x86_64', userAgent: 'X11' }),
    false
  )

  // --- the listener -----------------------------------------------------------
  const listeners = []
  const target = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }
  const actions = []
  const dispose = installSaveShortcut(target, (a) => actions.push(a), false)
  check('listens in the capture phase', listeners[0]?.capture, true)

  const fire = (mods, extra = {}) => {
    const event = {
      key: 's',
      code: 'KeyS',
      ...mods,
      ...extra,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.propagationStopped = true
      }
    }
    listeners[0].fn(event)
    return event
  }
  const saved = fire({ ctrlKey: true })
  check('Ctrl+S prevents the browser "Save page"', saved.defaultPrevented, true)
  check('Ctrl+S does not reach the editors', saved.propagationStopped, true)
  check('Ctrl+S runs one save', actions.join(','), 'save')
  const repeated = fire({ ctrlKey: true }, { repeat: true })
  check('a held key is still prevented', repeated.defaultPrevented, true)
  check('a held key does not save again', actions.length, 1)
  const typed = fire({})
  check('a plain key is not prevented', typed.defaultPrevented, false)
  fire({ ctrlKey: true, shiftKey: true })
  check('Ctrl+Shift+S runs Save As', actions.at(-1), 'save-as')
  dispose()
  check('the listener is removed on dispose', listeners.length, 0)

  // --- wiring ---------------------------------------------------------------
  const mainSvelte = readFileSync(MAIN_SVELTE, 'utf8')
  check(
    'Main.svelte installs the shortcut',
    /installSaveShortcut\(\s*window/.test(mainSvelte),
    true
  )
  check(
    'the shortcut goes through the menu save actions',
    /'file:save-as' : 'file:save'/.test(mainSvelte),
    true
  )
  const pipeline = readFileSync(PIPELINE, 'utf8')
  check(
    'a save in flight is joined, not repeated',
    /if \(saveInFlight\) return saveInFlight/.test(pipeline),
    true
  )

  const helpers = readFileSync(
    path.join(repoRoot, 'src', 'renderer', 'src', 'utils', 'EditorHelpers.ts'),
    'utf8'
  )
  check(
    'pending editor writes are flushed before the document is packed',
    /await Utils\.flushPendingWrites\(\)\s*savedDocPath = await document\.saveTo\(/.test(helpers),
    true
  )

  const sheetCollab = readFileSync(
    path.join(
      repoRoot,
      'src',
      'renderer',
      'src',
      'extensions',
      'tiptap',
      'CustomSpreadsheetExtension',
      'collab',
      'collab.ts'
    ),
    'utf8'
  )
  check(
    'sheets take part in the flush before a save',
    /Utils\.registerWriteFlusher\(/.test(sheetCollab),
    true
  )

  if (failures > 0) {
    console.error(`\n[save-shortcut] FAIL: ${failures} check(s) failed\n`)
    process.exit(1)
  }
  log('OK — Ctrl+S and Cmd+S save through the app, never through the browser')
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
}
