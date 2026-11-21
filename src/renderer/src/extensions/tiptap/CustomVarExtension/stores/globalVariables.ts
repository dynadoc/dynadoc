// App-wide variables: the ones whose visibility is Desktop or Cloud.
//
// They live in one JSON file in the app's storage directory (a filesystem
// policy root, like the other renderer-owned stores) instead of a document's
// vars.json, so every document on this computer can use them. Cloud is
// treated like Desktop locally.
//
// Windows are kept in step with a BroadcastChannel, and the file is re-read
// when a window gets focus in case another process wrote it.
import { nodeApi } from '../../../../utils/shims/node'
import { getStorageDirCached } from '../../../../utils/storageDir'

export const GLOBAL_VARS_FILE_NAME = 'global-vars.json'

// A stored variable is a VariableValue (variableManipulator.ts); kept opaque
// here so this module does not import the store that imports it.
type StoredVariable = Record<string, unknown>
type GlobalVars = Record<string, StoredVariable>
export type GlobalVariableChange = { id: string; value: StoredVariable | null }

let _vars: GlobalVars = {}
let _loading: Promise<GlobalVars> | null = null
let _channel: BroadcastChannel | null = null
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const _pending = new Map<string, StoredVariable | null>()
const _handlers = new Set<(changes: GlobalVariableChange[]) => void>()

async function getFilePath(): Promise<string | null> {
  const dir = await getStorageDirCached()
  if (!dir || !nodeApi?.path) return null
  return nodeApi.path.join(dir, GLOBAL_VARS_FILE_NAME)
}

async function readFile(): Promise<GlobalVars> {
  try {
    const filePath = await getFilePath()
    if (!filePath || !(await nodeApi.fsPromises?.exists(filePath))) return {}
    const raw = await nodeApi.fsPromises.readFile(filePath, 'utf-8')
    const data = JSON.parse(String(raw || '{}'))
    return data && typeof data === 'object' ? data : {}
  } catch (err) {
    console.error('Error loading global variables:', err)
    return {}
  }
}

// Writes only this window's pending changes on top of what is on disk, so two
// windows saving close together do not drop each other's variables.
async function flush(): Promise<void> {
  _saveTimer = null
  if (!_pending.size) return
  const changes = new Map(_pending)
  _pending.clear()
  try {
    const filePath = await getFilePath()
    if (!filePath) return
    const onDisk = await readFile()
    for (const [id, value] of changes) {
      if (value === null) delete onDisk[id]
      else onDisk[id] = value
    }
    await nodeApi.fsPromises.mkdir(nodeApi.path.dirname(filePath), { recursive: true })
    await nodeApi.fsPromises.writeFile(filePath, JSON.stringify(onDisk, null, 2), 'utf-8')
  } catch (err) {
    console.error('Error saving global variables:', err)
  }
}

function emit(changes: GlobalVariableChange[]): void {
  if (!changes.length) return
  _handlers.forEach((fn) => {
    try {
      fn(changes)
    } catch (err) {
      console.error('Global variable change handler failed:', err)
    }
  })
}

function applyRemote(next: GlobalVars): void {
  const changes: GlobalVariableChange[] = []
  for (const [id, value] of Object.entries(next)) {
    if (JSON.stringify(_vars[id]) !== JSON.stringify(value)) changes.push({ id, value })
  }
  for (const id of Object.keys(_vars)) {
    if (!(id in next)) changes.push({ id, value: null })
  }
  _vars = { ...next }
  emit(changes)
}

function ensureSync(): void {
  if (_channel || typeof window === 'undefined') return
  if (typeof BroadcastChannel !== 'undefined') {
    _channel = new BroadcastChannel('dynadoc-vars')
    _channel.onmessage = (event) => {
      const changes = (event?.data?.changes || []) as GlobalVariableChange[]
      const applied: GlobalVariableChange[] = []
      for (const change of changes) {
        if (!change?.id) continue
        if (change.value === null) {
          if (!(change.id in _vars)) continue
          delete _vars[change.id]
        } else {
          _vars[change.id] = change.value
        }
        applied.push(change)
      }
      emit(applied)
    }
  }
  window.addEventListener('focus', () => {
    if (_pending.size) return
    void readFile().then(applyRemote)
  })
}

/** Loads the store once; `force` re-reads the file. */
export function loadGlobalVariables(force = false): Promise<GlobalVars> {
  ensureSync()
  if (!_loading || force) {
    _loading = readFile().then((data) => {
      if (force) applyRemote(data)
      else _vars = { ...data, ..._vars }
      return _vars
    })
  }
  return _loading
}

export function getGlobalVariables(): GlobalVars {
  return _vars
}

function commit(id: string, value: StoredVariable | null): void {
  if (value === null) delete _vars[id]
  else _vars[id] = value
  _pending.set(id, value)
  if (!_saveTimer) _saveTimer = setTimeout(flush, 180)
  try {
    _channel?.postMessage({ changes: [{ id, value }] })
  } catch {
    // ignore: the focus re-read catches up
  }
}

/** Stores a global variable and tells the other windows. */
export function setGlobalVariable(id: string, value: object): void {
  if (!id || !value) return
  const plain = JSON.parse(JSON.stringify(value))
  if (JSON.stringify(_vars[id]) === JSON.stringify(plain)) return
  commit(id, plain)
}

export function deleteGlobalVariable(id: string): void {
  if (!id || !(id in _vars)) return
  commit(id, null)
}

/** Changes made by other windows or found on disk; not this window's own. */
export function onGlobalVariablesChange(fn: (changes: GlobalVariableChange[]) => void): () => void {
  _handlers.add(fn)
  return () => {
    _handlers.delete(fn)
  }
}
