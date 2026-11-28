/**
 * Gate: the Organization variable scope against the stub bridge's own
 * channels.
 *
 * organizationScope.core.ts reads the scope from the API bridge, keeps a
 * local copy for offline use, sends each write with the revision it was made
 * from, and keeps a conflict when the bridge refuses a stale write. Wrong here
 * means a teammate's value silently overwritten, a value lost offline, or a
 * copy shown as current when it is not.
 *
 * The bridge is tools/stub-bridge/org-variables.mjs, the code the stub runs
 * for the vars:org:* channels, so this also checks the stub's side of
 * docs/organization-variables.md. Only the network is simulated (on, off),
 * and each client is signed in as its own user, which the stub over HTTP
 * cannot do.
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
const ok = (what) => console.log(`[organization-variables]   ok    ${what}`)
const fail = (what, detail) => {
  failures++
  console.error(`[organization-variables]   FAIL  ${what}\n                             ${detail}`)
}
const check = (what, got, expected) => {
  if (JSON.stringify(got) === JSON.stringify(expected)) ok(what)
  else fail(what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// The core imports only its types: bundled alone.
const outDir = mkdtempSync(path.join(tmpdir(), 'organization-variables-'))
const compiled = path.join(outDir, 'organizationScope.core.mjs')
const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
const build = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/stores/scopes/organizationScope.core.ts'
    ),
    '--bundle',
    '--format=esm',
    `--outfile=${compiled}`
  ],
  { encoding: 'utf-8' }
)
if (build.status !== 0) {
  console.error(`[organization-variables] FAIL: could not compile\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}
const { createOrganizationScope, stableJson } = await import(`file://${compiled}`)

const displayCompiled = path.join(outDir, 'organizationDisplay.utils.mjs')
const displayBuild = spawnSync(
  esbuild,
  [
    path.join(
      repoRoot,
      'src/renderer/src/extensions/tiptap/CustomVarExtension/utils/organizationDisplay.utils.ts'
    ),
    '--bundle',
    '--format=esm',
    `--outfile=${displayCompiled}`
  ],
  { encoding: 'utf-8' }
)
if (displayBuild.status !== 0) {
  console.error(`[organization-variables] FAIL: could not compile the display helpers`)
  process.exit(1)
}
const { orgStatusLine, orgChangeLine } = await import(`file://${displayCompiled}`)
const { emptyOrgState, orgVariableChannels } = await import(
  path.join(repoRoot, 'tools/stub-bridge/org-variables.mjs')
)

/** The stub's channels over one shared state, a network switch and a call log. */
function stubBridge() {
  const net = { online: true, calls: [], state: emptyOrgState('acme'), clock: 0 }
  const channels = (who) =>
    orgVariableChannels({
      state: net.state,
      user: () => ({ id: who, name: who }),
      now: () => new Date(1_700_000_000_000 + ++net.clock * 1000).toISOString()
    })
  const api = (who) => {
    const send = (channel) => async (payload) => {
      if (!net.online) throw new TypeError('Failed to fetch')
      net.calls.push([channel, payload])
      // A round trip: JSON in, JSON out, as over HTTP.
      const answer = channels(who)[channel](JSON.parse(JSON.stringify(payload)))
      return JSON.parse(JSON.stringify(answer))
    }
    return {
      list: send('vars:org:list'),
      get: send('vars:org:get'),
      set: send('vars:org:set'),
      delete: send('vars:org:delete'),
      history: send('vars:org:history')
    }
  }
  const writes = (channel) => net.calls.filter(([name]) => name === channel).map(([, p]) => p)
  const value = (id) => net.state.variables[id]?.value?.value
  /** Someone else, writing directly. */
  const write = (id, val, who = 'carol') => {
    const base = net.state.variables[id]?.revision ?? null
    return channels(who)['vars:org:set']({ id, value: val, baseRevision: base })
  }
  return { net, api, writes, value, write }
}

/** One copy per identity, like the app's localStorage keys. */
function memoryCache() {
  const copies = new Map()
  const clone = (value) => (value ? JSON.parse(JSON.stringify(value)) : null)
  return {
    read: (identity) => clone(copies.get(identity)),
    write: (identity, next) => copies.set(identity, clone(next)),
    peek: (identity = 'alice@acme') => copies.get(identity) || null
  }
}

const v = (value, extra = {}) => ({
  name: 'client',
  type: 'text',
  value,
  visibility: 'organization',
  ...extra
})

function scopeFor(
  bridge,
  who,
  cache = memoryCache(),
  clock = { t: 1_000_000 },
  identity = `${who}@acme`
) {
  const changes = []
  const scope = createOrganizationScope({
    bridge: () => bridge.api(who),
    cache,
    now: () => clock.t,
    staleAfterMs: 60_000,
    firstLoadTimeoutMs: 50,
    flushDelayMs: 0
  })
  scope.onChange((batch) => changes.push(...batch))
  scope.setIdentity(identity)
  return { scope, changes, cache, clock }
}

// --- key order does not make two values different -------------------------
check(
  'stable JSON ignores key order',
  stableJson({ b: 1, a: { d: 2, c: 3 } }),
  stableJson({ a: { c: 3, d: 2 }, b: 1 })
)

// --- what the UI says about the copy -------------------------------------
{
  const at = (state, extra = {}) => ({
    state,
    syncedAt: 5,
    pending: 0,
    conflicts: 0,
    org: 'acme',
    lastWriteError: null,
    ...extra
  })
  const time = () => 'T'
  check('fresh: nothing to say', orgStatusLine(at('fresh'), time), null)
  check(
    'stale and offline say since when',
    [orgStatusLine(at('stale'), time)?.values, orgStatusLine(at('offline'), time)?.key.slice(0, 8)],
    [{ time: 'T' }, 'Offline:']
  )
  check('a refused change says so', orgStatusLine(at('fresh', { conflicts: 2 }), time)?.values, {
    count: 2
  })
  const line = orgChangeLine(
    {
      updatedAt: '2026-11-28T08:01:00Z',
      updatedBy: { name: 'Jane' },
      previous: { value: { value: 'ACME SARL' } }
    },
    () => 'when'
  )
  check(
    'who changed it, when, and the value before',
    [line.key, line.values, line.previous],
    ['Changed by {name} on {time}', { name: 'Jane', time: 'when' }, 'ACME SARL']
  )
}

// --- one person writes, the other reads ------------------------------------
{
  const bridge = stubBridge()
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  await alice.scope.load()
  await bob.scope.load()
  check('an empty organization lists nothing', alice.scope.list(), {})
  check('an empty organization is fresh', alice.scope.status().state, 'fresh')
  check('the organization is the one the bridge names', alice.scope.status().org, 'acme')

  alice.scope.set('c1', v('ACME SARL', { documentId: 'doc-1', nodeId: 'n1' }))
  check('a local write shows at once', alice.scope.list().c1?.value, 'ACME SARL')
  check('a local write is pending until sent', alice.scope.status().pending, 1)
  await alice.scope.flush()
  check(
    'the write went out as a creation, without document-only fields',
    bridge.writes('vars:org:set').map((p) => [p.id, p.baseRevision, 'documentId' in p.value]),
    [['c1', null, false]]
  )
  check('nothing pending once the bridge accepted it', alice.scope.status().pending, 0)
  check(
    'who wrote it, at which revision',
    [alice.scope.meta('c1')?.revision, alice.scope.meta('c1')?.updatedBy?.name],
    [1, 'alice']
  )
  check('the local write is not reported back as a remote change', alice.changes, [])

  await bob.scope.refresh()
  check('the other person sees the value', bob.scope.list().c1?.value, 'ACME SARL')
  check(
    'and is told it changed',
    bob.changes.map((c) => [c.id, c.value?.value]),
    [['c1', 'ACME SARL']]
  )
  check(
    'the next read asks only for what changed',
    bridge.net.calls.filter(([name]) => name === 'vars:org:list').at(-1)[1],
    { since: 0 }
  )

  alice.scope.set('c1', v('ACME Group'))
  await alice.scope.flush()
  check(
    'the second write is based on revision 1',
    bridge.writes('vars:org:set').at(-1).baseRevision,
    1
  )
  await bob.scope.refresh()
  check('the change reaches the other person', bob.scope.list().c1?.value, 'ACME Group')
  check(
    'the previous value travels with it',
    bob.scope.meta('c1')?.previous?.value?.value,
    'ACME SARL'
  )
  check(
    'created by, then updated by',
    [bob.scope.meta('c1')?.createdBy?.name, bob.scope.meta('c1')?.updatedBy?.name],
    ['alice', 'alice']
  )

  // A deletion is a revision too, sent to those who read with `since`.
  alice.scope.remove('c1')
  await alice.scope.flush()
  check(
    'the deletion is based on revision 2',
    bridge.writes('vars:org:delete').map((p) => p.baseRevision),
    [2]
  )
  await bob.scope.refresh()
  check('a deletion reaches the other person', bob.scope.list().c1, undefined)
  check('as a change to null', bob.changes.at(-1), { id: 'c1', value: null })
  const history = await bob.scope.history('c1')
  check(
    'history, newest first, the deletion included',
    history.map((h) => [h.revision, h.value?.value ?? null]),
    [
      [3, null],
      [2, 'ACME Group'],
      [1, 'ACME SARL']
    ]
  )
}

// --- a stale write is refused and kept as a conflict -----------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  await alice.scope.load()
  await bob.scope.load()

  bob.scope.set('c1', v('bob'))
  await bob.scope.flush()
  alice.scope.set('c1', v('alice'))
  await alice.scope.flush()
  check('the bridge refused the stale write: one conflict', alice.scope.conflicts().length, 1)
  const [conflict] = alice.scope.conflicts()
  check(
    'the conflict holds both sides, and who wrote theirs',
    [conflict.mine?.value, conflict.theirs?.value?.value, conflict.theirs?.updatedBy?.name],
    ['alice', 'bob', 'bob']
  )
  check('the local value stays shown until the user picks', alice.scope.list().c1?.value, 'alice')
  check('the bridge kept the other value', bridge.value('c1'), 'bob')
  check('the status counts it', alice.scope.status().conflicts, 1)

  await alice.scope.resolveConflict('c1', 'mine')
  check(
    'keep mine: written over theirs, from their revision',
    bridge.writes('vars:org:set').at(-1).baseRevision,
    2
  )
  check('keep mine: the bridge holds mine', bridge.value('c1'), 'alice')
  check('keep mine: no conflict left', alice.scope.conflicts().length, 0)

  bob.scope.set('c1', v('bob again'))
  await bob.scope.flush()
  check('the other side now has a conflict', bob.scope.conflicts().length, 1)
  await bob.scope.resolveConflict('c1', 'theirs')
  check('keep theirs: the bridge value is shown', bob.scope.list().c1?.value, 'alice')
  check('keep theirs: and reported as a change', bob.changes.at(-1)?.value?.value, 'alice')
  check('keep theirs: nothing sent', bridge.net.state.revision, 3)
}

// --- a deletion against a newer value is a conflict too --------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const alice = scopeFor(bridge, 'alice')
  await alice.scope.load()
  bridge.write('c1', v('v2'), 'bob')
  alice.scope.remove('c1')
  await alice.scope.flush()
  check(
    'deleting a value someone changed: a conflict, the value kept',
    [alice.scope.conflicts().map((c) => [c.mine, c.theirs?.value?.value]), bridge.value('c1')],
    [[[null, 'v2']], 'v2']
  )
}

// --- the same change on both sides is not a conflict -----------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const alice = scopeFor(bridge, 'alice')
  await alice.scope.load()
  bridge.write('c1', v('same'), 'bob')
  // From a document: the value carries the document's own fields.
  alice.scope.set('c1', v('same', { documentId: 'doc-1', nodeId: 'n1', row: 0, col: 1 }))
  await alice.scope.flush()
  check('the same value on both sides: no conflict', alice.scope.conflicts().length, 0)
  const before = bridge.net.state.revision
  alice.scope.set('c1', v('same', { documentId: 'doc-2' }))
  await alice.scope.flush()
  check(
    'saving an unchanged value from a document writes nothing',
    bridge.net.state.revision,
    before
  )
}

// --- offline: the cache serves, writes wait, the status says so ------------
{
  const bridge = stubBridge()
  const cache = memoryCache()
  const clock = { t: 1_000_000 }
  bridge.write('c1', v('v1'))
  const first = scopeFor(bridge, 'alice', cache, clock)
  await first.scope.load()
  check('the copy is cached', Object.keys(cache.peek().records), ['c1'])

  bridge.net.online = false
  clock.t += 5_000
  const second = scopeFor(bridge, 'alice', cache, clock)
  await second.scope.load()
  check('offline, the cached value is served', second.scope.list().c1?.value, 'v1')
  check('offline, the status says so', second.scope.status().state, 'offline')
  check('offline, the copy says when it was read', second.scope.status().syncedAt, 1_000_000)

  second.scope.set('c1', v('offline edit'))
  await second.scope.flush()
  check('offline, the write waits', second.scope.status().pending, 1)
  check('and is kept in the cache with its base', cache.peek().pending.c1?.baseRevision, 1)

  // The page is reloaded while still offline: the pending write survives.
  const third = scopeFor(bridge, 'alice', cache, clock)
  await third.scope.load()
  check('a reload keeps the pending write', third.scope.list().c1?.value, 'offline edit')

  bridge.net.online = true
  await third.scope.refresh()
  check('back online, the write is sent', bridge.value('c1'), 'offline edit')
  check(
    'back online, the status is fresh',
    [third.scope.status().state, third.scope.status().pending],
    ['fresh', 0]
  )

  clock.t += 61_000
  check('an old copy is stale even with the bridge up', third.scope.status().state, 'stale')
}

// --- two people offline: the first to come back wins, the second decides ---
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  await alice.scope.load()
  await bob.scope.load()
  bridge.net.online = false
  alice.scope.set('c1', v('alice offline'))
  bob.scope.set('c1', v('bob offline'))
  await alice.scope.flush()
  await bob.scope.flush()
  bridge.net.online = true
  await bob.scope.refresh()
  await alice.scope.refresh()
  check('the first back online wins', bridge.value('c1'), 'bob offline')
  check(
    'the second gets a conflict, not a silent overwrite',
    alice.scope.conflicts().map((c) => [c.mine?.value, c.theirs?.value?.value]),
    [['alice offline', 'bob offline']]
  )
}

// --- a bridge that does not serve the scope --------------------------------
{
  const refused = async () => ({
    status: 400,
    body: { error: '[dynadoc local stub] channel "vars:org:list" is not implemented.' }
  })
  const scope = createOrganizationScope({
    bridge: () => ({
      list: refused,
      get: refused,
      set: refused,
      delete: refused,
      history: refused
    }),
    firstLoadTimeoutMs: 50
  })
  scope.setIdentity('alice@acme')
  await scope.load()
  check('a bridge without the channels: unavailable', scope.status().state, 'unavailable')
  const none = createOrganizationScope({ bridge: () => null, firstLoadTimeoutMs: 50 })
  none.setIdentity('alice@acme')
  await none.load()
  check('no bridge at all: unavailable', none.status().state, 'unavailable')
}

// --- a write refused for good is dropped and the bridge value shown --------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  bridge.write('c2', v('v2', { name: 'ville' }))
  const alice = scopeFor(bridge, 'alice')
  await alice.scope.load()
  alice.scope.set('c2', v('taken', { name: 'client' }))
  await alice.scope.flush()
  check(
    'a name another organization variable has: refused, dropped',
    [alice.scope.status().pending, alice.scope.list().c2?.value, alice.scope.list().c2?.name],
    [0, 'v2', 'ville']
  )
  check('and says why', alice.scope.status().lastWriteError?.error, 'name_taken')
  check('the bridge value is shown again', alice.changes.at(-1)?.value?.value, 'v2')
}

// --- the copy belongs to one identity --------------------------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const cache = memoryCache()
  const alice = scopeFor(bridge, 'alice', cache)
  await alice.scope.load()
  bridge.net.online = false
  alice.scope.set('c1', v('alice offline'))
  await alice.scope.flush()

  // A token renewal is not a change of identity: nothing is lost.
  alice.scope.setIdentity('alice@acme')
  check('the same identity again keeps the pending write', alice.scope.status().pending, 1)

  // Bob signs in on the same machine, same organization.
  alice.scope.setIdentity('bob@acme')
  check(
    "another user: none of the previous user's values or writes",
    [alice.scope.list(), alice.scope.status().pending],
    [{}, 0]
  )
  check('and they are reported as gone', alice.changes.at(-1), { id: 'c1', value: null })
  bridge.net.online = true
  await alice.scope.refresh()
  check("the previous user's write is not sent with this session", bridge.value('c1'), 'v1')

  // Alice again: her copy and her queued write are back, and go out as hers.
  alice.scope.setIdentity('alice@acme')
  check(
    'back to the first user: her pending write is back',
    alice.scope.list().c1?.value,
    'alice offline'
  )
  await alice.scope.refresh()
  check('and is sent', bridge.value('c1'), 'alice offline')

  // Signed out: nothing shown.
  alice.scope.setIdentity(null)
  check(
    'signed out: nothing shown, unavailable',
    [alice.scope.list(), alice.scope.status().state],
    [{}, 'unavailable']
  )

  // Before the identity is known nothing of the cache is shown.
  const early = createOrganizationScope({
    bridge: () => bridge.api('alice'),
    cache,
    firstLoadTimeoutMs: 50
  })
  check('identity not known yet: nothing shown', early.list(), {})
}

// --- the bridge answers for another organization than the cached one -------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const cache = memoryCache()
  const first = scopeFor(bridge, 'alice', cache)
  await first.scope.load()
  bridge.net.online = false
  first.scope.set('c1', v('queued in acme'))
  await first.scope.flush()
  bridge.net.online = true
  bridge.net.state = emptyOrgState('other')
  const second = scopeFor(bridge, 'alice', cache)
  await second.scope.refresh()
  check(
    'another organization: the cached variables are dropped',
    [second.scope.list(), second.scope.status().org],
    [{}, 'other']
  )
  check(
    'and the write made in the first one is not sent to it',
    bridge.net.calls.filter(([c]) => c === 'vars:org:set').length,
    0
  )
}

// --- not a member any more: the copy is dropped -----------------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const api = bridge.api('alice')
  let member = true
  const scope = createOrganizationScope({
    bridge: () => ({
      ...api,
      list: async (p) => (member ? api.list(p) : { status: 403, body: { error: 'forbidden' } })
    }),
    firstLoadTimeoutMs: 50
  })
  scope.setIdentity('alice@acme')
  await scope.load()
  member = false
  await scope.refresh()
  check(
    '403 on list: nothing kept, unavailable',
    [scope.list(), scope.status().state],
    [{}, 'unavailable']
  )
}

// --- an open conflict is decided against what the bridge holds now ---------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const alice = scopeFor(bridge, 'alice')
  await alice.scope.load()
  bridge.write('c1', v('v2'), 'bob')
  alice.scope.set('c1', v('alice'))
  await alice.scope.flush()
  bridge.write('c1', v('v3'), 'bob')
  await alice.scope.refresh()
  check(
    'a newer value reaches the open conflict',
    alice.scope.conflicts()[0]?.theirs?.value?.value,
    'v3'
  )
  await alice.scope.resolveConflict('c1', 'mine')
  check(
    'keep mine then goes through at once',
    [bridge.value('c1'), alice.scope.conflicts().length],
    ['alice', 0]
  )
}

// --- two windows share the offline queue -----------------------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  bridge.write('c2', v('w1', { name: 'ville' }))
  const cache = memoryCache()
  const one = scopeFor(bridge, 'alice', cache)
  const two = scopeFor(bridge, 'alice', cache)
  await one.scope.load()
  await two.scope.load()
  bridge.net.online = false
  one.scope.set('c1', v('from one'))
  two.scope.set('c2', v('from two', { name: 'ville' }))
  await one.scope.flush()
  await two.scope.flush()
  check(
    "neither window drops the other one's queued write",
    Object.keys(cache.peek().pending).sort(),
    ['c1', 'c2']
  )
}

// --- a refused deletion does not bring the value back -----------------------
{
  const bridge = stubBridge()
  bridge.write('c1', v('v1'))
  const api = bridge.api('alice')
  const changes = []
  const scope = createOrganizationScope({
    bridge: () => ({
      ...api,
      delete: async () => ({ status: 403, body: { error: 'forbidden', message: 'read only' } })
    }),
    firstLoadTimeoutMs: 50,
    flushDelayMs: 0
  })
  scope.onChange((batch) => changes.push(...batch))
  scope.setIdentity('alice@acme')
  await scope.load()
  changes.length = 0
  scope.remove('c1')
  await scope.flush()
  check('a refused deletion: nothing redefined over the local copy', changes, [])
}

// --- the same channels over HTTP, from the running stub --------------------
{
  const { spawn } = await import('node:child_process')
  const port = 17_000 + Math.floor(Math.random() * 2000)
  const root = path.join(outDir, 'drive')
  const stub = spawn(process.execPath, [path.join(repoRoot, 'tools/stub-bridge/server.mjs')], {
    env: { ...process.env, DYNADOC_STUB_ROOT: root, DYNADOC_STUB_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the stub did not start')), 10_000)
    stub.stderr.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const invoke = async (channel, payload) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ipc/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args: [payload] })
    })
    return { status: res.status, body: await res.json() }
  }
  try {
    const created = await invoke('vars:org:set', { id: 'h1', value: v('A'), baseRevision: null })
    check(
      'HTTP: a creation answers ok with the stored variable',
      [
        created.status,
        created.body.ok,
        created.body.data?.revision,
        created.body.data?.updatedBy?.id
      ],
      [200, true, 1, 'local-stub']
    )
    const stale = await invoke('vars:org:set', { id: 'h1', value: v('B'), baseRevision: null })
    check(
      'HTTP: a stale write is a 409 with the current variable',
      [stale.status, stale.body.error, stale.body.current?.value?.value],
      [409, 'conflict', 'A']
    )
    const listed = await invoke('vars:org:list', { since: 0 })
    check(
      'HTTP: the list carries the organization and its revision',
      [listed.body.data?.org, listed.body.data?.revision, listed.body.data?.variables?.length],
      ['local-stub', 1, 1]
    )
  } finally {
    stub.kill()
  }
}

rmSync(outDir, { recursive: true, force: true })
if (failures) {
  console.error(`\n[organization-variables] FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[organization-variables] OK: revisions, conflicts, offline copy and status behave')
