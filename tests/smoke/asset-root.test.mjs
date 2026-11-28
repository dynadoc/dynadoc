#!/usr/bin/env node
// Checks where a document keeps its assets (src/renderer/src/utils/assetRoot.ts)
// and how an asset file gets a free name there (src/renderer/src/utils/uniqueName.ts).
//
// Why this exists
//   #149: on the web every Design document read and wrote the same file,
//   `assets/design/design.json` at the drive root. The asset folder was
//   resolved relative to the cache directory (`cache`), which a web document
//   (`drive/home/...`) is not under, and the result climbed out to the drive
//   root. The same helper serves slides and sheets. And the file name never
//   moved past `design.json`: the web `fs:readdir` answers entry objects, which
//   the name picker read as "[object Object]".
//
// Usage
//   npm run test:smoke:asset-root

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'renderer', 'src', 'utils', 'assetRoot.ts')
const UNIQUE_NAME = path.join(repoRoot, 'src', 'renderer', 'src', 'utils', 'uniqueName.ts')

const log = (...args) => console.log('[asset-root]', ...args)
let failures = 0

function check(name, actual, expected) {
  if (actual === expected) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-asset-root-'))
try {
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const compile = async (source, name) => {
    const compiled = path.join(work, name)
    const build = spawnSync(
      esbuild,
      [source, '--bundle', '--platform=neutral', '--format=esm', `--outfile=${compiled}`],
      { encoding: 'utf8' }
    )
    if (build.status !== 0) {
      console.error(`[asset-root] FAIL: could not compile\n${build.stdout}${build.stderr}`)
      process.exit(1)
    }
    return import(`file://${compiled}`)
  }
  const { documentAssetRoot, isDriveRootAssetPath } = await compile(SOURCE, 'assetRoot.mjs')
  const { pickUniqueName, directoryEntryName } = await compile(UNIQUE_NAME, 'uniqueName.mjs')

  // What a web document got before the fix: the desktop fallback
  // (getFileRootFromBaseDir), relative to `cache`, which lands on the drive root.
  const desktopFallback = (cacheDir, documentPath) => {
    const relative = path.posix.relative(cacheDir, documentPath)
    return path.posix.join(cacheDir, relative.split('/')[0])
  }
  check(
    'the old fallback returned the drive root for a web document',
    desktopFallback('cache', 'drive/home/a/New Document/index.html'),
    '.'
  )

  const web = (documentPath, isDirectory = false) =>
    documentAssetRoot({
      documentPath,
      cacheDir: 'cache',
      isDesktop: false,
      isDirectory,
      rootOutsideCache: desktopFallback
    })
  check(
    'web: the root is the folder of the main file',
    web('drive/home/0f/New Document/index.html'),
    'drive/home/0f/New Document'
  )
  check(
    'web: two documents get two roots',
    web('drive/home/0f/New Document/index.html') === web('drive/home/1a/New Document/index.html'),
    false
  )
  check(
    'web: a document folder is its own root',
    web('drive/home/0f/New Document', true),
    'drive/home/0f/New Document'
  )

  const desktop = (documentPath) =>
    documentAssetRoot({
      documentPath,
      cacheDir: '/cache',
      isDesktop: true,
      rootOutsideCache: () => 'outside'
    })
  check('desktop, in the cache: unchanged', desktop('/cache/u/Doc/index.html'), '/cache/u/Doc')
  check('desktop, outside the cache: unchanged', desktop('/elsewhere/Doc/index.html'), 'outside')

  check('shared store path', isDriveRootAssetPath('assets/design/design.json', 'design'), true)
  check('shared store, ./', isDriveRootAssetPath('./assets/design/design 2.json', 'design'), true)
  check('shared store, /', isDriveRootAssetPath('/assets/design/design.json', 'design'), true)
  check(
    'a document store is not shared',
    isDriveRootAssetPath('drive/home/0f/New Document/assets/design/design.json', 'design'),
    false
  )
  check('another type', isDriveRootAssetPath('assets/sheet/sheet.json', 'design'), false)
  check('empty', isDriveRootAssetPath('', 'design'), false)

  // What the web fs:readdir answers: the bridge's drive entries.
  const entry = (name) => ({ path: `x/${name}`, name, size: 1, mod_time: 0, is_dir: false })
  check('entry name, string', directoryEntryName('design.json'), 'design.json')
  check('entry name, drive entry', directoryEntryName(entry('design.json')), 'design.json')
  check(
    'free name in an empty folder',
    pickUniqueName([], 'design', '.json', ' ', null),
    'design.json'
  )
  check(
    'node readdir (strings): next name',
    pickUniqueName(['design.json'], 'design', '.json', ' ', null),
    'design 2.json'
  )
  check(
    'web readdir (entries): next name, not design.json again',
    pickUniqueName([entry('design.json'), entry('design 2.json')], 'design', '.json', ' ', null),
    'design 3.json'
  )
  check(
    'web: uuid folders do not number a new document',
    pickUniqueName([entry('0f6b8c1e-2a8e-4c55-9a3f-1e2d3c4b5a69')], 'New Document', '', ' ', null),
    'New Document'
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.error(`[asset-root] ${failures} check(s) failed`)
  process.exit(1)
}
log('all checks passed')
