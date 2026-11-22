/**
 * Gate: the logic behind the Design canvas that broke it without an error.
 *
 * - utils/editorIdentity.ts finds the WYSIWYG entry, and its active node view,
 *   of a document editor. The Design tool bar looked it up by the document
 *   editor's `id` while entries are keyed by its identity (uuid, path), found
 *   nothing, and every tool click was a no-op (#99).
 *
 * Checked here without starting the app.
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
const ok = (what) => console.log(`[design-canvas]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[design-canvas]   FAIL  ${what}\n                    ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// Each module imports nothing at runtime: bundled alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'design-canvas-'))
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
async function load(relPath) {
  const outfile = path.join(outDir, path.basename(relPath).replace(/\.ts$/, '.mjs'))
  const build = spawnSync(
    esbuild,
    [
      path.join(repoRoot, relPath),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--log-level=warning',
      `--outfile=${outfile}`
    ],
    { encoding: 'utf-8' }
  )
  if (build.status !== 0) {
    console.error(
      `[design-canvas] FAIL: could not compile ${relPath}\n${build.stdout}${build.stderr}`
    )
    rmSync(outDir, { recursive: true, force: true })
    process.exit(1)
  }
  return import(`file://${outfile}`)
}

// --- #99: which node view the Design tool bar drives -----------------------
{
  const m = await load('src/renderer/src/utils/editorIdentity.ts')
  const path1 = '/data/dynadoc/8d56/New Document/index.html'
  const docEditor = { id: '8d56-uuid', uuid: path1, document: { uuid: '8d56-uuid' } }
  const entries = [
    {
      id: '/data/dynadoc/other/index.html',
      nodeViews: [{ id: 'x', type: 'design', isActive: true }]
    },
    {
      id: path1,
      nodeViews: [
        { id: 'slide-1', type: 'slide', isActive: false },
        { id: 'design-1', type: 'design', isActive: true }
      ]
    }
  ]

  check('identity: the editor uuid first', m.resolveEditorIdentity(docEditor), path1)
  check(
    'identity: then the document uuid, then the id',
    [
      m.resolveEditorIdentity({ id: 'a', document: { uuid: 'b' } }),
      m.resolveEditorIdentity({ id: 7 }),
      m.resolveEditorIdentity(null)
    ],
    ['b', '7', '']
  )
  check(
    'the entry of an editor opened from disk is found (the id alone misses it)',
    [
      m.findWysiwygEntryForEditor(entries, docEditor)?.id,
      entries.find((e) => e.id === docEditor.id)?.id ?? null
    ],
    [path1, null]
  )
  check(
    'its active node view, not another document one',
    m.findActiveNodeviewForEditor(entries, docEditor)?.id,
    'design-1'
  )
  check(
    'no active document, no entry or no active node view: nothing',
    [
      m.findActiveNodeviewForEditor(entries, undefined) ?? null,
      m.findActiveNodeviewForEditor(null, docEditor) ?? null,
      m.findActiveNodeviewForEditor(
        [{ id: path1, nodeViews: [{ id: 'd', isActive: false }] }],
        docEditor
      ) ?? null
    ],
    [null, null, null]
  )
}

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[design-canvas] FAILED: ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[design-canvas] OK: the Design canvas finds its node view')
