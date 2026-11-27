/**
 * Gate: no renderer code hands click handlers to the native context menu.
 *
 * On the desktop `window.api.showContextMenu` sends its template to the main
 * process over IPC, which structured-clones it: items carrying `click`
 * functions throw "An object could not be cloned" and no menu opens. The
 * Design canvas was fixed in #100; the Slides deck, the slide text boxes and
 * the Spreadsheet node view had the same bug (#118). They all go through
 * utils/nodeviewContextMenu.ts, which sends plain data and keeps the handlers
 * in the renderer (its logic is checked by design-canvas.test.mjs).
 *
 * This scans src/renderer for direct `showContextMenu(` calls outside that
 * helper and the platform drivers that implement it.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const rendererRoot = path.join(repoRoot, 'src', 'renderer', 'src')

// The helper itself, and the drivers / types that define the bridge.
const allowed = new Set(
  [
    'utils/nodeviewContextMenu.ts',
    'lib/api/drivers/electron.ts',
    'lib/api/drivers/web.ts',
    'lib/api/drivers/mobile.ts',
    'lib/types/api.ts'
  ].map((p) => path.join(rendererRoot, p))
)
// Vendored copies and generated bundles are not app code.
const skippedDirs = new Set(['node_modules', 'dist', 'docs', 'project'])

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!skippedDirs.has(name)) yield* sourceFiles(full)
    } else if (/\.(svelte|ts|tsx|js|mjs)$/.test(name)) {
      yield full
    }
  }
}

// `showContextMenu(` or `showContextMenu?.(`, not a declaration or a type.
const directCall = /\bshowContextMenu\s*(\?\.)?\s*\(/g

const offenders = []
let scanned = 0
for (const file of sourceFiles(rendererRoot)) {
  scanned++
  if (allowed.has(file)) continue
  const text = readFileSync(file, 'utf-8')
  for (const match of text.matchAll(directCall)) {
    const line = text.slice(0, match.index).split('\n').length
    const lineText = text.split('\n')[line - 1]
    if (/^\s*(\/\/|\*)/.test(lineText)) continue // commented out
    offenders.push(`${path.relative(repoRoot, file)}:${line}: ${lineText.trim()}`)
  }
}

if (offenders.length) {
  console.error(
    '[context-menu-callers]   FAIL  direct showContextMenu calls (use showNodeviewContextMenu):\n' +
      offenders.map((o) => `                          ${o}`).join('\n')
  )
  process.exit(1)
}
console.log(
  `[context-menu-callers]   ok    ${scanned} renderer files: every context menu goes through the clone-safe helper`
)
