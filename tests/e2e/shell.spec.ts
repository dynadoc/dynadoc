/**
 * The web shell boots against the stub: the dashboard shows, nobody is asked
 * to sign in, nothing throws. The guard (support/fixtures.ts) fails the test
 * on any page error, unexpected console error or failed stub call.
 */
import { test, expect } from './support/fixtures'
import { createFromDashboard, dashboardHeading, openApp, textEditor } from './support/app'

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
  test.fixme(
    true,
    'Known bug, web client: on a first visit the persisted stores start in localStorage, the ' +
      'session then arrives without a reload, and the first save switches them to the settings ' +
      'store and re-reads them from there. The open-tab list comes back empty and the new ' +
      'document closes a moment after it opens. See storePersistence.ts (loadedFrom !== backend).'
  )
  await openApp(page, { firstVisitOnly: true })
  await createFromDashboard(page, 'Document')
  await expect(textEditor(page)).toBeVisible({ timeout: 60_000 })
})
