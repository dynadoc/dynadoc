/**
 * Gate: a spreadsheet reference while its sheet is loading.
 *
 * sheetRefLoading.utils.ts decides when a reference stops waiting for its
 * sheet, whose answer wins when two requests race, and how often chips are
 * asked again. Wrong here means a chip stuck on "…", an error written over a
 * good value, or every chip re-rendered once per chip. The store, the timers
 * and the broadcast are injected, so each path is driven by hand.
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
const ok = (what) => console.log(`[sheet-ref-loading]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[sheet-ref-loading]   FAIL  ${what}\n                        ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The module has no imports on purpose, so esbuild can compile it alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'sheet-ref-loading-'))
const compiled = path.join(outDir, 'sheetRefLoading.utils.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/utils/sheetRefLoading.utils.ts'
    ),
    '--format=esm',
    `--outfile=${compiled}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[sheet-ref-loading] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const { createLiveSheetWaiter, createRequestTokens, createPendingRefBroadcast } = await import(
  `file://${compiled}`
)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// A svelte-style store of open sheets, and timers fired by hand.
function harness() {
  let snapshot = {}
  const runs = new Set()
  const timers = new Map()
  let nextTimer = 0
  const waiter = createLiveSheetWaiter({
    subscribe: (run) => {
      runs.add(run)
      run(snapshot)
      return () => runs.delete(run)
    },
    isLive: (snap, p) => !!snap[p],
    setTimer: (fn) => {
      nextTimer += 1
      timers.set(nextTimer, fn)
      return nextTimer
    },
    clearTimer: (id) => timers.delete(id)
  })
  return {
    waiter,
    open: (p) => {
      snapshot = { ...snapshot, [p]: true }
      runs.forEach((run) => run(snapshot))
    },
    fireTimers: () => [...timers.values()].forEach((fn) => fn()),
    subscribers: () => runs.size,
    timers: () => timers.size
  }
}

// --- waiting for a sheet to open --------------------------------------------
{
  const h = harness()
  h.open('/a.sheet')
  const live = await h.waiter('/a.sheet', 10000)
  await flush()
  check('an open sheet answers at once', [live, h.subscribers(), h.timers()], [true, 0, 0])
}
{
  const h = harness()
  const waiting = h.waiter('/b.sheet', 10000)
  h.open('/other.sheet')
  h.open('/b.sheet')
  const live = await waiting
  await flush()
  check('a sheet that opens later answers then', [live, h.subscribers(), h.timers()], [true, 0, 0])
}
{
  const h = harness()
  const waiting = h.waiter('/c.sheet', 10000)
  h.fireTimers()
  const live = await waiting
  await flush()
  h.open('/c.sheet') // too late: nobody listens any more
  check('the wait times out, then stops listening', [live, h.subscribers()], [false, 0])
}

// --- an older request does not overwrite a newer one ------------------------
{
  const tokens = createRequestTokens()
  const a = tokens.start('doc::A1')
  const b = tokens.start('doc::A1')
  const other = tokens.start('doc::B1')
  check(
    'only the latest request for a key is current',
    [
      tokens.isCurrent('doc::A1', a),
      tokens.isCurrent('doc::A1', b),
      tokens.isCurrent('doc::B1', other)
    ],
    [false, true, true]
  )
}
{
  // The store's request, reduced to its timing: wait for the sheet, then write
  // unless superseded. Request 1 (empty cell, sheet closed) waits; the file is
  // saved, the watcher starts request 2, which finds 42; request 1 then times
  // out and must leave 42 in place.
  const h = harness()
  const tokens = createRequestTokens()
  const cache = new Map()
  const notified = []
  const request = async (key, readValue) => {
    const token = tokens.start(key)
    cache.set(key, '#LOADING')
    let value = readValue()
    if (value == null && (await h.waiter('/closed.sheet', 10000))) value = readValue()
    if (!tokens.isCurrent(key, token)) return
    cache.set(key, value ?? '#REF_ERROR!')
    notified.push(cache.get(key))
  }
  const first = request('doc::A1', () => null)
  await request('doc::A1', () => 42)
  h.fireTimers()
  await first
  check('a timed-out request leaves the newer value', [cache.get('doc::A1'), notified], [42, [42]])
}
{
  const h = harness()
  const tokens = createRequestTokens()
  const cache = new Map()
  const request = async (key) => {
    const token = tokens.start(key)
    const live = await h.waiter('/missing.sheet', 10000)
    if (!tokens.isCurrent(key, token)) return
    cache.set(key, live ? 'value' : '#REF_ERROR!')
  }
  const only = request('doc::Z9')
  h.fireTimers()
  await only
  check('a sheet that never opens is still an error', cache.get('doc::Z9'), '#REF_ERROR!')
}

// --- chips are asked again once per name ------------------------------------
{
  const asked = []
  let waits = 0
  let release
  const loaded = new Promise((resolve) => (release = resolve))
  const askAgain = createPendingRefBroadcast((name) => asked.push(name))
  const whenLoaded = () => {
    waits += 1
    return loaded
  }
  // Ten chips, three references, all asking while the sheets load.
  for (let i = 0; i < 10; i++) askAgain('doc1', ['s!A1', 's!A2', 's!B1:B3'][i % 3], whenLoaded)
  askAgain('doc2', 's!A1', () => Promise.resolve())
  check(
    'nothing is asked before the sheets are loaded',
    asked.filter((n) => n !== 's!A1').length,
    0
  )
  release()
  await flush()
  check(
    'each name once, one wait per document',
    [asked.slice().sort(), waits],
    [['s!A1', 's!A1', 's!A2', 's!B1:B3'], 1]
  )
  askAgain('doc1', 's!A1', whenLoaded)
  await flush()
  check('a later load waits again', [waits, asked.length], [2, 5])
}
{
  const asked = []
  const askAgain = createPendingRefBroadcast((name) => asked.push(name))
  askAgain('doc', 'x!A1', () => Promise.reject(new Error('vars.json unreadable')))
  await flush()
  check('a failed load still asks again (the chip then shows the error)', asked, ['x!A1'])
}

rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n[sheet-ref-loading] FAILED — ${failures} check(s) did not hold.`)
  process.exit(1)
}
console.log('\n[sheet-ref-loading] OK — loading references wait, race and refresh as they should')
