/**
 * Gate: looking a variable up never reads vars.json.
 *
 * `getVarsForEditor` and `DocumentModel.getVars` are async: each call asks
 * the main process whether vars.json exists, then reads and parses it. The
 * synchronous lookups (resolveVariableId, getVariable, listVariables...) run
 * for every chip, every sheet cell and every change listener, so a call left
 * there without `await` gets back a Promise it cannot use and still starts a
 * file read. That cost thousands of reads per saved variable, enough to hit
 * EMFILE in the main process and freeze the window for seconds.
 *
 * The rule checked here: in variableManipulator.ts, every call to one of
 * those loaders is awaited.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'))

const FILE = 'src/renderer/src/extensions/tiptap/CustomVarExtension/stores/variableManipulator.ts'
const ASYNC_LOADERS = new Set(['getVarsForEditor', 'getVars', 'loadVarsFromFile'])

let failures = 0
const ok = (what) => console.log(`[variable-lookup-io]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[variable-lookup-io]   FAIL  ${what}\n                         ${detail}`)
}

const source = readFileSync(path.join(repoRoot, FILE), 'utf-8')
const sf = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const calleeName = (call) => {
  const expr = call.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return ''
}

// `await x()`, `await x?.()`, also inside `(await x()) || {}`.
const isAwaited = (node) => {
  let parent = node.parent
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent
  return !!parent && ts.isAwaitExpression(parent)
}

const enclosingFunction = (node) => {
  let parent = node.parent
  while (parent && !ts.isFunctionLike(parent)) parent = parent.parent
  if (!parent) return '(top level)'
  if (parent.name) return parent.name.getText(sf)
  if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText(sf)
  return '(anonymous)'
}

const calls = []
const visit = (node) => {
  if (ts.isCallExpression(node) && ASYNC_LOADERS.has(calleeName(node))) calls.push(node)
  ts.forEachChild(node, visit)
}
visit(sf)

if (!calls.length) {
  fail('loader calls found', `no call to ${[...ASYNC_LOADERS].join(', ')} in ${FILE}`)
}

for (const call of calls) {
  const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf))
  const where = `${calleeName(call)}() in ${enclosingFunction(call)} (${FILE}:${line + 1})`
  if (isAwaited(call)) ok(`${where} is awaited`)
  else fail(`${where} is awaited`, 'a call that is not awaited reads vars.json for nothing')
}

// The lookups every chip, cell and listener runs must stay synchronous.
const SYNC_LOOKUPS = ['resolveVariableId', 'getVariable', 'getVariableId', 'listVariables']
for (const name of SYNC_LOOKUPS) {
  let found = null
  const find = (node) => {
    if (found) return
    const isNamed =
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isArrowFunction(node.initializer))
    if (isNamed) found = ts.isVariableDeclaration(node) ? node.initializer : node
    ts.forEachChild(node, find)
  }
  find(sf)
  if (!found) {
    fail(`${name} exists`, `not found in ${FILE}`)
    continue
  }
  const isAsync = (found.modifiers || []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  if (isAsync) fail(`${name} is synchronous`, 'it is called once per chip, cell and listener')
  else ok(`${name} is synchronous`)
}

if (failures > 0) {
  console.error(`\n[variable-lookup-io] FAILED: ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[variable-lookup-io] OK: variable lookups do not read vars.json')
