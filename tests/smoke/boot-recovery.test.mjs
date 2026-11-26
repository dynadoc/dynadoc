#!/usr/bin/env node
// Checks what the renderer does when it fails to start.
//
// Why this exists
//   A boot that threw left the splash on "Preparing ..." forever. The common
//   cause is a module the dev server could not serve after re-optimising its
//   dependencies ("504 Outdated Optimize Dep"); the desktop renderer has no
//   HMR socket to reload the page by itself. src/renderer/src/bootRecovery.ts
//   reloads once for that kind of error and shows a message with a Reload
//   button for anything else, or when the reload did not help.
//
// Usage
//   npm run test:smoke:boot-recovery

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'renderer', 'src', 'bootRecovery.ts')
const MAIN_TS = path.join(repoRoot, 'src', 'renderer', 'src', 'main.ts')

const log = (...args) => console.log('[boot-recovery]', ...args)
let failures = 0

function check(name, actual, expected) {
  if (actual === expected) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-boot-recovery-'))
try {
  const compiled = path.join(work, 'bootRecovery.mjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [SOURCE, '--bundle', '--platform=neutral', '--format=esm', `--outfile=${compiled}`],
    { encoding: 'utf8' }
  )
  if (build.status !== 0) {
    console.error(`[boot-recovery] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const { isStaleModuleError, decideBootRecovery, BOOT_RELOAD_WINDOW_MS } = await import(
    `file://${compiled}`
  )

  const stale = new TypeError(
    'Failed to fetch dynamically imported module: http://localhost:5173/src/Main.svelte'
  )
  check('Chromium stale module is recognised', isStaleModuleError(stale), true)
  check(
    'Firefox stale module is recognised',
    isStaleModuleError(new TypeError('error loading dynamically imported module')),
    true
  )
  check(
    'Safari stale module is recognised',
    isStaleModuleError(new TypeError('Importing a module script failed.')),
    true
  )
  check('a plain bug is not a stale module', isStaleModuleError(new Error('x is undefined')), false)
  check('nothing is not a stale module', isStaleModuleError(undefined), false)

  const now = 1_000_000
  check(
    'first stale failure reloads',
    decideBootRecovery({ error: stale, lastAutoReloadAt: null, now }),
    'reload'
  )
  check(
    'a second stale failure right after the reload shows the message',
    decideBootRecovery({ error: stale, lastAutoReloadAt: now - 5_000, now }),
    'show-error'
  )
  check(
    'a stale failure long after the last reload reloads again',
    decideBootRecovery({ error: stale, lastAutoReloadAt: now - BOOT_RELOAD_WINDOW_MS - 1, now }),
    'reload'
  )
  check(
    'any other failure shows the message',
    decideBootRecovery({ error: new Error('boom'), lastAutoReloadAt: null, now }),
    'show-error'
  )

  const mainTs = readFileSync(MAIN_TS, 'utf8')
  check(
    'main.ts hands a failed boot to the recovery',
    /appPromise\.catch\(\(error\) => recoverFromBootFailure\(error\)\)/.test(mainTs),
    true
  )
  check(
    'main.ts checks the stylesheet imports too',
    /isStaleModuleError\(result\.reason\)/.test(mainTs),
    true
  )

  if (failures > 0) {
    console.error(`\n[boot-recovery] FAIL: ${failures} check(s) failed\n`)
    process.exit(1)
  }
  log('OK: a failed boot reloads once or explains itself, never spins forever')
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
}
