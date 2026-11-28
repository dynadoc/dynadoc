/**
 * The web shell boots against the stub: the dashboard shows, nobody is asked
 * to sign in, nothing throws. The guard (support/fixtures.ts) fails the test
 * on any page error, unexpected console error or failed stub call.
 */
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  dashboardHeading,
  expectOpenDocumentPersisted,
  openApp,
  savedOpenDocumentsText,
  textEditor,
  uniqueToken
} from './support/app'

test('the app loads against the stub and shows the dashboard', async ({ page }) => {
  await openApp(page, { firstVisitOnly: true })
  await expect(dashboardHeading(page)).toBeVisible()
  for (const kind of ['Document', 'Spreadsheet', 'Presentation', 'Design']) {
    await expect(page.getByRole('button', { name: kind, exact: true }).first()).toBeVisible()
  }
  // The session comes from the stub: a local user, not the guest mode that
  // never reaches the stub at all.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('ddoc.access_token')))
    .toBeTruthy()
})

test('a returning user sees the dashboard again after a reload', async ({ page }) => {
  await openApp(page)
  await expect(dashboardHeading(page)).toBeVisible()
})

test('a document created on the very first visit stays open', async ({ page }) => {
  await openApp(page, { firstVisitOnly: true })
  await createFromDashboard(page, 'Document')
  const editor = textEditor(page)
  await expect(editor).toBeVisible({ timeout: 60_000 })

  // The session arrives on the first visit without a reload, which switches the
  // persisted stores from localStorage to the settings backend. Wait for that
  // switch to persist the open-document list, then confirm the document did not
  // close behind it (the regression dropped it from an empty re-read).
  await expectOpenDocumentPersisted()
  await expect(editor).toBeVisible()
})

test('the signed-out open-document list never leaks into a fresh account', async ({ page }) => {
  const guestMarker = `guestleftover${uniqueToken()}`
  // What a visitor leaves behind before signing in: an open-document list saved
  // in localStorage while no session exists. The key and shape match what the
  // web client persists for open documents (ddoc.store:<fileName>, a
  // DocumentEditorModel list). addInitScript runs before any app code, so the
  // stores load this on the first visit, exactly as a real guest's would.
  const seed = [
    {
      uuid: guestMarker,
      isActive: false,
      document: {
        uuid: guestMarker,
        path: `/drive/home/${guestMarker}/${guestMarker}/index.html`,
        name: guestMarker,
        extension: '.html',
        openMode: 'read',
        info: {},
        config: {}
      }
    }
  ]
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    ['ddoc.store:/drive/documentEditors.store.json', JSON.stringify(seed)] as const
  )

  await openApp(page, { firstVisitOnly: true })
  await createFromDashboard(page, 'Document')
  await expect(textEditor(page)).toBeVisible({ timeout: 60_000 })

  // The session arrived and the stores switched to the settings backend. The
  // list saved there must hold the just-created document (non-empty) and carry
  // nothing from the signed-out session: writing the guest list into the
  // account is the leak the backend switch exists to prevent.
  await expectOpenDocumentPersisted()
  await expect
    .poll(savedOpenDocumentsText, {
      message: 'the signed-out document did not leak into the account',
      timeout: 30_000
    })
    .not.toContain(guestMarker)
})
