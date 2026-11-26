/**
 * Variables in spreadsheet cells.
 *
 * Guards:
 *   - the closing-dropdown bug: the @ menu in a cell closed after a key or
 *     two, so a name could not be typed out; it must stay open after every key;
 *   - picking a variable puts its value in the cell;
 *   - a variable inside a formula (`=B4*@taux`) computes.
 */
import { test, expect } from './support/fixtures'
import { createFromDashboard, createVariableFromMenu, openApp, variableMenu } from './support/app'
import { cellInput, enterCell, expectCellSum, selectCell, waitForSheet } from './support/sheet'

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await createFromDashboard(page, 'Spreadsheet')
  await waitForSheet(page)
})

test('the @ menu stays open after every key in a cell, and the pick shows the value', async ({
  page
}) => {
  const menu = variableMenu(page)

  // A variable to pick, created from a cell's own @ menu.
  await selectCell(page, 'D1')
  await page.keyboard.type('@client', { delay: 40 })
  await createVariableFromMenu(page, 'ACME SARL')
  await page.keyboard.press('Enter')

  await selectCell(page, 'B2')
  let typed = ''
  for (const key of '@cli') {
    await page.keyboard.type(key)
    typed += key
    await expect(cellInput(page)).toHaveText(typed)
    await expect(menu, `the menu is open after typing "${typed}"`).toBeVisible()
  }
  const client = menu.getByRole('option', { name: /client/ })
  await expect(client).toBeVisible()
  await client.click()
  await expect(menu).toBeHidden()
  await page.keyboard.press('Enter')

  // The cell holds the value, not the name: LEN("ACME SARL") is 9, LEN("@client") 7.
  await enterCell(page, 'E2', '=LEN(B2)')
  await expectCellSum(page, 'E2', '9')
})

test('a variable inside a formula computes', async ({ page }) => {
  await selectCell(page, 'D1')
  await page.keyboard.type('@taux', { delay: 40 })
  await createVariableFromMenu(page, '0.2')
  await page.keyboard.press('Enter')

  await enterCell(page, 'B2', '100')
  await selectCell(page, 'C2')
  await page.keyboard.type('=B2*@tau', { delay: 40 })
  const taux = variableMenu(page).getByRole('option', { name: /taux/ }).first()
  await expect(taux).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(cellInput(page)).toHaveText('=B2*@taux')
  await page.keyboard.press('Enter')

  await expectCellSum(page, 'C2', '20')
})
