/**
 * Gate: the logic behind the Design canvas that broke it without an error.
 *
 * - utils/editorIdentity.ts finds the WYSIWYG entry, and its active node view,
 *   of a document editor. The Design tool bar looked it up by the document
 *   editor's `id` while entries are keyed by its identity (uuid, path), found
 *   nothing, and every tool click was a no-op (#99).
 * - utils/nodeviewContextMenu.ts builds the canvas context menu. Its template
 *   crosses IPC, so it must be plain data: one carrying the click handlers
 *   threw "An object could not be cloned" and no menu opened (#100).
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

// --- #100: the context menu template must survive structured clone ---------
{
  const m = await load('src/renderer/src/utils/nodeviewContextMenu.ts')
  const calls = []
  const entries = [
    { separator: true },
    { label: 'Duplicate', run: () => calls.push('dup') },
    { separator: true },
    { separator: true },
    { label: 'Center', run: () => calls.push('center') },
    { separator: true }
  ]
  const { template, actions } = m.buildNativeMenu(entries, 3)

  let cloneError = null
  try {
    structuredClone(template)
  } catch (error) {
    cloneError = error.name
  }
  check('the native template is structured-clone safe', cloneError, null)
  let oldCloneError = null
  try {
    structuredClone([{ label: 'Center', click: () => {} }])
  } catch (error) {
    oldCloneError = error.name
  }
  check('(the old template, with click handlers, was not)', oldCloneError, 'DataCloneError')
  check('labels, one clickId each, no stray separators', template, [
    { label: 'Duplicate', clickId: 'nodeview-menu:3:1' },
    { type: 'separator' },
    { label: 'Center', clickId: 'nodeview-menu:3:4' }
  ])
  actions.get('nodeview-menu:3:4')()
  check('a clickId runs its own handler', calls, ['center'])

  const web = m.buildWebMenu(entries)
  check(
    'in-app menu: actions kept, separators become groups',
    web.map((i) => [i.label, i.group, typeof i.action]),
    [
      ['Duplicate', 0, 'function'],
      ['Center', 1, 'function']
    ]
  )

  // Desktop: plain template over the bridge, handler run on the answer.
  const sent = []
  let listener = null
  let unsubscribed = 0
  const bridge = {
    showContextMenu: (t) => sent.push(structuredClone(t)),
    onInvokeMenuAction: (cb) => {
      listener = cb
      return () => unsubscribed++
    }
  }
  calls.length = 0
  m.showNodeviewContextMenu(entries, true, bridge)
  const firstId = sent[0]?.[0]?.clickId
  listener?.(null, 'insert:table')
  listener?.(null, firstId)
  check('desktop: template sent, foreign ids ignored, the chosen entry runs', calls, ['dup'])
  check('desktop: the listener is dropped once answered', unsubscribed, 1)

  const webSent = []
  m.showNodeviewContextMenu(entries, false, { showContextMenu: (t) => webSent.push(t) })
  check('web: the in-app items are handed over', webSent[0]?.length, 2)
}

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[design-canvas] FAILED: ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[design-canvas] OK: the Design canvas finds its node view and opens its menu')
