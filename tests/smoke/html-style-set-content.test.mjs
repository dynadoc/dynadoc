/**
 * Gate: editor.commands.setContent() with CustomHtmlStyleExtension loaded.
 *
 * The extension overrides the setContent command so <style> tags are encoded
 * before the ProseMirror parser drops them. Its override used to call
 * `commands.setContent`, which resolves to the override itself, so every
 * setContent threw "Maximum call stack size exceeded" (dynadoc#93). This runs
 * a headless Tiptap editor (happy-dom provides the DOM) with the extension and
 * checks that setContent replaces the document, keeps <style> blocks, honours
 * the emitUpdate option and can be undone.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const TAG = '[html-style-set-content]'

let failures = 0
const ok = (what) => console.log(`${TAG}   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`${TAG}   FAIL  ${what}\n                      ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// Bundle the extension together with Tiptap and its undo history,
// so there is a single copy of each ProseMirror package.
const outDir = mkdtempSync(path.join(tmpdir(), 'html-style-set-content-'))
const compiled = path.join(outDir, 'bundle.mjs')
const ext =
  './src/renderer/src/extensions/tiptap/CustomHtmlStyleExtension/CustomHtmlStyleExtension.ts'
const entry = [
  `export { Editor } from '@tiptap/core'`,
  `export { default as StarterKit } from '@tiptap/starter-kit'`,
  `export * from ${JSON.stringify(ext)}`
].join('\n')
// Read from stdin with cwd = repo root, so imports resolve against node_modules.
const build = spawnSync(
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  ['--bundle', '--platform=node', '--format=esm', '--log-level=error', `--outfile=${compiled}`],
  { encoding: 'utf-8', cwd: repoRoot, input: entry }
)
if (build.status !== 0) {
  console.error(`${TAG} FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const m = await import(`file://${compiled}`)

const win = new Window({ url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'CSS']) {
  if (key === 'window') globalThis.window = win
  else if (!(key in globalThis) || key === 'document' || key === 'Node' || key === 'HTMLElement')
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
globalThis.getComputedStyle ??= win.getComputedStyle.bind(win)

const element = win.document.createElement('div')
win.document.body.appendChild(element)

let updates = 0
const editor = new m.Editor({
  element,
  extensions: [m.StarterKit, m.CustomHtmlStyleExtension],
  content: '<p>Original</p>',
  onUpdate: () => updates++
})

// --- setContent no longer recurses ---------------------------------------
let threw = null
try {
  check('setContent returns true', editor.commands.setContent('<p>Hello</p>'), true)
} catch (err) {
  threw = err
}
if (threw)
  fail(
    'setContent does not throw',
    String(threw && threw.stack ? threw.stack.split('\n')[0] : threw)
  )
else ok('setContent does not throw')
check('content is replaced', editor.getHTML(), '<p>Hello</p>')
check('emitUpdate defaults to true', updates, 1)

// --- undo goes back to the previous document -----------------------------
check('undo succeeds', editor.commands.undo(), true)
check('undo restores the previous content', editor.getHTML(), '<p>Original</p>')

// --- <style> blocks survive as styleBlock nodes ---------------------------
editor.commands.setContent('<style>.x{color:red}</style><p class="x">Styled</p>')
const types = []
editor.state.doc.forEach((n) => types.push(n.type.name))
check('a <style> tag becomes a styleBlock node', types, ['styleBlock', 'paragraph'])
check(
  'the CSS round-trips through the save helper',
  m.getHtmlWithStyleBlocks(editor).includes('<style>.x{color:red}</style>'),
  true
)

// --- options: Tiptap 3 object form and the legacy boolean form -----------
updates = 0
editor.commands.setContent('<p>Quiet</p>', { emitUpdate: false })
check('{ emitUpdate: false } emits no update', updates, 0)
editor.commands.setContent('<p>Quiet too</p>', false)
check('legacy boolean false emits no update', updates, 0)
check('legacy boolean form still sets content', editor.getHTML(), '<p>Quiet too</p>')

// --- JSON content passes through -----------------------------------------
editor.commands.setContent({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From JSON' }] }]
})
check('JSON content is accepted', editor.getHTML(), '<p>From JSON</p>')

editor.destroy()
await win.happyDOM.close()
rmSync(outDir, { recursive: true, force: true })

if (failures) {
  console.error(`${TAG} ${failures} check(s) failed`)
  process.exit(1)
}
console.log(`${TAG} all checks passed`)
