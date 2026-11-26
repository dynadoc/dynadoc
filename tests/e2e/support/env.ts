/**
 * Ports and paths shared by the Playwright config, the fixtures and the stub
 * launcher. One place, so the three can never disagree.
 */
import path from 'node:path'

/** The stub bridge. Not 7070, so a contributor's own stub keeps running. */
export const STUB_PORT = Number(process.env.E2E_STUB_PORT || 7071)

/** The web app (vite preview, or vite dev with E2E_SERVER=dev). */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4180)

export const BASE_URL = `http://localhost:${WEB_PORT}`

/**
 * The stub's drive root for this run. Recreated empty by start-stub.mjs each
 * time the stub starts. The UI settings store lives beside it, in
 * `<root>.settings.json`, which the fixtures reset before every test.
 */
export const STUB_ROOT = path.resolve(
  process.env.E2E_STUB_ROOT || path.join(__dirname, '..', '.stub-root', 'drive')
)

export const SETTINGS_FILE = `${STUB_ROOT}.settings.json`

/** `preview` (default): the production bundle. `dev`: vite dev, for iterating. */
export const SERVER_MODE = process.env.E2E_SERVER === 'dev' ? 'dev' : 'preview'

/** Screenshot comparisons only run where the baselines were made, see README. */
export const VISUAL = process.env.E2E_VISUAL === '1'
