/**
 * Steps every spec shares: opening the app, creating a document from the
 * dashboard, finding the editor. Selectors are roles, labels and text.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { SETTINGS_FILE, STUB_ROOT } from './env'

export type DocumentKind = 'Document' | 'Spreadsheet' | 'Presentation' | 'Design'

/** The dashboard's heading, the sign that the shell is up and signed in. */
export function dashboardHeading(page: Page): Locator {
  return page.getByRole('heading', { name: 'Dashboard', exact: true })
}

/**
 * Opens the app against the stub and waits for the dashboard.
 *
 * By default it loads the page twice, the way a returning user arrives: the
 * session is already stored when the page loads, so the persisted stores start
 * on the settings backend. `firstVisitOnly` loads it once, the way a new
 * visitor arrives: the stores start in localStorage and switch to the settings
 * store when the session lands. shell.spec.ts covers a document created in
 * that window.
 */
export async function openApp(
  page: Page,
  options: { firstVisitOnly?: boolean } = {}
): Promise<void> {
  await page.goto('/')
  await expect(dashboardHeading(page)).toBeVisible({ timeout: 120_000 })
  if (!options.firstVisitOnly) {
    await page.waitForFunction(() => Boolean(localStorage.getItem('ddoc.access_token')))
    await page.reload()
    await expect(dashboardHeading(page)).toBeVisible({ timeout: 120_000 })
  }
  await expectNotBlank(page)
}

/** The shell rendered something a person can see, and no sign-in wall. */
export async function expectNotBlank(page: Page): Promise<void> {
  await expect(page.getByText('Sign-in required')).toHaveCount(0)
  await expect(page.locator('#app-splash')).toBeHidden()
  const root = page.locator('#app-body-wrapper')
  await expect(root).toBeVisible()
  await expect
    .poll(async () => (await root.innerText()).trim().length, { message: 'app root has text' })
    .toBeGreaterThan(20)
}

/** Clicks one of the dashboard's "create" tiles. */
export async function createFromDashboard(page: Page, kind: DocumentKind): Promise<void> {
  await page.getByRole('button', { name: kind, exact: true }).first().click()
}

/** The rich-text editor of the active document. */
export function textEditor(page: Page): Locator {
  return page.locator('.tiptap.ProseMirror[contenteditable="true"]').first()
}

/** Creates a text document and returns its editor, focused and empty. */
export async function newTextDocument(page: Page): Promise<Locator> {
  await openApp(page)
  await createFromDashboard(page, 'Document')
  const editor = textEditor(page)
  await expect(editor).toBeVisible({ timeout: 60_000 })
  await editor.click()
  await expect(editor).toBeFocused()
  return editor
}

/**
 * Letters and digits no earlier test has used. The stub's drive outlives a
 * test (and a retry), so text a test waits for on disk, and variables in the
 * "All my files" scope, must be its own.
 */
export function uniqueToken(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Waits until the list of open documents has been persisted to the settings
 * backend with at least one entry. The web client persists UI state in the
 * stub's settings store (a flat JSON object beside the drive), and only once a
 * session exists: a non-empty list here means the session arrived, the stores
 * switched from localStorage to settings, and the open document survived that
 * switch rather than being dropped by an empty re-read.
 */
export async function expectOpenDocumentPersisted(): Promise<void> {
  const openDocumentCount = (): number => {
    let store: Record<string, unknown>
    try {
      store = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    } catch {
      return 0
    }
    const entry = Object.entries(store).find(([key]) => key.endsWith('documentEditors.store.json'))
    return Array.isArray(entry?.[1]) ? (entry![1] as unknown[]).length : 0
  }
  await expect
    .poll(openDocumentCount, {
      message: 'the open-document list is saved to the settings store',
      timeout: 30_000
    })
    .toBeGreaterThan(0)
}

/**
 * The open-document list persisted to the settings store, serialized back to a
 * string, or '' when none is saved yet. Used to assert what did (and did not)
 * reach the account's server-side preferences.
 */
export function savedOpenDocumentsText(): string {
  let store: Record<string, unknown>
  try {
    store = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return ''
  }
  const entry = Object.entries(store).find(([key]) => key.endsWith('documentEditors.store.json'))
  return entry ? JSON.stringify(entry[1]) : ''
}

/** Types text one key at a time, the way a person does (the @ menu reacts per key). */
export async function typeKeys(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 40 })
}

/** The @ variable menu. */
export function variableMenu(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Insert a variable' })
}

/**
 * The menu's "Create "@name"" row. The name is wrapped in Unicode isolates
 * (U+2068 ... U+2069) so it reads the right way in right-to-left text.
 */
export function createOption(page: Page, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return variableMenu(page).getByRole('option', {
    name: new RegExp(`Create "@\u2068?${escaped}\u2069?"`)
  })
}

/**
 * From an open @ menu, creates `name = value` with the "Create" row and inserts
 * it. `scope` picks the scope buttons ("This document" or "All my files").
 */
export async function createVariableFromMenu(
  page: Page,
  value: string,
  options: { name?: string; scope?: 'This document' | 'All my files' } = {}
): Promise<void> {
  const menu = variableMenu(page)
  await expect(menu).toBeVisible()
  await menu.getByRole('option', { name: /Create "@|New variable/ }).click()
  if (options.name) await menu.getByLabel('Name').fill(options.name)
  await menu.getByLabel('Value').fill(value)
  if (options.scope) await menu.getByRole('button', { name: options.scope }).click()
  await menu.getByRole('button', { name: 'Create and insert' }).click()
  await expect(menu).toBeHidden()
}

/** Every index.html of a document on the stub's drive (home/<id>/<name>/index.html). */
function savedDocuments(): string[] {
  const root = path.join(STUB_ROOT, 'home')
  const files: string[] = []
  for (const id of readdirSync(root)) {
    const dir = path.join(root, id)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, 'index.html')
      if (existsSync(file)) files.push(file)
    }
  }
  return files
}

/**
 * Waits until a document saved through the stub contains `text`: the drive is
 * an ordinary directory, so the test reads what the app wrote.
 */
export async function expectSavedToDisk(text: string): Promise<void> {
  await expect
    .poll(() => savedDocuments().some((file) => readFileSync(file, 'utf8').includes(text)), {
      message: `a document on the drive contains "${text}"`,
      timeout: 30_000
    })
    .toBe(true)
}
