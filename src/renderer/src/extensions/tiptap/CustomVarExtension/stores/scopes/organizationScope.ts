// The Organization scope as the app uses it:
// - the bridge is `window.server.variables.organization` (the web driver
//   sends the vars:org:* channels to the API bridge, the desktop preload asks
//   the main process to);
// - the identity is the signed-in user and the session's organization, from
//   the auth store on every platform (Main.svelte calls followSession; the
//   store is passed in, not imported, which would close an import cycle
//   through the variable store); a token renewal does not change it;
// - the offline copy is kept in localStorage, one key per identity;
// - the scope is read again when the window gets focus or becomes visible,
//   when the network comes back, and every few minutes while visible.
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

const CACHE_PREFIX = 'ddoc.org_vars.v1:'
const POLL_MS = 3 * 60_000

const cache: OrgCache = {
  read(identity) {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(CACHE_PREFIX + identity)
    return raw ? (JSON.parse(raw) as OrgCacheSnapshot) : null
  },
  write(identity, snapshot) {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CACHE_PREFIX + identity, JSON.stringify(snapshot))
  }
}

function bridge(): OrgBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { server?: { variables?: { organization?: OrgBridge } } })
    .server?.variables?.organization
  return api && typeof api.list === 'function' ? api : null
}

export const organizationScope = createOrganizationScope({ bridge, cache })

type SessionState = {
  initializing?: boolean
  authenticated?: boolean
  user?: { id?: string; email?: string } | null
  activeOrg?: string
}

/** Who is signed in, in which organization: the scope's identity. */
export function followSession(session: Readable<SessionState>): () => void {
  return session.subscribe((state) => {
    if (state.initializing) return
    const user = state.user?.id || state.user?.email
    organizationScope.setIdentity(
      state.authenticated && user ? `${user}@${state.activeOrg || ''}` : null
    )
  })
}

let started = false

/** Starts reading the scope in the background; loading the global scopes calls it. */
export function startOrganizationSync(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const visible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  setInterval(() => {
    if (visible()) void organizationScope.refresh()
  }, POLL_MS)
  window.addEventListener('focus', () => void organizationScope.refresh())
  window.addEventListener('online', () => void organizationScope.refresh())
  document.addEventListener('visibilitychange', () => {
    if (visible()) void organizationScope.refresh()
  })
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
