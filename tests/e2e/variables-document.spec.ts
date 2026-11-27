/**
 * Variables in a text document, through the @ menu, typed key by key.
 *
 * Guards:
 *   - the @ menu opening on "@" and filtering as the name is typed;
 *   - creating a variable from the menu's "Create" row and the chip showing
 *     its value;
 *   - editing a variable through the menu's pencil: every chip of that
 *     variable follows;
 *   - the date bug: a value that merely looks like a date ("Lyon 69000",
 *     "Rue 12") was parsed as one and shown as a formatted date.
 */
import { test, expect } from './support/fixtures'
import {
  createOption,
  createVariableFromMenu,
  newTextDocument,
  typeKeys,
  variableMenu
} from './support/app'

test('create, show and edit variables from the @ menu', async ({ page }) => {
  const editor = await newTextDocument(page)
  const menu = variableMenu(page)
  const chips = editor.locator('span[data-variable]')

  await typeKeys(page, 'Contrat pour ')
  await expect(menu).toBeHidden()
  await typeKeys(page, '@')
  await expect(menu).toBeVisible()
  await typeKeys(page, 'c')
  await expect(createOption(page, 'c')).toBeVisible()
  await typeKeys(page, 'l')
  // The menu filters on what is typed after the @: the create row follows it.
  await expect(createOption(page, 'cl')).toBeVisible()
  await expect(createOption(page, 'c')).toHaveCount(0)

  await createVariableFromMenu(page, 'ACME SARL', { name: 'client' })
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveText('ACME SARL')
  await expect(editor).toContainText('Contrat pour ACME SARL')

  // A second chip of the same variable, picked from the list this time.
  await typeKeys(page, ' et @cli')
  await expect(menu.getByRole('option', { name: /@?client/ }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(chips).toHaveCount(2)

  // Edit through the pencil: both chips follow.
  await typeKeys(page, ' @cli')
  await menu.getByRole('button', { name: 'Edit "@client"' }).click()
  await menu.getByLabel('Value').fill('ACME Group')
  await menu.getByRole('button', { name: 'Update and insert' }).click()
  await expect(menu).toBeHidden()
  await expect(chips).toHaveCount(3)
  await expect(chips).toHaveText(['ACME Group', 'ACME Group', 'ACME Group'])

  // The date bug: these values must stay as typed.
  await typeKeys(page, ' à @ville')
  await createVariableFromMenu(page, 'Lyon 69000')
  await expect(chips.last()).toHaveText('Lyon 69000')

  await typeKeys(page, ', @adresse')
  await createVariableFromMenu(page, 'Rue 12')
  await expect(chips.last()).toHaveText('Rue 12')

  await expect(editor).toContainText('Lyon 69000')
  await expect(editor).toContainText('Rue 12')
})
