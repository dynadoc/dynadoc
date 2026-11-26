#!/usr/bin/env node
// Opening local files on desktop: the checks that keep an open from stalling.
//
// Why this exists
//   Opening a .xlsx picked in File > Open left the tab on "Preparing editor".
//   The renderer probes for optional companions of the file it opens (a
//   config file, a share manifest next to it), the dialog grants the chosen
//   file alone, and the existence channel answered a refused path by throwing,
//   which aborted the open half way. A refused path now reads as absent,
//   while reads and writes of it are still refused.
//
//   Opening a PDF went to the rich-text editor with no file to load: the PDF
//   entry of Utils.PREVIEWABLE_FILE_EXTENSIONS was 'pdf' where every caller
//   compares it with path.extname(), which is '.pdf'.
//
// Usage
//   npm run test:smoke:open-local-files

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const FS_IPC = path.join(repoRoot, 'src', 'main', 'ipc', 'filesystem.ts')
const RENDERER_UTILS = path.join(repoRoot, 'src', 'renderer', 'src', 'utils', 'Utils.ts')

const log = (...args) => console.log('[open-local-files]', ...args)
let failures = 0

function check(name, actual, expected) {
  if (actual === expected) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-open-local-files-'))
try {
  // A stand-in for the two Electron members these modules touch: ipcMain
  // records the handlers, app.getPath points the owned roots into `work`.
  const userData = path.join(work, 'userData')
  mkdirSync(path.join(userData, 'storage'), { recursive: true })
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `const handlers = (globalThis.__ddocIpcHandlers = {})
module.exports = {
  ipcMain: {
    on: (channel, fn) => { handlers[channel] = { kind: 'on', fn } },
    handle: (channel, fn) => { handlers[channel] = { kind: 'handle', fn } }
  },
  app: {
    getPath: (name) => (name === 'temp' ? ${JSON.stringify(path.join(work, 'temp'))} : ${JSON.stringify(userData)}),
    getName: () => 'dynadoc'
  },
  __handlers: handlers
}
`
  )

  const entry = path.join(work, 'entry.ts')
  writeFileSync(
    entry,
    `export { registerFilesystemIpc } from ${JSON.stringify(FS_IPC)}
export { FS_CHANNELS } from ${JSON.stringify(path.join(repoRoot, 'src', 'main', 'ipc', 'filesystemContract.ts'))}
`
  )
  const compiled = path.join(work, 'fs-ipc.cjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:electron=${electronStub}`,
      `--outfile=${compiled}`
    ],
    { encoding: 'utf8' }
  )
  if (build.status !== 0) {
    console.error(`[open-local-files] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const require = createRequire(import.meta.url)
  const { registerFilesystemIpc, FS_CHANNELS } = require(compiled)
  registerFilesystemIpc()
  // The stub is bundled into the compiled file, so its handler table is
  // reached through the global it publishes, not through a second require.
  const handlers = globalThis.__ddocIpcHandlers

  const callSync = (channel, p) => {
    const event = {}
    handlers[channel].fn(event, p)
    return event.returnValue
  }

  const owned = path.join(userData, 'storage', 'note.txt')
  writeFileSync(owned, 'mine')
  const outside = path.join(work, 'elsewhere')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'budget.config.json'), '{}')

  const ownedAnswer = callSync(FS_CHANNELS.exists, owned)
  check('exists: a file in the app folders', ownedAnswer?.ok && ownedAnswer.value, true)
  const missing = callSync(FS_CHANNELS.exists, path.join(userData, 'storage', 'nope.txt'))
  check('exists: a missing file in the app folders', missing?.ok && missing.value, false)
  const refused = callSync(FS_CHANNELS.exists, path.join(outside, 'budget.config.json'))
  check('exists: a path outside every grant answers, not throws', refused?.ok, true)
  check('exists: …and reads as absent, even though it is there', refused?.value, false)
  const stat = callSync(FS_CHANNELS.stat, path.join(outside, 'budget.config.json'))
  check('stat of the same path is still refused', stat?.ok === false && stat.error?.code, 'DENIED')
  let readRefused = false
  try {
    await handlers[FS_CHANNELS.readFile].fn({}, path.join(outside, 'budget.config.json'), 'utf-8')
  } catch (error) {
    readRefused = /DENIED/.test(String(error?.message))
  }
  check('reading the same path is still refused', readRefused, true)

  // PDF previews: the extension list compares against path.extname().
  const utilsSource = readFileSync(RENDERER_UTILS, 'utf8')
  const block = utilsSource.slice(utilsSource.indexOf('static PREVIEWABLE_FILE_EXTENSIONS'))
  check(
    "the PDF preview entry carries the dot, like path.extname('a.pdf')",
    /pdf: `\.\$\{Utils\.FILE_TYPES\.pdf\}`/.test(block.slice(0, 400)),
    true
  )

  if (failures > 0) {
    console.error(`\n[open-local-files] FAIL: ${failures} check(s) failed\n`)
    process.exit(1)
  }
  log('OK — probes next to an opened file answer, and refused paths stay refused')
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
}
