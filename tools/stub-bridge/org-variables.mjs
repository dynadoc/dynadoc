/**
 * Organization variables, by the contract in docs/organization-variables.md.
 *
 * The five `vars:org:*` channels over one in-memory state that the caller
 * loads and saves. server.mjs keeps that state in a file next to the drive;
 * tests/smoke/organization-variables.test.mjs drives the same code directly,
 * so the client is tested against what the stub really answers.
 *
 * Each call answers `{ status, body }`: on 200 the body is the channel's
 * `data`, otherwise it is the error (`{ error, message, ... }`).
 *
 * One organization, and every write signed by the one user the stub knows: it
 * verifies no token and cannot tell two people apart. It does not pretend to.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

export const HISTORY_LIMIT = 50

/** Fields that only mean something inside one document; never stored. */
const DOCUMENT_ONLY_FIELDS = ['documentId', 'nodeId', 'row', 'col', 'coord']

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const fail = (status, error, message, extra = {}) => ({
  status,
  body: { error, message, ...extra }
})

const namesOf = (value) =>
  [value?.name, ...(Array.isArray(value?.aliases) ? value.aliases : [])]
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim().toLowerCase())

export function emptyOrgState(org = 'local-stub') {
  return { org, revision: 0, variables: {}, deleted: {}, history: {} }
}

/**
 * @param {{ state: object, user: () => object, now?: () => string }} options
 *   `state` is mutated in place; save it after a call that answered 200.
 */
export function orgVariableChannels({ state, user, now = () => new Date().toISOString() }) {
  const versionOf = (record) => ({
    revision: record.revision,
    value: record.value,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy
  })

  const pushHistory = (id, entry) => {
    state.history[id] = [entry, ...(state.history[id] || [])].slice(0, HISTORY_LIMIT)
  }

  const requireId = (payload) => {
    const id = payload?.id
    return typeof id === 'string' && id.trim() ? id : null
  }

  return {
    'vars:org:list': (payload = {}) => {
      const since = payload?.since
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
        return fail(400, 'invalid_since', '"since" must be a revision number')
      }
      const all = Object.values(state.variables)
      const variables = since === undefined ? all : all.filter((v) => v.revision > since)
      const deleted =
        since === undefined
          ? []
          : Object.entries(state.deleted)
              .filter(([, revision]) => revision > since)
              .map(([id, revision]) => ({ id, revision }))
      return { status: 200, body: { org: state.org, revision: state.revision, variables, deleted } }
    },

    'vars:org:get': (payload = {}) => {
      const id = requireId(payload)
      if (!id) return fail(400, 'invalid_id', '"id" is required')
      const record = state.variables[id]
      if (!record) return fail(404, 'not_found', `"${id}" does not exist`)
      return { status: 200, body: record }
    },

    'vars:org:set': (payload = {}) => {
      const id = requireId(payload)
      if (!id) return fail(400, 'invalid_id', '"id" is required')
      const { baseRevision, value } = payload
      if (baseRevision !== null && !Number.isInteger(baseRevision)) {
        return fail(400, 'invalid_base_revision', '"baseRevision" must be a revision or null')
      }
      if (!isPlainObject(value) || typeof value.name !== 'string' || !value.name.trim()) {
        return fail(422, 'invalid_value', '"value" must be an object with a name')
      }
      const current = state.variables[id] || null
      if ((current?.revision ?? null) !== baseRevision) {
        return fail(
          409,
          'conflict',
          `"${id}" was changed at revision ${current?.revision ?? 'none'}; ` +
            `the write was based on ${baseRevision ?? 'none'}`,
          { current }
        )
      }
      const names = new Set(namesOf(value))
      const clash = Object.values(state.variables).find(
        (other) => other.id !== id && namesOf(other.value).some((name) => names.has(name))
      )
      if (clash) {
        return fail(422, 'name_taken', `"${value.name}" is already used`, { id: clash.id })
      }
      const stored = {}
      for (const [key, field] of Object.entries(value)) {
        if (!DOCUMENT_ONLY_FIELDS.includes(key)) stored[key] = field
      }
      state.revision += 1
      const at = now()
      const by = user()
      const record = {
        id,
        revision: state.revision,
        value: stored,
        createdAt: current?.createdAt ?? at,
        createdBy: current?.createdBy ?? by,
        updatedAt: at,
        updatedBy: by,
        previous: current ? versionOf(current) : null,
        canWrite: true
      }
      state.variables[id] = record
      delete state.deleted[id]
      pushHistory(id, versionOf(record))
      return { status: 200, body: record }
    },

    'vars:org:delete': (payload = {}) => {
      const id = requireId(payload)
      if (!id) return fail(400, 'invalid_id', '"id" is required')
      if (!Number.isInteger(payload.baseRevision)) {
        return fail(400, 'invalid_base_revision', '"baseRevision" must be a revision')
      }
      const current = state.variables[id]
      if (!current) return fail(404, 'not_found', `"${id}" does not exist`)
      if (current.revision !== payload.baseRevision) {
        return fail(
          409,
          'conflict',
          `"${id}" was changed at revision ${current.revision}; ` +
            `the deletion was based on ${payload.baseRevision}`,
          { current }
        )
      }
      state.revision += 1
      delete state.variables[id]
      state.deleted[id] = state.revision
      pushHistory(id, {
        revision: state.revision,
        value: null,
        updatedAt: now(),
        updatedBy: user(),
        deleted: true
      })
      return { status: 200, body: { id, revision: state.revision } }
    },

    'vars:org:history': (payload = {}) => {
      const id = requireId(payload)
      if (!id) return fail(400, 'invalid_id', '"id" is required')
      const history = state.history[id]
      if (!history) return fail(404, 'not_found', `"${id}" does not exist`)
      const limit = Number.isInteger(payload.limit) && payload.limit > 0 ? payload.limit : undefined
      return { status: 200, body: history.slice(0, limit) }
    }
  }
}
