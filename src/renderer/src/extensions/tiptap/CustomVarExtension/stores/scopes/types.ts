// The one interface every variable scope implements: Document (the
// document's vars.json, or its Yjs map), Desktop (one file in the app's
// storage directory) and Organization (the API bridge, with a local cache).
// No imports on purpose: tests/smoke/organization-variables.test.mjs bundles
// the Organization core with this file and nothing else.

/** Where a variable lives. */
export type VariableScopeId = 'document' | 'desktop' | 'organization'

/** A stored variable is a VariableValue (variableManipulator.ts), kept opaque here. */
export type StoredVariable = Record<string, unknown>

/** A change the scope learned about from elsewhere; `value: null` is a deletion. */
export type ScopeChange = { id: string; value: StoredVariable | null }

/**
 * How current the scope's copy is.
 * - `local`: the scope is on this computer, its copy is the truth;
 * - `loading`: nothing to show yet;
 * - `live`: read from its source a moment ago;
 * - `stale`: a copy kept for offline use, older than it should be, or the
 *   source could not be reached (`reason` says why);
 * - `unavailable`: the source does not serve this scope.
 */
export type ScopeState = 'local' | 'loading' | 'live' | 'stale' | 'unavailable'

export type ScopeStatus = {
  state: ScopeState
  /** When the copy was last read from its source (ms since epoch). */
  syncedAt: number | null
  /** Local changes the source has not accepted yet. */
  pending: number
  /** Changes the source refused because someone changed the value first. */
  conflicts: number
  reason?: 'offline' | 'unauthorized' | 'error'
}

export interface VariableScopeDriver {
  readonly scope: VariableScopeId
  /** Reads the scope once; `force` reads it again. */
  load(force?: boolean): Promise<Record<string, StoredVariable>>
  /** What the scope holds now, in memory. */
  list(): Record<string, StoredVariable>
  /** Stores a variable. Not reported back through onChange. */
  set(id: string, value: StoredVariable): void
  /** Deletes a variable. Not reported back through onChange. */
  remove(id: string): void
  /** Changes made elsewhere: another window, another person, the disk. */
  onChange(fn: (changes: ScopeChange[]) => void): () => void
  status(): ScopeStatus
}
