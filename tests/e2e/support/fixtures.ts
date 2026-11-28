/**
 * The fixtures every spec uses. Import `test` and `expect` from here, never
 * from @playwright/test directly: the guard below is what makes a spec fail on
 * side effects it did not assert on.
 *
 * Before each test:
 *   - the stub's UI settings store is reset to the seed (tours seen, no tab
 *     open), so a test never inherits the documents another test left open;
 *   - the browser context starts without `ddoc.api_url` and
 *     `ddoc.web_auto_signin`, and with the tours marked as seen in the
 *     localStorage mirror the app reads before its settings arrive.
 *
 * After each test, the guard fails it on:
 *   - an uncaught page error;
 *   - a console error not in ALLOWED_CONSOLE_ERRORS;
 *   - a request to the stub that failed, unless the stub refused it by design
 *     or it is in ALLOWED_STUB_FAILURES;
 *   - a file of the app itself (chunk, stylesheet, font) that failed to load.
 * Each allow-list entry says why it is there; KNOWN BUG marks a real bug kept
 * so the rest of the suite can run. Add one only with a reason.
 */
import { test as base, expect, type Page, type Response } from '@playwright/test'
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { SETTINGS_FILE } from './env'

export { expect }

type AllowEntry = { pattern: RegExp; why: string }

export const ALLOWED_CONSOLE_ERRORS: AllowEntry[] = [
  {
    pattern: /^Failed to load resource: the server responded with a status of \d+/,
    why:
      'Chromium logs every non-2xx response without saying which call it was. Each of ' +
      'them is checked by the request guard instead, which sees the channel and the answer.'
  },
  {
    pattern: /\[dynadoc local stub\]/,
    why:
      'the app logging, word for word, a call the stub refuses by design ' +
      '(drive:resolve-path, auth:list-sessions, uploads...). The request guard checks the call itself.'
  },
  {
    pattern: /\[collab provider\] token failed/,
    why: 'no collaboration service behind the stub: POST /api/collab/token is refused by design.'
  },
  {
    pattern: /^Creating a worker from 'data:video\/mp2t;base64,/,
    why:
      'KNOWN BUG, production build only: LatexProjectModal.svelte builds its worker URL as ' +
      "`new URL('./latex.worker.ts', import.meta.url)` outside `new Worker(...)`, so Vite ships " +
      'the .ts file as a data: asset (typed as an MPEG-TS video) instead of bundling a worker, ' +
      'and the CSP refuses it. The LaTeX preview worker never starts on the web.'
  },
  {
    pattern: /^\[Watcher\] Connection lost for /,
    why: 'file watching (GET /api/ipc/watch) is refused by the stub by design; the app logs the closed stream.'
  },
  {
    pattern:
      /^Connecting to 'wss:\/\/api\.dynadoc\.dashmake\.com\/ws' violates the following Content Security Policy/,
    why:
      'KNOWN BUG, not harmless: the spreadsheet collaboration socket (and three other call ' +
      'sites, see collab.ts) falls back to the production URL when DYNADOC_WS_URL is unset, even ' +
      'from a local server. Only the CSP stops it. Remove this entry once the fallback is local.'
  }
]

type StubFailure = {
  route: string
  status: number
  channel: string
  arg: string
  error: string
}

/**
 * Failed stub calls that are real answers (not refusals by design). Most are
 * the app probing for an optional file a new document does not have yet; the
 * one marked KNOWN BUG is a real bug, listed so the suite can run.
 */
export const ALLOWED_STUB_FAILURES: Array<{
  channel: string
  arg: RegExp
  error: RegExp
  why: string
}> = [
  {
    channel: 'fs:readFile',
    arg: /\.(config|info)\.json$/,
    error: /^ENOENT/,
    why:
      'a new document is opened before its sidecar files are read back; the app falls back ' +
      'to defaults. Some of these probes resolve against the drive root ("New Document.config.json"), ' +
      'which is worth a look in the app but is not what these specs guard.'
  },
  {
    channel: 'fs:readFile',
    arg: /\/assets\/form-responses\//,
    error: /^ENOENT/,
    why: 'form responses of a document that has none yet.'
  },
  {
    channel: 'fs:readdir',
    arg: /(^|\/)assets\/(sheet|design|slides?)$/,
    error: /^ENOENT/,
    why: 'an embedded sheet, design or deck listing its assets before it has any.'
  },
  {
    channel: 'fs:writeFile',
    arg: /(^|\/)assets\/sheet\/sheet\.json$/,
    error: /write payload that is not a string/,
    why:
      'KNOWN BUG, not harmless: the spreadsheet saves its sheet data as an object, relative to ' +
      'the drive root. The stub refuses it; the real bridge stringifies it to "[object Object]". ' +
      'Listed so the suite can run the sheet scenarios; remove this entry once the save is fixed.'
  },
  {
    channel: 'fs:readFile',
    arg: /(^|\/)vars\.json$/,
    error: /^ENOENT/,
    why: 'the variables file of a document or scope that has no variable yet.'
  }
]

/** A refusal by design: the stub names what it does not implement. */
const REFUSED_BY_DESIGN =
  /^\[dynadoc local stub\] .*(is not implemented|are not implemented|implemented nowhere)/

export class Guard {
  readonly issues: string[] = []
  private readonly extraConsole: AllowEntry[] = []
  private readonly pending: Promise<void>[] = []
  readonly stubCalls: Array<{ channel: string; arg: string }> = []

  /** Allow one more console error pattern for this test only, with a reason. */
  allowConsoleError(pattern: RegExp, why: string): void {
    this.extraConsole.push({ pattern, why })
  }

  attach(page: Page): void {
    page.on('pageerror', (error) => {
      const where = (error.stack || '').split('\n').slice(1, 4).join(' | ').trim()
      this.issues.push(`page error: ${error.name}: ${error.message}${where ? ` at ${where}` : ''}`)
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      const allowed = [...ALLOWED_CONSOLE_ERRORS, ...this.extraConsole].some((entry) =>
        entry.pattern.test(text)
      )
      if (!allowed) this.issues.push(`console error: ${text.slice(0, 500)}`)
    })
    page.on('request', (request) => {
      if (!isStubCall(request.url())) return
      const { channel, arg } = describeCall(request.postData())
      if (channel) this.stubCalls.push({ channel, arg })
    })
    page.on('response', (response) => {
      if (response.status() < 400) return
      if (isStubCall(response.url())) {
        this.pending.push(this.checkFailedResponse(response))
      } else if (isOwnAsset(response.url(), page)) {
        // A chunk, a stylesheet or a font of the app itself that is missing.
        this.issues.push(`app asset failed: ${response.status()} ${response.url()}`)
      }
    })
    page.on('requestfailed', (request) => {
      if (!isStubCall(request.url())) return
      const failure = request.failure()?.errorText || 'unknown'
      // An aborted call is one the page itself cancelled, or a page closing.
      if (failure === 'net::ERR_ABORTED') return
      this.issues.push(`stub call failed: ${request.method()} ${request.url()} (${failure})`)
    })
  }

  private async checkFailedResponse(response: Response): Promise<void> {
    const request = response.request()
    const { channel, arg } = describeCall(request.postData())
    let error = ''
    try {
      const body = await response.json()
      error = String(body?.error ?? '')
    } catch {
      // The page may be gone by now; the status alone is then all we know.
    }
    const failure: StubFailure = {
      route: `${request.method()} ${new URL(response.url()).pathname}`,
      status: response.status(),
      channel,
      arg,
      error
    }
    if (REFUSED_BY_DESIGN.test(failure.error)) return
    const allowed = ALLOWED_STUB_FAILURES.some(
      (entry) =>
        entry.channel === failure.channel && entry.arg.test(failure.arg) && entry.error.test(error)
    )
    if (allowed) return
    this.issues.push(
      `stub call failed: ${failure.route} ${failure.status} ${failure.channel} ${failure.arg} -> ${failure.error.slice(0, 300)}`
    )
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.pending)
  }
}

/** A file served by the web app itself (same origin, outside /api). */
function isOwnAsset(url: string, page: Page): boolean {
  try {
    return new URL(url).origin === new URL(page.url()).origin
  } catch {
    return false
  }
}

function isStubCall(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/api/')
  } catch {
    return false
  }
}

function describeCall(postData: string | null): { channel: string; arg: string } {
  if (!postData) return { channel: '', arg: '' }
  try {
    const payload = JSON.parse(postData)
    const first = Array.isArray(payload?.args) ? payload.args[0] : undefined
    const arg =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && typeof first.path === 'string'
          ? first.path
          : ''
    return { channel: String(payload?.channel || ''), arg }
  } catch {
    return { channel: '', arg: '' }
  }
}

export const test = base.extend<{ guard: Guard }>({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      try {
        localStorage.removeItem('ddoc.api_url')
        localStorage.removeItem('ddoc.web_auto_signin')
        localStorage.setItem('ddoc.ui.pref:ui:tour:home:v1', 'true')
        localStorage.setItem('ddoc.ui.pref:ui:tour:editor:v1', 'true')
      } catch {
        // storage unavailable: the app then shows the tour, and the test says so
      }
    })
    await use(context)
  },
  guard: [
    async ({ page, context }, use, testInfo) => {
      copyFileSync(path.join(__dirname, 'settings.seed.json'), SETTINGS_FILE)
      const guard = new Guard()
      guard.attach(page)
      // Windows the app opens (the slideshow, #150) are watched too: an error
      // there is as real as one in the main page.
      context.on('page', (popup) => guard.attach(popup))
      await use(guard)
      await guard.settle()
      if (guard.issues.length) {
        await testInfo.attach('side-effects', {
          body: guard.issues.join('\n'),
          contentType: 'text/plain'
        })
      }
      expect(guard.issues, 'page errors, console errors or failed stub calls').toEqual([])
    },
    { auto: true }
  ]
})
