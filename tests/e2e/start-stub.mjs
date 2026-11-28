#!/usr/bin/env node
/**
 * Starts the stub bridge (tools/stub-bridge/server.mjs) for the e2e suite.
 *
 * The drive root is emptied and recreated every time, so a run never reads
 * what a previous run, or a contributor's own `~/.dynadoc-stub`, left behind.
 * Default: tests/e2e/.stub-root/drive (git-ignored), or E2E_STUB_ROOT.
 *
 * The UI settings store (`<root>.settings.json`) is seeded with the two
 * onboarding tours marked as seen: they are modal and sit over the buttons
 * every spec starts from. The fixtures write the same seed before every test,
 * so a test never inherits the tabs another test left open. The organization
 * variable store (`<root>.org-variables.json`) starts empty.
 *
 * Environment: E2E_STUB_PORT (default 7071), E2E_STUB_ROOT.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.env.E2E_STUB_ROOT || path.join(here, '.stub-root', 'drive'))

rmSync(root, { recursive: true, force: true })
// The organization variable store lives beside the drive, like the settings.
rmSync(`${root}.org-variables.json`, { force: true })
mkdirSync(root, { recursive: true })
copyFileSync(path.join(here, 'support', 'settings.seed.json'), `${root}.settings.json`)

process.env.DYNADOC_STUB_ROOT = root
process.env.DYNADOC_STUB_PORT = process.env.E2E_STUB_PORT || '7071'

// Playwright stops the web servers with SIGTERM; exit cleanly on it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0))
}

await import('../../tools/stub-bridge/server.mjs')
