// The Organization scope as the app uses it: the bridge is
// `window.server.variables.organization` (the web driver calls the API
// bridge over HTTPS, the desktop preload asks the main process to), the
// offline copy is kept in localStorage, and the scope is read again every
// few seconds while the window is visible, when it gets focus and when the
// network comes back.
import { readable, type Readable } from 'svelte/store'
import {
  createOrganizationScope,
  type OrgBridge,
  type OrgCache,
  type OrgCacheSnapshot,
  type OrgConflict,
  type OrgStatus
} from './organizationScope.core'

export type { OrgConflict, OrgStatus, OrgVariableRecord } from './organizationScope.core'

const CACHE_KEY = 'ddoc.org_vars.v1'
const POLL_MS = 4_000

const cache: OrgCache = {
  read() {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as OrgCacheSnapshot) : null
  },
  write(snapshot) {
    if (typeof localStorage === 'undefined') return
    if (snapshot) localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot))
    else localStorage.removeItem(CACHE_KEY)
  }
}

function bridge(): OrgBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { server?: { variables?: { organization?: OrgBridge } } })
    .server?.variables?.organization
  return api && typeof api.list === 'function' ? api : null
}

export const organizationScope = createOrganizationScope({ bridge, cache })

let polling = false

/** Starts reading the scope in the background; loading the global scopes calls it. */
export function startOrganizationSync(): void {
  if (polling || typeof window === 'undefined') return
  polling = true
  const visible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  setInterval(() => {
    if (visible()) void organizationScope.refresh()
  }, POLL_MS)
  window.addEventListener('focus', () => void organizationScope.refresh())
  window.addEventListener('online', () => void organizationScope.refresh())
  // Another account: the previous one's copy and pending changes are not
  // this one's to see or send.
  let token = currentToken()
  window.addEventListener('ddoc:session-changed', () => {
    const next = currentToken()
    if (next === token) return
    token = next
    organizationScope.reset()
    void organizationScope.refresh()
  })
}

function currentToken(): string | null {
  try {
    return localStorage.getItem('ddoc.access_token')
  } catch {
    return null
  }
}

/** The scope's status, for the UI. */
export const organizationStatus: Readable<OrgStatus> = readable(
  organizationScope.status(),
  (set) => {
    set(organizationScope.status())
    const unsubscribe = organizationScope.onStatus(set)
    // "Stale" depends on the clock as well as on events.
    const timer = setInterval(() => set(organizationScope.status()), 15_000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }
)

/** Writes the bridge refused because the value had changed; the user picks a side. */
export const organizationConflicts: Readable<OrgConflict[]> = readable(
  organizationScope.conflicts(),
  (set) => {
    set(organizationScope.conflicts())
    return organizationScope.onStatus(() => set(organizationScope.conflicts()))
  }
)
