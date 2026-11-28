#!/usr/bin/env node
/**
 * Gate: a spreadsheet document is never written without its workbook.
 *
 * A spreadsheet document is a Tiptap document whose only content is one
 * `<sheet src="...">` element. Typing with that element selected replaced it
 * with text, and the autosave wrote that text as the whole document
 * (dynadoc#133). documentContentGuard.ts decides which writes are refused;
 * Utils.saveToFile and saveDocumentEditor act on its answer. This checks the
 * rule, that it only applies to the documents registered as spreadsheets, and
 * that the user is told once per refused episode, not on every autosave.
 *
 * Usage
 *   npm run test:smoke:sheet-save-guard
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
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) {
    console.log(`[sheet-save-guard]   ok    ${what}`)
  } else {
    failures++
    console.error(
      `[sheet-save-guard]   FAIL  ${what}\n                       expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`
    )
  }
}

const outDir = mkdtempSync(path.join(tmpdir(), 'sheet-save-guard-'))
try {
  const compiled = path.join(outDir, 'documentContentGuard.mjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [
      path.join(repoRoot, 'src/renderer/src/utils/documentContentGuard.ts'),
      '--bundle',
      '--format=esm',
      '--platform=neutral',
      `--outfile=${compiled}`
    ],
    { encoding: 'utf-8' }
  )
  if (build.status !== 0) {
    console.error(`[sheet-save-guard] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }

  // The web build: no Electron bridge.
  globalThis.window = globalThis.window || {}
  const { isSafeToWrite, registerDocumentKind, checkDocumentWrite, isDocumentWriteRefused } =
    await import(`file://${compiled}`)

  const healthy =
    '<sheet uuid="u1" data-uuid="u1" src="assets/sheet/sheet.json" id="s1" layout="inline"></sheet>'

  // The rule itself.
  check('a sheet document with its <sheet> may be written', isSafeToWrite('sheet', healthy), true)
  check(
    'a sheet document whose <sheet> was replaced by text is refused',
    isSafeToWrite('sheet', '<p>hello</p>'),
    false
  )
  check('an empty sheet document is refused', isSafeToWrite('sheet', ''), false)
  check(
    'a <sheet> with no src yet (a new document before its node view ran) is accepted',
    isSafeToWrite('sheet', '<sheet id="s1"></sheet>'),
    true
  )
  check(
    'a <sheetname> element is not a <sheet>',
    isSafeToWrite('sheet', '<sheetname></sheetname>'),
    false
  )
  check('a text document without a sheet is accepted', isSafeToWrite('text', '<p>hello</p>'), true)
  check('an unknown kind is accepted', isSafeToWrite(undefined, '<p>hello</p>'), true)

  // Writes by path.
  const sheetPath = 'home/u/Budget/index.html'
  const textPath = 'home/u/Notes/index.html'
  registerDocumentKind(sheetPath, 'sheet')
  registerDocumentKind(textPath, 'text')

  check('a text document is never refused', checkDocumentWrite(textPath, '<p>x</p>').ok, true)
  check('an unregistered path is never refused', checkDocumentWrite('other.html', '').ok, true)
  check('a healthy sheet write passes', checkDocumentWrite(sheetPath, healthy).ok, true)
  check('no refusal is pending after a good write', isDocumentWriteRefused(sheetPath), false)

  const first = checkDocumentWrite(sheetPath, '<p>hello</p>')
  check('the first bad write is refused', first.ok, false)
  check('and is reported as the first refusal', first.firstRefusal, true)
  const second = checkDocumentWrite(sheetPath, '<p>hello world</p>')
  check('the next autosave is refused too', second.ok, false)
  check('without telling the user again', second.firstRefusal, false)
  check('the refusal is pending for an explicit save', isDocumentWriteRefused(sheetPath), true)
  check(
    'a leading slash or file:// names the same file on the web',
    isDocumentWriteRefused(`file:///${sheetPath}`),
    true
  )

  check(
    'undo brings the <sheet> back: the write passes',
    checkDocumentWrite(sheetPath, healthy).ok,
    true
  )
  check('and clears the refusal', isDocumentWriteRefused(sheetPath), false)
  check(
    'a later bad write is reported again',
    checkDocumentWrite(sheetPath, '<p>again</p>').firstRefusal,
    true
  )

  registerDocumentKind(sheetPath, undefined)
  check(
    'a copy of the document that does not know its kind keeps the rule',
    checkDocumentWrite(sheetPath, '<p>x</p>').ok,
    false
  )
  checkDocumentWrite(sheetPath, healthy)

  registerDocumentKind(sheetPath, 'text')
  check(
    're-registering a path with another kind lifts the rule',
    checkDocumentWrite(sheetPath, '<p>x</p>').ok,
    true
  )

  // The write path really consults the guard.
  const utilsSource = readFileSync(path.join(repoRoot, 'src/renderer/src/utils/Utils.ts'), 'utf8')
  const saveToFile = utilsSource.slice(
    utilsSource.indexOf('public static saveToFile('),
    utilsSource.indexOf('public static saveToFileDebounced(')
  )
  check(
    'Utils.saveToFile checks the guard before it writes',
    saveToFile.indexOf('checkDocumentWrite(') > -1 &&
      saveToFile.indexOf('checkDocumentWrite(') < saveToFile.indexOf('.writeFile('),
    true
  )
  const modelSource = readFileSync(
    path.join(repoRoot, 'src/renderer/src/models/Document.ts'),
    'utf8'
  )
  const getMainFilePath = modelSource.slice(
    modelSource.indexOf('getMainFilePath(loadDocumentIfNotExist'),
    modelSource.indexOf('async getMainFileContent(')
  )
  check(
    'computing a main file path records the document kind',
    /registerDocumentKind\(mainFilePath, this\.info\?\.contentType\)/.test(getMainFilePath),
    true
  )
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`[sheet-save-guard] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('[sheet-save-guard] all checks passed')
