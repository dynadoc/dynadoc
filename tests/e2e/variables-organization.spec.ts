/**
 * Organization variables, shared through the bridge (here the stub), seen
 * from two browsers: two browser contexts, each with its own storage, on the
 * same stub.
 *
 * Guards:
 *   - a variable created with the Organization scope in one browser is
 *     offered by the other's @ menu, with the Org badge, and its chip shows
 *     the value;
 *   - an edit in one browser reaches the other's chip without a reload;
 *   - the bridge keeps who changed it and the value before;
 *   - when the other browser cannot read the bridge, its menu says the copy
 *     may be out of date, and a change it makes from that copy is refused
 *     (409) and shown as a conflict, both values side by side, until the
 *     user keeps one.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  createVariableFromMenu,
  newTextDocument,
  openApp,
  textEditor,
  typeKeys,
  uniqueToken,
  variableMenu
} from './support/app'
import { STUB_ROOT } from './support/env'

const ORG_STORE = `${STUB_ROOT}.org-variables.json`
const FAILURE_RULES = `${STUB_ROOT}.failures`

type StoredRecord = {
  value: { name: string; value: string }
  updatedBy: { id: string }
  previous: { value: { value: string } } | null
}

/** The organization variable called `name`, as the stub stores it. */
function stored(name: string): StoredRecord | null {
  try {
    const state = JSON.parse(readFileSync(ORG_STORE, 'utf8'))
    return (
      (Object.values(state.variables || {}) as StoredRecord[]).find(
        (record) => record.value?.name === name
      ) || null
    )
  } catch {
    return null
  }
}

/** A new text document in a page whose app is already open. */
async function newDocumentHere(page: Page): Promise<void> {
  await createFromDashboard(page, 'Document')
  const editor = textEditor(page)
  await expect(editor).toBeVisible({ timeout: 60_000 })
  await editor.click()
  await expect(editor).toBeFocused()
}

/**
 * The user comes back to the window: the app reads the organization scope
 * again on focus (it also does every few minutes, too slow to wait for).
 */
async function focusWindow(page: Page): Promise<void> {
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

/** Edits `@name` through the @ menu's pencil. */
async function editFromMenu(page: Page, name: string, value: string): Promise<void> {
  await typeKeys(page, ` @${name}`)
  const menu = variableMenu(page)
  await menu.getByRole('button', { name: `Edit "@${name}"` }).click()
  await menu.getByLabel('Value').fill(value)
  await menu.getByRole('button', { name: 'Update and insert' }).click()
  await expect(menu).toBeHidden()
}

test.afterEach(() => {
  rmSync(FAILURE_RULES, { force: true })
})

test('an organization variable changed in one browser shows in the other', async ({
  page,
  secondPage
}) => {
  test.setTimeout(6 * 60_000)
  const other = secondPage.page
  // Organization variables outlive the test: a name of its own, every run.
  const name = `${uniqueToken()}soc`

  // The second browser is open first, so the first one's open tabs (kept in
  // the stub's settings store) are not what it starts on.
  await openApp(other)
  const editor = await newTextDocument(page)
  await typeKeys(page, `Contrat pour @${name}`)
  await createVariableFromMenu(page, 'ACME SARL', { scope: 'Organization' })
  const chips = editor.locator(`span[data-variable="${name}"]`)
  await expect(chips).toHaveText(['ACME SARL'])
  await expect
    .poll(() => stored(name)?.value?.value, { message: 'the stub holds the variable' })
    .toBe('ACME SARL')

  // The other browser: the menu offers it, as an organization variable.
  await newDocumentHere(other)
  await typeKeys(other, `Client : @${name}`)
  const otherMenu = variableMenu(other)
  const row = otherMenu.getByRole('option', { name: new RegExp(`@?${name}`) }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('ACME SARL')
  await expect(row).toContainText('Org')
  await other.keyboard.press('Enter')
  await expect(otherMenu).toBeHidden()
  const otherChips = textEditor(other).locator(`span[data-variable="${name}"]`)
  await expect(otherChips).toHaveText(['ACME SARL'])

  // An edit in the first browser reaches the second without a reload.
  await page.bringToFront()
  await editFromMenu(page, name, 'ACME Group')
  await expect(chips).toHaveText(['ACME Group', 'ACME Group'])
  await expect
    .poll(() => stored(name)?.value?.value, { message: 'the edit reached the stub' })
    .toBe('ACME Group')
  await focusWindow(other)
  await expect(otherChips).toHaveText(['ACME Group'])

  // Who changed it and the value before travel with it.
  const record = stored(name)
  expect(record?.updatedBy?.id).toBe('local-stub')
  expect(record?.previous?.value?.value).toBe('ACME SARL')
})

test('a change made from a stale copy is shown as a conflict', async ({
  page,
  guard,
  secondPage
}) => {
  test.setTimeout(6 * 60_000)
  const other = secondPage.page
  const name = `${uniqueToken()}soc`
  const refused = {
    channel: 'vars:org:list',
    arg: /^$/,
    error: /no such file or directory/,
    why: 'this test makes the stub refuse vars:org:list, to show the copy going stale.'
  }
  const conflict = {
    channel: 'vars:org:set',
    arg: /^$/,
    error: /^conflict$/,
    why: 'the stale write this test makes on purpose: the bridge answers 409.'
  }
  for (const g of [guard, secondPage.guard]) {
    g.allowStubFailure(refused)
    g.allowStubFailure(conflict)
  }

  await openApp(other)
  await newTextDocument(page)
  await typeKeys(page, `@${name}`)
  await createVariableFromMenu(page, 'v1', { scope: 'Organization' })
  await expect.poll(() => stored(name)?.value?.value).toBe('v1')
  await newDocumentHere(other)
  await typeKeys(other, `@${name}`)
  await expect(variableMenu(other).getByRole('option', { name: new RegExp(name) })).toBeVisible()
  await other.keyboard.press('Escape')

  // From now on the bridge refuses to list: the second browser keeps its copy.
  writeFileSync(FAILURE_RULES, 'vars:org:list * refuse\n')
  await page.bringToFront()
  await editFromMenu(page, name, 'v2 from the first browser')
  await expect.poll(() => stored(name)?.value?.value).toBe('v2 from the first browser')

  // The second browser says its copy may be out of date...
  await focusWindow(other)
  await typeKeys(other, ` @${name}`)
  const menu = variableMenu(other)
  await expect(menu.getByRole('status')).toContainText('may be out of date')
  // ...and its change, made from that copy, is refused and shown as a conflict.
  await menu.getByRole('button', { name: `Edit "@${name}"` }).click()
  await menu.getByLabel('Value').fill('v3 from the second browser')
  await menu.getByRole('button', { name: 'Update and insert' }).click()
  const dialog = other.getByRole('dialog', { name: `Someone changed @${name}` })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('v2 from the first browser')
  await expect(dialog).toContainText('v3 from the second browser')
  // Nothing was overwritten while the user decides.
  expect(stored(name)?.value?.value).toBe('v2 from the first browser')

  await dialog.getByRole('button', { name: 'Keep mine' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => stored(name)?.value?.value).toBe('v3 from the second browser')
  expect(stored(name)?.previous?.value?.value).toBe('v2 from the first browser')
})
