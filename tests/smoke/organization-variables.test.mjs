/**
 * Gate: the Organization variable scope against a bridge driven by hand.
 *
 * organizationScope.core.ts reads the scope from the API bridge, keeps a
 * local copy for offline use, sends each write with the version it was made
 * from, and keeps a conflict when the bridge refuses a stale write. Wrong here
 * means a teammate's value silently overwritten, a value lost offline, or a
 * copy shown as current when it is not. The bridge, the cache and the clock
 * are injected; the bridge below follows docs/organization-variables.md.
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

/**
 * A bridge in memory, by the contract: versions per variable, one revision
 * per organization, `since`, 409 with `current` on a stale base version.
 */
function memoryBridge() {
  const state = { revision: 0, records: new Map(), online: true, calls: [] }
  const user = (who) => ({ id: who, name: who })
  const write = (id, baseVersion, value, who) => {
    const current = state.records.get(id) || null
    if ((current?.version ?? 0) !== baseVersion) {
      return { status: 409, body: { error: 'version_conflict', current } }
    }
    state.revision++
    const record = {
      id,
      version: (current?.version ?? 0) + 1,
      revision: state.revision,
      value,
      updatedAt: new Date(1_700_000_000_000 + state.revision * 1000).toISOString(),
      updatedBy: user(who),
      previous: current
        ? {
            version: current.version,
            value: current.value,
            updatedAt: current.updatedAt,
            updatedBy: current.updatedBy
          }
        : null
    }
    state.records.set(id, record)
    return { status: 200, body: { revision: state.revision, variable: record } }
  }
  const reach = async (fn) => {
    if (!state.online) throw new TypeError('Failed to fetch')
    return fn()
  }
  const api = (who) => ({
    list: (payload) =>
      reach(() => {
        state.calls.push(['list', payload?.since ?? null])
        const since = payload?.since
        const variables = [...state.records.values()].filter((record) =>
          since === undefined ? record.value !== null : record.revision > since
        )
        return { status: 200, body: { revision: state.revision, variables } }
      }),
    put: ({ id, baseVersion, value }) =>
      reach(() => {
        state.calls.push(['put', id, baseVersion])
        return write(id, baseVersion, value, who)
      }),
    remove: ({ id, baseVersion }) =>
      reach(() => {
        state.calls.push(['remove', id, baseVersion])
        return write(id, baseVersion, null, who)
      }),
    history: ({ id }) =>
      reach(() => {
        const record = state.records.get(id)
        if (!record) return { status: 404, body: { error: 'not_found' } }
        const history = [record]
        if (record.previous) history.push({ ...record.previous, id, revision: 0, previous: null })
        return { status: 200, body: { history } }
      })
  })
  return { state, api, write }
}

function memoryCache() {
  let snapshot = null
  return {
    read: () => (snapshot ? JSON.parse(JSON.stringify(snapshot)) : null),
    write: (next) => {
      snapshot = next ? JSON.parse(JSON.stringify(next)) : null
    },
    peek: () => snapshot
  }
}

const v = (value, extra = {}) => ({
  name: 'client',
  type: 'text',
  value,
  visibility: 'organization',
  ...extra
})

function scopeFor(bridge, who, cache = memoryCache(), clock = { t: 1_000_000 }) {
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
  return { scope, changes, cache, clock }
}

// --- key order does not make two values different -------------------------
check(
  'stable JSON ignores key order',
  stableJson({ b: 1, a: { d: 2, c: 3 } }),
  stableJson({ a: { c: 3, d: 2 }, b: 1 })
)

// --- one person writes, the other reads ------------------------------------
{
  const bridge = memoryBridge()
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  await alice.scope.load()
  await bob.scope.load()
  check('an empty organization lists nothing', alice.scope.list(), {})
  check('an empty organization is live', alice.scope.status().state, 'live')

  alice.scope.set('c1', v('ACME SARL'))
  check('a local write shows at once', alice.scope.list().c1?.value, 'ACME SARL')
  check('a local write is pending until sent', alice.scope.status().pending, 1)
  await alice.scope.flush()
  check(
    'the write went out from version 0',
    bridge.state.calls.filter((c) => c[0] === 'put'),
    [['put', 'c1', 0]]
  )
  check('nothing pending once the bridge accepted it', alice.scope.status().pending, 0)
  check(
    'who wrote it and when',
    [alice.scope.meta('c1')?.version, alice.scope.meta('c1')?.updatedBy?.name],
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
    bridge.state.calls.filter((c) => c[0] === 'list').at(-1),
    ['list', 0]
  )

  alice.scope.set('c1', v('ACME Group'))
  await alice.scope.flush()
  check(
    'the second write is based on version 1',
    bridge.state.calls.filter((c) => c[0] === 'put').at(-1),
    ['put', 'c1', 1]
  )
  await bob.scope.refresh()
  check('the change reaches the other person', bob.scope.list().c1?.value, 'ACME Group')
  check(
    'the previous value travels with it',
    bob.scope.meta('c1')?.previous?.value?.value,
    'ACME SARL'
  )
  const history = await bob.scope.history('c1')
  check(
    'history, newest first',
    history.map((h) => h.value?.value),
    ['ACME Group', 'ACME SARL']
  )

  // A deletion is a version too.
  alice.scope.remove('c1')
  await alice.scope.flush()
  await bob.scope.refresh()
  check('a deletion reaches the other person', bob.scope.list().c1, undefined)
  check('as a change to null', bob.changes.at(-1), { id: 'c1', value: null })
}

// --- a stale write is refused and kept as a conflict -----------------------
{
  const bridge = memoryBridge()
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  bridge.write('c1', 0, v('v1'), 'carol')
  await alice.scope.load()
  await bob.scope.load()

  bob.scope.set('c1', v('bob'))
  await bob.scope.flush()
  alice.scope.set('c1', v('alice'))
  await alice.scope.flush()
  check('the bridge refused the stale write: one conflict', alice.scope.conflicts().length, 1)
  const [conflict] = alice.scope.conflicts()
  check(
    'the conflict holds both sides',
    [conflict.mine?.value, conflict.theirs?.value?.value, conflict.theirs?.updatedBy?.name],
    ['alice', 'bob', 'bob']
  )
  check('the local value stays shown until the user picks', alice.scope.list().c1?.value, 'alice')
  check('the bridge kept the other value', bridge.state.records.get('c1').value.value, 'bob')
  check('the status counts it', alice.scope.status().conflicts, 1)

  await alice.scope.resolveConflict('c1', 'mine')
  check(
    'keep mine: written over theirs, from their version',
    bridge.state.calls.filter((c) => c[0] === 'put').at(-1),
    ['put', 'c1', 2]
  )
  check('keep mine: the bridge holds mine', bridge.state.records.get('c1').value.value, 'alice')
  check('keep mine: no conflict left', alice.scope.conflicts().length, 0)

  bob.scope.set('c1', v('bob again'))
  await bob.scope.flush()
  check('the other side now has a conflict', bob.scope.conflicts().length, 1)
  await bob.scope.resolveConflict('c1', 'theirs')
  check('keep theirs: the bridge value is shown', bob.scope.list().c1?.value, 'alice')
  check('keep theirs: and reported as a change', bob.changes.at(-1)?.value?.value, 'alice')
  check('keep theirs: nothing sent', bridge.state.records.get('c1').version, 3)
}

// --- the same change on both sides is not a conflict -----------------------
{
  const bridge = memoryBridge()
  const alice = scopeFor(bridge, 'alice')
  bridge.write('c1', 0, v('v1'), 'carol')
  await alice.scope.load()
  bridge.write('c1', 1, v('same'), 'bob')
  alice.scope.set('c1', v('same'))
  await alice.scope.flush()
  check('the same value on both sides: no conflict', alice.scope.conflicts().length, 0)
}

// --- offline: the cache serves, writes wait, the status says stale ---------
{
  const bridge = memoryBridge()
  const cache = memoryCache()
  const clock = { t: 1_000_000 }
  const first = scopeFor(bridge, 'alice', cache, clock)
  bridge.write('c1', 0, v('v1'), 'carol')
  await first.scope.load()
  check('the copy is cached', Object.keys(cache.peek().records), ['c1'])

  bridge.state.online = false
  clock.t += 5_000
  const second = scopeFor(bridge, 'alice', cache, clock)
  await second.scope.load()
  check('offline, the cached value is served', second.scope.list().c1?.value, 'v1')
  check(
    'offline, the status is stale, and says why',
    [second.scope.status().state, second.scope.status().reason],
    ['stale', 'offline']
  )
  check('offline, the copy says when it was read', second.scope.status().syncedAt, 1_000_000)

  second.scope.set('c1', v('offline edit'))
  await second.scope.flush()
  check('offline, the write waits', second.scope.status().pending, 1)
  check('and is kept in the cache', cache.peek().pending.c1?.baseVersion, 1)

  // The page is reloaded while still offline: the pending write survives.
  const third = scopeFor(bridge, 'alice', cache, clock)
  await third.scope.load()
  check('a reload keeps the pending write', third.scope.list().c1?.value, 'offline edit')

  bridge.state.online = true
  await third.scope.refresh()
  check(
    'back online, the write is sent',
    bridge.state.records.get('c1').value.value,
    'offline edit'
  )
  check(
    'back online, the status is live',
    [third.scope.status().state, third.scope.status().pending],
    ['live', 0]
  )

  clock.t += 61_000
  check('an old copy is stale even with the bridge up', third.scope.status().state, 'stale')
}

// --- two people offline: the first to come back wins, the second decides ---
{
  const bridge = memoryBridge()
  bridge.write('c1', 0, v('v1'), 'carol')
  const alice = scopeFor(bridge, 'alice')
  const bob = scopeFor(bridge, 'bob')
  await alice.scope.load()
  await bob.scope.load()
  bridge.state.online = false
  alice.scope.set('c1', v('alice offline'))
  bob.scope.set('c1', v('bob offline'))
  await alice.scope.flush()
  await bob.scope.flush()
  bridge.state.online = true
  await bob.scope.refresh()
  await alice.scope.refresh()
  check('the first back online wins', bridge.state.records.get('c1').value.value, 'bob offline')
  check(
    'the second gets a conflict, not a silent overwrite',
    alice.scope.conflicts().map((c) => [c.mine?.value, c.theirs?.value?.value]),
    [['alice offline', 'bob offline']]
  )
}

// --- a bridge that does not serve the scope --------------------------------
{
  const scope = createOrganizationScope({
    bridge: () => ({
      list: async () => ({ status: 404, body: { error: '[dynadoc local stub] not implemented' } }),
      put: async () => ({ status: 404, body: {} }),
      remove: async () => ({ status: 404, body: {} }),
      history: async () => ({ status: 404, body: {} })
    }),
    firstLoadTimeoutMs: 50
  })
  await scope.load()
  check('a bridge without the endpoints: unavailable', scope.status().state, 'unavailable')
  const none = createOrganizationScope({ bridge: () => null, firstLoadTimeoutMs: 50 })
  await none.load()
  check('no bridge at all: unavailable', none.status().state, 'unavailable')
}

// --- a write refused for good is dropped and the bridge value shown --------
{
  const bridge = memoryBridge()
  bridge.write('c1', 0, v('v1'), 'carol')
  const api = bridge.api('alice')
  const changes = []
  const scope = createOrganizationScope({
    bridge: () => ({
      ...api,
      put: async () => ({ status: 403, body: { error: 'forbidden', message: 'read only' } })
    }),
    firstLoadTimeoutMs: 50,
    flushDelayMs: 0
  })
  scope.onChange((batch) => changes.push(...batch))
  await scope.load()
  scope.set('c1', v('nope'))
  await scope.flush()
  check('a forbidden write is dropped', [scope.status().pending, scope.list().c1?.value], [0, 'v1'])
  check('and says why', scope.status().lastWriteError?.message, 'read only')
  check('the bridge value is shown again', changes.at(-1)?.value?.value, 'v1')
}

// --- another account: nothing of the previous one is kept ------------------
{
  const bridge = memoryBridge()
  bridge.write('c1', 0, v('v1'), 'carol')
  const { scope, changes, cache } = scopeFor(bridge, 'alice')
  await scope.load()
  scope.reset()
  check('reset empties the scope and the cache', [scope.list(), cache.peek()], [{}, null])
  check('reset reports the variables as gone', changes.at(-1), { id: 'c1', value: null })
}

rmSync(outDir, { recursive: true, force: true })
if (failures) {
  console.error(`\n[organization-variables] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[organization-variables] OK — versions, conflicts, offline copy and status behave')
