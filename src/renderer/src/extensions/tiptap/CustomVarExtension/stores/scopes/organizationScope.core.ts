// The Organization scope: variables shared by everyone in the organization,
// read from and written to the API bridge. Contract:
// docs/organization-variables.md.
//
// - The bridge keeps one revision counter per organization; each write gets
//   the next one. A write names the revision it was made from
//   (`baseRevision`, null to create); the bridge refuses it with 409 when the
//   variable has been written since, and the client keeps both sides as a
//   conflict until the user picks one. Nothing is overwritten silently.
// - What the bridge last answered is kept in a cache, so the scope still has
//   its values offline. Changes made offline wait in the cache too and are
//   sent when the bridge answers again; the revision rule above decides
//   between two people who changed the same variable offline.
// - The status says how current the copy is: fresh, stale (older than
//   `staleAfterMs`, or the last read was refused), offline (the bridge could
//   not be reached) or unavailable (the bridge does not serve the scope).
//
// The bridge, the cache and the clock are injected, so the smoke test drives
// every path by hand. Wiring for the app: organizationScope.ts.
import type { ScopeChange, ScopeStatus, StoredVariable, VariableScopeDriver } from './types'

export type OrgUser = { id?: string; name?: string; email?: string }

/** One revision of an organization variable; `value: null` is a deletion. */
export type OrgVersion = {
  revision: number
  value: StoredVariable | null
  updatedAt: string
  updatedBy: OrgUser | null
}

export type OrgVariableRecord = OrgVersion & {
  id: string
  createdAt: string
  createdBy: OrgUser | null
  /** The revision before this one, or null for the first. */
  previous: OrgVersion | null
  /** False when this user may read the variable but not change it. */
  canWrite: boolean
}

/**
 * What a bridge call answered: the HTTP status (0: the bridge was not
 * reached) and, on success, the channel's `data`; otherwise the error body.
 */
export type BridgeResponse = {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the bridge, checked field by field
  body: any
}

/** The five `vars:org:*` channels. */
export interface OrgBridge {
  list(payload: { since?: number }): Promise<BridgeResponse>
  get(payload: { id: string }): Promise<BridgeResponse>
  set(payload: {
    id: string
    value: StoredVariable
    baseRevision: number | null
  }): Promise<BridgeResponse>
  delete(payload: { id: string; baseRevision: number }): Promise<BridgeResponse>
  history(payload: { id: string; limit?: number }): Promise<BridgeResponse>
}

type Pending = { value: StoredVariable | null; baseRevision: number | null }

/** A write the bridge refused: `theirs` is what it holds now (null: deleted). */
export type OrgConflict = {
  id: string
  mine: StoredVariable | null
  theirs: OrgVariableRecord | null
}

/** A write the bridge refused for another reason than a conflict. */
export type OrgWriteError = { id: string; status: number; error: string; message: string }

export type OrgCacheSnapshot = {
  org: string | null
  revision: number
  syncedAt: number | null
  records: Record<string, OrgVariableRecord>
  pending: Record<string, Pending>
  conflicts: Record<string, OrgConflict>
}

export interface OrgCache {
  read(): OrgCacheSnapshot | null
  write(snapshot: OrgCacheSnapshot | null): void
}

export type OrganizationScopeOptions = {
  bridge: () => OrgBridge | null
  cache?: OrgCache
  now?: () => number
  /** A copy older than this is shown as stale. */
  staleAfterMs?: number
  /** How long the first load waits for the bridge before using the cache. */
  firstLoadTimeoutMs?: number
  /** Writes made within this delay go out together. */
  flushDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type OrgStatus = ScopeStatus & {
  org: string | null
  lastWriteError: OrgWriteError | null
}

export interface OrganizationScope extends VariableScopeDriver {
  /** Reads what changed on the bridge since the last read, then sends pending writes. */
  refresh(): Promise<void>
  /** Sends pending writes now. */
  flush(): Promise<void>
  /** The revision this client holds: who changed it, when, and the value before. */
  meta(id: string): OrgVariableRecord | null
  /** Every revision the bridge keeps, newest first; null when it cannot say. */
  history(id: string, limit?: number): Promise<OrgVersion[] | null>
  conflicts(): OrgConflict[]
  /** `mine` writes the local value over theirs; `theirs` drops the local value. */
  resolveConflict(id: string, keep: 'mine' | 'theirs'): Promise<void>
  onStatus(fn: (status: OrgStatus) => void): () => void
  status(): OrgStatus
  /** Forgets everything, cache included (another account signed in). */
  reset(): void
}

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value as object)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

// Fields that only mean something inside one document; the contract leaves
// them out of an organization value.
const DOCUMENT_ONLY_FIELDS = ['documentId', 'nodeId', 'row', 'col', 'coord']

/** The value as the bridge stores it. */
export function toOrgValue(value: StoredVariable): StoredVariable {
  const out: StoredVariable = {}
  for (const [key, field] of Object.entries(value)) {
    if (!DOCUMENT_ONLY_FIELDS.includes(key) && field !== undefined) out[key] = field
  }
  return out
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function toUser(raw: unknown): OrgUser | null {
  if (!isObject(raw)) return null
  const user: OrgUser = {}
  if (typeof raw.id === 'string') user.id = raw.id
  if (typeof raw.name === 'string') user.name = raw.name
  if (typeof raw.email === 'string') user.email = raw.email
  return user
}

/** One revision from the bridge, or null when it does not have the contract's shape. */
export function toVersion(raw: unknown): OrgVersion | null {
  if (!isObject(raw) || !Number.isInteger(raw.revision)) return null
  return {
    revision: raw.revision as number,
    value: raw.deleted === true ? null : isObject(raw.value) ? (raw.value as StoredVariable) : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: toUser(raw.updatedBy)
  }
}

/** A variable from the bridge, or null when it does not have the contract's shape. */
export function toRecord(raw: unknown): OrgVariableRecord | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const version = toVersion(raw)
  if (!version || !version.value) return null
  return {
    ...version,
    id: raw.id,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : version.updatedAt,
    createdBy: toUser(raw.createdBy) || version.updatedBy,
    previous: toVersion(raw.previous),
    canWrite: raw.canWrite !== false
  }
}

const errorCode = (response: BridgeResponse): string => String(response?.body?.error || '')

const errorMessage = (response: BridgeResponse): string =>
  String(response?.body?.message || response?.body?.error || `HTTP ${response?.status}`)

/** A bridge that does not know the channel: an older bridge, or a stub without it. */
const isUnknownChannel = (response: BridgeResponse): boolean =>
  response.status === 501 ||
  ((response.status === 400 || response.status === 404) &&
    /not implemented|unsupported channel|unknown channel/i.test(errorMessage(response)))

async function call(fn: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
  try {
    const response = await fn()
    return response && typeof response.status === 'number' ? response : { status: 0, body: null }
  } catch (err) {
    return {
      status: 0,
      body: { error: 'offline', message: String((err as Error)?.message || err) }
    }
  }
}

export function createOrganizationScope(options: OrganizationScopeOptions): OrganizationScope {
  const now = options.now || (() => Date.now())
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const firstLoadTimeoutMs = options.firstLoadTimeoutMs ?? 4_000
  const flushDelayMs = options.flushDelayMs ?? 250
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let org: string | null = null
  let records = new Map<string, OrgVariableRecord>()
  let pending = new Map<string, Pending>()
  let conflicts = new Map<string, OrgConflict>()
  let revision = 0
  let syncedAt: number | null = null
  let hasFullList = false
  let hydrated = false
  let unavailable = false
  let offline = false
  let reason: ScopeStatus['reason'] | undefined
  let lastWriteError: OrgWriteError | null = null
  let listCache: Record<string, StoredVariable> | null = null
  let loading: Promise<void> | null = null
  let refreshing: Promise<void> | null = null
  let flushing: Promise<void> | null = null
  let flushTimer: unknown = null

  const changeHandlers = new Set<(changes: ScopeChange[]) => void>()
  const statusHandlers = new Set<(status: OrgStatus) => void>()

  function hydrate(): void {
    if (hydrated) return
    hydrated = true
    let snapshot: OrgCacheSnapshot | null = null
    try {
      snapshot = options.cache?.read() || null
    } catch {
      snapshot = null
    }
    if (!snapshot) return
    for (const raw of Object.values(snapshot.records || {})) {
      const record = toRecord(raw)
      if (record) records.set(record.id, record)
    }
    for (const [id, entry] of Object.entries(snapshot.pending || {})) {
      if (entry && (entry.baseRevision === null || Number.isInteger(entry.baseRevision))) {
        pending.set(id, entry)
      }
    }
    for (const [id, entry] of Object.entries(snapshot.conflicts || {})) {
      if (entry) conflicts.set(id, { id, mine: entry.mine ?? null, theirs: toRecord(entry.theirs) })
    }
    org = typeof snapshot.org === 'string' ? snapshot.org : null
    revision = Number.isInteger(snapshot.revision) ? snapshot.revision : 0
    syncedAt = typeof snapshot.syncedAt === 'number' ? snapshot.syncedAt : null
    hasFullList = syncedAt !== null
    listCache = null
  }

  function persist(): void {
    try {
      options.cache?.write({
        org,
        revision,
        syncedAt,
        records: Object.fromEntries(records),
        pending: Object.fromEntries(pending),
        conflicts: Object.fromEntries(conflicts)
      })
    } catch {
      // A full or blocked storage: the scope still works, without its offline copy.
    }
  }

  function effective(id: string): StoredVariable | null {
    if (pending.has(id)) return pending.get(id)!.value
    if (conflicts.has(id)) return conflicts.get(id)!.mine
    return records.get(id)?.value ?? null
  }

  function status(): OrgStatus {
    const base = {
      org,
      syncedAt,
      pending: pending.size,
      conflicts: conflicts.size,
      lastWriteError
    }
    if (unavailable) return { ...base, state: 'unavailable', ...(reason ? { reason } : {}) }
    if (offline) return { ...base, state: 'offline' }
    if (reason) return { ...base, state: syncedAt ? 'stale' : 'loading', reason }
    if (syncedAt === null) return { ...base, state: 'loading' }
    if (now() - syncedAt > staleAfterMs) return { ...base, state: 'stale' }
    return { ...base, state: 'fresh' }
  }

  function notifyStatus(): void {
    const current = status()
    statusHandlers.forEach((fn) => {
      try {
        fn(current)
      } catch (err) {
        console.error('Organization variables status handler failed:', err)
      }
    })
  }

  function emit(changes: ScopeChange[]): void {
    if (!changes.length) return
    listCache = null
    changeHandlers.forEach((fn) => {
      try {
        fn(changes)
      } catch (err) {
        console.error('Organization variables change handler failed:', err)
      }
    })
  }

  // Updates records and reports the ids whose value, as this client shows
  // it, changed.
  function applyList(
    next: OrgVariableRecord[],
    deleted: { id: string; revision: number }[],
    full: boolean
  ): ScopeChange[] {
    const before = new Map<string, string>()
    const remember = (id: string): void => {
      if (!before.has(id)) before.set(id, stableJson(effective(id)))
    }
    if (full) {
      const ids = new Set(next.map((record) => record.id))
      for (const id of [...records.keys()]) {
        if (ids.has(id)) continue
        remember(id)
        records.delete(id)
      }
    }
    for (const { id, revision: at } of deleted) {
      const current = records.get(id)
      if (current && current.revision > at) continue
      remember(id)
      records.delete(id)
    }
    for (const record of next) {
      const current = records.get(record.id)
      if (current && current.revision > record.revision) continue
      remember(record.id)
      records.set(record.id, record)
    }
    listCache = null
    const changes: ScopeChange[] = []
    for (const [id, was] of before) {
      const value = effective(id)
      if (stableJson(value) !== was) changes.push({ id, value })
    }
    return changes
  }

  // Another organization than the cached one: nothing of it applies here.
  function forgetOrganization(): ScopeChange[] {
    const gone = Object.keys(listValues()).map((id) => ({ id, value: null }))
    records = new Map()
    pending = new Map()
    conflicts = new Map()
    revision = 0
    hasFullList = false
    listCache = null
    return gone
  }

  async function doRefresh(): Promise<void> {
    hydrate()
    const bridge = options.bridge()
    if (!bridge) {
      unavailable = true
      notifyStatus()
      return
    }
    let since = hasFullList ? revision : undefined
    let response = await call(() => bridge.list(since === undefined ? {} : { since }))
    let dropped: ScopeChange[] = []
    if (
      response.status === 200 &&
      typeof response.body?.org === 'string' &&
      org !== null &&
      response.body.org !== org
    ) {
      dropped = forgetOrganization()
      since = undefined
      response = await call(() => bridge.list({}))
    }
    if (response.status === 200 && Array.isArray(response.body?.variables)) {
      const list = (response.body.variables as unknown[])
        .map(toRecord)
        .filter((record): record is OrgVariableRecord => Boolean(record))
      const deleted = (Array.isArray(response.body.deleted) ? response.body.deleted : []).filter(
        (entry: unknown) =>
          isObject(entry) && typeof entry.id === 'string' && Number.isInteger(entry.revision)
      )
      // `full`: the bridge no longer keeps changes as far back as `since`
      // and sent everything instead.
      const full = since === undefined || response.body.full === true
      const changes = applyList(list, deleted, full)
      if (typeof response.body.org === 'string') org = response.body.org
      if (Number.isInteger(response.body.revision)) revision = response.body.revision
      hasFullList = true
      syncedAt = now()
      unavailable = false
      offline = false
      reason = undefined
      persist()
      emit([...dropped, ...changes])
      notifyStatus()
      if (pending.size) await flush()
      return
    }
    emit(dropped)
    if (isUnknownChannel(response)) unavailable = true
    else if (response.status === 401) {
      unavailable = true
      reason = 'unauthorized'
    } else if (response.status === 403) reason = 'unauthorized'
    else if (response.status === 0 || response.status >= 500) offline = true
    else reason = 'error'
    notifyStatus()
  }

  function refresh(): Promise<void> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return
    flushTimer = setTimer(() => {
      flushTimer = null
      void flush()
    }, flushDelayMs)
  }

  // One write. Returns false when the bridge cannot take writes now, so the
  // loop stops and the rest waits for the next refresh.
  async function send(bridge: OrgBridge, id: string, entry: Pending): Promise<boolean> {
    if (entry.value === null && entry.baseRevision === null) {
      // Created and deleted before the bridge heard of it.
      pending.delete(id)
      return true
    }
    const response = await call(() =>
      entry.value === null
        ? bridge.delete({ id, baseRevision: entry.baseRevision as number })
        : bridge.set({ id, value: toOrgValue(entry.value), baseRevision: entry.baseRevision })
    )
    const unchanged = pending.get(id) === entry
    const accepted =
      response.status === 200 || (entry.value === null && response.status === 404 && !offline)
    if (accepted) {
      let written: number | null = null
      if (entry.value === null) {
        records.delete(id)
      } else {
        const record = toRecord(response.body)
        if (record) {
          const current = records.get(id)
          if (!current || current.revision <= record.revision) records.set(id, record)
          written = record.revision
        }
      }
      if (unchanged) pending.delete(id)
      else if (pending.has(id)) pending.get(id)!.baseRevision = written
      lastWriteError = null
      listCache = null
      return true
    }
    if (response.status === 409) {
      const theirs = toRecord(response.body?.current)
      if (theirs) records.set(id, theirs)
      else records.delete(id)
      const mine = pending.get(id)?.value ?? entry.value
      pending.delete(id)
      listCache = null
      // Both sides made the same change: nothing to decide.
      if (stableJson(mine) !== stableJson(theirs?.value ?? null)) {
        conflicts.set(id, { id, mine, theirs })
      }
      return true
    }
    if (response.status === 0 || response.status >= 500) {
      offline = true
      return false
    }
    if (response.status === 401 || isUnknownChannel(response)) {
      unavailable = true
      return false
    }
    // Refused for good (no permission, invalid value, a name already taken):
    // the local change is dropped and the bridge's value shown again.
    lastWriteError = {
      id,
      status: response.status,
      error: errorCode(response),
      message: errorMessage(response)
    }
    if (unchanged) {
      pending.delete(id)
      listCache = null
      emit([{ id, value: effective(id) }])
    }
    return true
  }

  async function doFlush(): Promise<void> {
    const bridge = options.bridge()
    if (!bridge) return
    while (pending.size) {
      const [id, entry] = pending.entries().next().value as [string, Pending]
      const reached = await send(bridge, id, entry)
      persist()
      if (!reached) break
    }
    notifyStatus()
  }

  async function flush(): Promise<void> {
    if (flushTimer !== null) {
      clearTimer(flushTimer)
      flushTimer = null
    }
    hydrate()
    // A write queued while one is in flight goes out right after it.
    while (flushing) await flushing
    if (!pending.size) return
    flushing = doFlush().finally(() => {
      flushing = null
    })
    return flushing
  }

  function queue(id: string, value: StoredVariable | null): void {
    hydrate()
    if (stableJson(effective(id)) === stableJson(value)) return
    const conflict = conflicts.get(id)
    if (conflict) {
      // Still to be decided: the new local value is what "keep mine" keeps.
      conflict.mine = value
    } else if (pending.has(id)) {
      pending.set(id, { value, baseRevision: pending.get(id)!.baseRevision })
    } else {
      pending.set(id, { value, baseRevision: records.get(id)?.revision ?? null })
    }
    listCache = null
    persist()
    notifyStatus()
    if (!conflict) scheduleFlush()
  }

  function listValues(): Record<string, StoredVariable> {
    hydrate()
    if (listCache) return listCache
    const ids = new Set([...records.keys(), ...pending.keys(), ...conflicts.keys()])
    const out: Record<string, StoredVariable> = {}
    for (const id of ids) {
      const value = effective(id)
      if (value) out[id] = value
    }
    listCache = out
    return out
  }

  return {
    scope: 'organization',

    async load(force = false) {
      hydrate()
      if (!loading || force) {
        const first = !loading
        loading = refresh()
        if (first) {
          let timer: unknown = null
          await Promise.race([
            loading,
            new Promise<void>((resolve) => {
              timer = setTimer(resolve, firstLoadTimeoutMs)
            })
          ])
          clearTimer(timer)
        } else {
          await loading
        }
      }
      return listValues()
    },

    list: listValues,

    set(id, value) {
      if (!id || !value) return
      queue(id, JSON.parse(JSON.stringify(value)))
    },

    remove(id) {
      if (!id) return
      queue(id, null)
    },

    onChange(fn) {
      changeHandlers.add(fn)
      return () => {
        changeHandlers.delete(fn)
      }
    },

    onStatus(fn) {
      statusHandlers.add(fn)
      return () => {
        statusHandlers.delete(fn)
      }
    },

    status,
    refresh,
    flush,

    meta(id) {
      hydrate()
      return records.get(id) || null
    },

    async history(id, limit) {
      const bridge = options.bridge()
      if (!bridge || !id) return null
      const response = await call(() => bridge.history(limit ? { id, limit } : { id }))
      if (response.status !== 200 || !Array.isArray(response.body)) return null
      return (response.body as unknown[])
        .map(toVersion)
        .filter((version): version is OrgVersion => Boolean(version))
    },

    conflicts() {
      hydrate()
      return [...conflicts.values()]
    },

    async resolveConflict(id, keep) {
      const conflict = conflicts.get(id)
      if (!conflict) return
      conflicts.delete(id)
      listCache = null
      if (keep === 'mine') {
        pending.set(id, { value: conflict.mine, baseRevision: conflict.theirs?.revision ?? null })
        persist()
        notifyStatus()
        await flush()
        return
      }
      persist()
      if (stableJson(conflict.mine) !== stableJson(effective(id))) {
        emit([{ id, value: effective(id) }])
      }
      notifyStatus()
    },

    reset() {
      const gone = forgetOrganization()
      org = null
      syncedAt = null
      unavailable = false
      offline = false
      reason = undefined
      lastWriteError = null
      loading = null
      try {
        options.cache?.write(null)
      } catch {
        // ignore
      }
      emit(gone)
      notifyStatus()
    }
  }
}
