// What to do when the application fails to start.
//
// The splash used to stay on "Preparing ..." forever when the boot threw. The
// usual cause is a module that could not be fetched: the Vite dev server
// re-optimises its dependencies after a lockfile or config change and answers
// the first page with "504 Outdated Optimize Dep", and the desktop renderer
// runs without the HMR socket that would normally reload the page. A deployed
// web app can hit the same error when a new release replaced the chunks an
// open tab still refers to. In both cases one reload is the fix.
//
// So: reload once, by ourselves, for that kind of error. For anything else, or
// if the reload did not help, say what happened and offer a Reload button
// instead of a spinner that never ends.
//
// The decision is kept free of the DOM so the smoke test can load this file.

export const BOOT_RELOAD_KEY = 'ddoc.boot.autoReloadAt'
/** A second failure within this window is not retried automatically. */
export const BOOT_RELOAD_WINDOW_MS = 60_000

const STALE_MODULE_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Outdated Optimize Dep/i, // Vite dev server, 504
  /Unable to preload CSS/i // Vite build, CSS chunk
]

export function isStaleModuleError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  return STALE_MODULE_PATTERNS.some((pattern) => pattern.test(message))
}

export function decideBootRecovery(input: {
  error: unknown
  lastAutoReloadAt: number | null
  now: number
}): 'reload' | 'show-error' {
  if (!isStaleModuleError(input.error)) return 'show-error'
  const last = input.lastAutoReloadAt
  if (last !== null && Number.isFinite(last) && input.now - last < BOOT_RELOAD_WINDOW_MS) {
    return 'show-error'
  }
  return 'reload'
}

function readLastAutoReload(): number | null {
  try {
    const raw = window.sessionStorage.getItem(BOOT_RELOAD_KEY)
    return raw ? Number(raw) : null
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error ?? 'Unknown error')
}

/** Replaces the splash content with a message and a Reload button. */
function showBootFailure(error: unknown): void {
  document.body.classList.remove('is-app-loading')
  const host = document.getElementById('app-splash') || document.body
  const card = document.createElement('div')
  card.setAttribute('role', 'alert')
  card.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:16px;background:#f5f7fa;z-index:2147483647;font-family:system-ui,sans-serif;color:#1f2937'
  const inner = document.createElement('div')
  inner.style.cssText =
    'max-width:520px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:16px;' +
    'padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.08)'
  const title = document.createElement('h1')
  title.textContent = 'Dynadoc could not start'
  title.style.cssText = 'font-size:20px;margin:0 0 8px'
  const text = document.createElement('p')
  text.textContent = isStaleModuleError(error)
    ? 'Part of the application could not be loaded. This usually happens right after an update or, in development, while the dev server rebuilds its dependencies. Reloading fixes it.'
    : 'Something failed while the application was starting. Reloading may fix it; your documents on disk were not changed.'
  text.style.cssText = 'margin:0 0 12px;line-height:1.5;font-size:14px'
  const detail = document.createElement('pre')
  detail.textContent = describe(error)
  detail.style.cssText =
    'white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f3f4f6;' +
    'border-radius:8px;padding:10px;margin:0 0 16px;max-height:160px;overflow:auto'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Reload'
  button.style.cssText =
    'background:#0f766e;color:#fff;border:0;border-radius:8px;padding:10px 18px;' +
    'font-size:14px;cursor:pointer'
  button.addEventListener('click', () => window.location.reload())
  inner.append(title, text, detail, button)
  card.append(inner)
  host.append(card)
}

/** Called with whatever made the boot fail. */
export function recoverFromBootFailure(error: unknown): void {
  console.error('[boot] the application failed to start', error)
  const now = Date.now()
  const decision = decideBootRecovery({ error, lastAutoReloadAt: readLastAutoReload(), now })
  if (decision === 'reload') {
    try {
      window.sessionStorage.setItem(BOOT_RELOAD_KEY, String(now))
    } catch {
      // Without storage there is no guard against a reload loop: show the
      // message instead of reloading.
      showBootFailure(error)
      return
    }
    window.location.reload()
    return
  }
  showBootFailure(error)
}
