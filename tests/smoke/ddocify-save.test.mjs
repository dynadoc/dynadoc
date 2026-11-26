#!/usr/bin/env node
// Packs a document folder the way a desktop save does, and checks that the
// file on disk is replaced in one step.
//
// Why this exists
//   Saving a new document to a folder chosen in Save As failed on desktop with
//   "DENIED: This path is outside the application's own folders". The renderer
//   wrote a sibling "<name>.tmp.xddoc" and renamed it, but the dialog grants
//   the chosen file only, so the filesystem policy refused the neighbour and
//   left the stray .tmp file behind. The main process now writes next to the
//   target itself and renames it into place. This test pins that down:
//     - the archive round-trips and replaces an existing document
//     - no temporary file is left next to the document
//     - a failed pack leaves the previous document untouched
//     - the `ddocify` IPC handler checks its target against the policy
//
// Usage
//   npm run test:smoke:ddocify-save

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'main', 'utils', 'Utils.ts')
const MAIN = path.join(repoRoot, 'src', 'main', 'index.ts')
const DOCUMENT_MODEL = path.join(repoRoot, 'src', 'renderer', 'src', 'models', 'Document.ts')

const log = (...args) => console.log('[ddocify-save]', ...args)
let failures = 0

function check(name, actual, expected) {
  if (actual === expected) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-ddocify-save-'))
try {
  // Utils.ts takes no Electron import, so esbuild can make it importable alone.
  // CommonJS output, because yazl and yauzl are CommonJS and require Node
  // built-ins at load time, which an ESM bundle cannot do.
  const compiled = path.join(work, 'utils.cjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [SOURCE, '--bundle', '--platform=node', '--format=cjs', `--outfile=${compiled}`],
    { encoding: 'utf8' }
  )
  if (build.status !== 0) {
    console.error(`[ddocify-save] FAIL: could not compile Utils.ts\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const Utils = createRequire(import.meta.url)(compiled).default

  const source = path.join(work, 'cache', 'Report')
  mkdirSync(path.join(source, 'assets'), { recursive: true })
  writeFileSync(path.join(source, 'index.html'), '<p>first version</p>')
  writeFileSync(path.join(source, 'assets', 'note.txt'), 'asset')

  const chosenFolder = path.join(work, 'Documents')
  mkdirSync(chosenFolder, { recursive: true })
  const target = path.join(chosenFolder, 'Report.xddoc')

  // 1. First save writes the document, and nothing else, into the folder.
  const written = await Utils.ddocify(null, source, target, false)
  check('returns the chosen path', written, target)
  check('the document exists', existsSync(target), true)
  check(
    'nothing but the document is left in the folder',
    readdirSync(chosenFolder).join(','),
    'Report.xddoc'
  )

  const unpacked = path.join(work, 'unpacked-1')
  await Utils.unddocify(null, target, unpacked)
  check(
    'the archive round-trips',
    readFileSync(path.join(unpacked, 'index.html'), 'utf8'),
    '<p>first version</p>'
  )
  check(
    'assets round-trip',
    readFileSync(path.join(unpacked, 'assets', 'note.txt'), 'utf8'),
    'asset'
  )

  // 2. Saving again replaces the document in place.
  writeFileSync(path.join(source, 'index.html'), '<p>second version</p>')
  await Utils.ddocify(null, source, target, false)
  const unpacked2 = path.join(work, 'unpacked-2')
  await Utils.unddocify(null, target, unpacked2)
  check(
    'a second save replaces the content',
    readFileSync(path.join(unpacked2, 'index.html'), 'utf8'),
    '<p>second version</p>'
  )
  check('still no temporary file after a second save', readdirSync(chosenFolder).length, 1)

  // 3. A name without the extension gets it, as before.
  const bare = path.join(chosenFolder, 'Notes')
  const bareWritten = await Utils.ddocify(null, source, bare, false)
  check('a bare name gets the document extension', bareWritten, `${bare}.xddoc`)

  // 4. A pack that fails leaves the previous document as it was.
  const before = readFileSync(target)
  let threw = false
  try {
    await Utils.ddocify(null, path.join(work, 'cache', 'does-not-exist'), target, false)
  } catch {
    threw = true
  }
  check('a failed pack reports the failure', threw, true)
  check(
    'a failed pack keeps the previous document',
    Buffer.compare(before, readFileSync(target)),
    0
  )
  check(
    'a failed pack leaves no partial file',
    readdirSync(chosenFolder).filter((n) => n.endsWith('.partial')).length,
    0
  )

  // 5. The IPC handler answers to the filesystem policy before it writes.
  const mainSource = readFileSync(MAIN, 'utf8')
  const start = mainSource.indexOf("'ddocify',")
  const body = mainSource.slice(start, mainSource.indexOf('ipcMain.handle(', start))
  check('the ddocify handler was found', start > 0, true)
  check(
    'the ddocify handler checks its target',
    /outputFile = requirePath\(outputFile\)/.test(body),
    true
  )

  // 6. The desktop save no longer writes a sibling temporary file itself.
  const modelSource = readFileSync(DOCUMENT_MODEL, 'utf8')
  const saveTo = modelSource.slice(modelSource.indexOf('async saveTo('))
  check(
    'desktop saves hand the chosen path to ddocify',
    /if \(isDesktopPlatform\) \{[\s\S]{0,800}window\.api\.ddocify\(cacheDir, outputPath/.test(
      saveTo
    ),
    true
  )

  if (failures > 0) {
    console.error(`\n[ddocify-save] FAIL: ${failures} check(s) failed\n`)
    process.exit(1)
  }
  log('OK — documents are written in one step, and only where the policy allows')
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
}
