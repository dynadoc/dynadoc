const REGIONAL_API_URL_KEY = 'ddoc.api_url'
const REGIONAL_COLLAB_WS_KEY = 'ddoc.collab_ws_url'

// Spoke subdomains that actually answer. The backend builds regional URLs from
// the raw region name, so a region that is declared but not serving yields a
// host that resolves and then refuses the connection -- and every call fails.
//
// Only `ch` is in this set, and that is the point. `us` and `ap` exist in the
// deployment manifests but serve no traffic: api.us.dynadoc.dashmake.com
// resolves to the Swiss hub and has no route there, so the connection dies
// before any HTTP status. A browser that had stored one was locked out of the
// application entirely -- the session was valid, every call to verify it
// failed to connect, and the app concluded "not signed in" and showed the
// login screen again, on a loop, with no way out but clearing site data.
//
// Listing a region here is what lets a stored URL survive, so this set is the
// guard: a URL naming a region that is not here is dropped from storage below
// and the client falls back to the host it is served from. That makes this
// change self-healing for anyone already stuck.
//
// ADD A REGION BACK WHEN ITS SPOKE ACTUALLY SERVES, not when it is declared.
const KNOWN_REGION_SUBDOMAINS = new Set(['ch'])

function isUsableRegionalUrl(value: string): boolean {
  try {
    const parts = new URL(value).hostname.split('.')
    // api.<region>.dynadoc.dashmake.com / collab.<region>....
    if (parts.length >= 5 && parts.slice(-3).join('.') === 'dynadoc.dashmake.com') {
      return KNOWN_REGION_SUBDOMAINS.has(parts[1])
    }
    return true
  } catch {
    return false
  }
}

function safeStorageGet(key: string): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    return String(localStorage.getItem(key) || '').trim()
  } catch {
    return ''
  }
}

function safeWindowValue(...keys: string[]): string {
  try {
    if (typeof window === 'undefined') return ''
    for (const key of keys) {
      const value = String((window as any)?.[key] || '').trim()
      if (value) return value
    }
  } catch {
    // ignore runtime access failures
  }
  return ''
}

export function persistRegionalEndpoints(session: any) {
  const source = session?.session && typeof session.session === 'object' ? session.session : session
  const apiUrl = String(source?.api_url || source?.apiUrl || source?.APIURL || '').trim()
  const collabWsUrl = String(
    source?.collab_ws_url || source?.collabWsUrl || source?.CollabWSURL || ''
  ).trim()
  try {
    if (typeof localStorage === 'undefined') return
    if (apiUrl && isUsableRegionalUrl(apiUrl)) localStorage.setItem(REGIONAL_API_URL_KEY, apiUrl)
    if (collabWsUrl && isUsableRegionalUrl(collabWsUrl)) {
      localStorage.setItem(REGIONAL_COLLAB_WS_KEY, collabWsUrl)
    }
    if (source?.authenticated === false) {
      localStorage.removeItem(REGIONAL_API_URL_KEY)
      localStorage.removeItem(REGIONAL_COLLAB_WS_KEY)
    }
  } catch {
    // ignore storage failures
  }
}

export function resolveApiBaseUrl(): string {
  const runtimeUrl = safeWindowValue('__DYNADOC_API_BASE__', 'DYNADOC_API_BASE')
  if (runtimeUrl) return runtimeUrl

  const storedRegionalUrl = safeStorageGet(REGIONAL_API_URL_KEY)
  if (storedRegionalUrl) {
    // Self-heal storages poisoned by a placeholder region before the guard.
    if (isUsableRegionalUrl(storedRegionalUrl)) return storedRegionalUrl
    try {
      localStorage.removeItem(REGIONAL_API_URL_KEY)
    } catch {}
  }

  const envUrl = (import.meta as any).env?.VITE_API_URL
  if (envUrl && envUrl.trim()) return envUrl.trim()

  if (typeof window !== 'undefined' && window.location?.origin) {
    const protocol = String(window.location.protocol || '')
    if (protocol.startsWith('http')) {
      const host = String(window.location.host || '')
      const servedLocally =
        !host ||
        host.includes('localhost') ||
        host.startsWith('127.0.0.1') || // accessed from a local development environment
        host.startsWith('192.168') // accessed from a local network, e.g. via another device in a local environment
      if (!servedLocally) {
        if (host.startsWith('app.')) {
          return `${window.location.protocol}//${host.replace(/^app\./, 'api.')}`
        }
        return window.location.origin
      }
      // A page served over http from a local host is a development server, and
      // the one thing it must not quietly do is talk to production.
      //
      // Falling through to the hardcoded production URL below is what used to
      // happen here. Someone cloning this repository and running
      // `npm run dev:web` with no env file would authenticate against the live
      // API and create real documents in it, with nothing on screen to say so.
      // Point at the stub bridge instead: it is what `npm run stub-bridge`
      // serves on 7070, and what the contributor documentation tells people to
      // run. Set VITE_API_URL to reach anything else.
      //
      // Neither shipped target reaches this line. The packaged desktop app
      // serves its renderer over a custom protocol rather than http, and the
      // deployed web app is not on a local host, so both keep the behaviour
      // they had.
      return 'http://localhost:7070'
    }
  }

  return 'https://api.dynadoc.dashmake.com'
}

export function resolveCollabWsBaseUrl(): string {
  const runtimeUrl = safeWindowValue('__DYNADOC_COLLAB_WS__', 'DYNADOC_COLLAB_WS')
  if (runtimeUrl) return runtimeUrl

  const storedRegionalUrl = safeStorageGet(REGIONAL_COLLAB_WS_KEY)
  if (storedRegionalUrl) {
    if (isUsableRegionalUrl(storedRegionalUrl)) return storedRegionalUrl
    try {
      localStorage.removeItem(REGIONAL_COLLAB_WS_KEY)
    } catch {}
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    const host = String(window.location.host || '')
    const servedLocally =
      !host ||
      host.includes('localhost') ||
      host.startsWith('127.0.0.1') || // accessed from a local development environment
      host.startsWith('192.168') // accessed from a local network, e.g. via another device in a local production environment
    if (!servedLocally) {
      if (host.startsWith('app.')) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${host.replace(/^app\./, 'collab.')}`
      }
    } else if (String(window.location.protocol || '').startsWith('http')) {
      // Same reasoning as resolveApiBaseUrl: a development server must not
      // open a collaboration socket against production. A contributor editing
      // a document locally would otherwise join the live editing sessions of
      // real users.
      //
      // Nothing listens here by default -- the stub bridge deliberately does
      // not implement collaboration, which needs the full service. So this
      // connection fails, and that is the intended outcome: a local failure to
      // collaborate is the honest result, and far better than succeeding
      // against production. 1234 is the port the renderer's own CSP already
      // allows for a local collaboration server, so anyone running one needs
      // no further configuration.
      return 'ws://localhost:1234'
    }
  }

  return 'wss://collab.dynadoc.dashmake.com'
}
