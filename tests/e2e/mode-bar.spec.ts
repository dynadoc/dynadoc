/**
 * The editor mode bar (top right of a text document).
 *
 * Guards:
 *   - the Editing / Suggesting / Viewing menu: it opens, lists the three
 *     modes, and the button says which one is current;
 *   - Suggesting really suggests: typed text becomes an insertion mark, where
 *     the bar used to say one thing while the editor did another;
 *   - the @ Variables switch announces its state through aria-checked.
 */
import { test, expect } from './support/fixtures'
import { newTextDocument, typeKeys } from './support/app'

test('the mode menu switches to Suggesting and typing becomes a suggestion', async ({ page }) => {
  const editor = await newTextDocument(page)
  await typeKeys(page, 'Texte initial.')

  const modeButton = page.getByRole('button', { name: 'Mode: Editing' })
  await expect(modeButton).toBeVisible()
  await expect(modeButton).toHaveAttribute('aria-expanded', 'false')
  await modeButton.click()
  await expect(modeButton).toHaveAttribute('aria-expanded', 'true')

  const menu = page.getByRole('menu', { name: 'Editing mode' })
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitemradio')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('Editing')
  await expect(items.nth(1)).toContainText('Suggesting')
  await expect(items.nth(2)).toContainText('Viewing')
  await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true')

  await items.nth(1).click()
  await expect(menu).toBeHidden()
  await expect(page.getByRole('button', { name: 'Mode: Suggesting' })).toBeVisible()

  await editor.click()
  await page.keyboard.press('End')
  await typeKeys(page, ' Ajout suggéré')
  const insertion = editor.locator('span[data-suggestion][data-mode="insert"]')
  await expect(insertion.first()).toBeVisible()
  // One mark per keystroke today; what matters is that the typed text is marked.
  await expect
    .poll(async () => (await insertion.allTextContents()).join(''))
    .toContain('Ajout suggéré')
  // What was there before is not a suggestion.
  await expect(insertion.filter({ hasText: 'Texte initial' })).toHaveCount(0)
})

test('the @ Variables switch toggles aria-checked', async ({ page }) => {
  await newTextDocument(page)
  const toggle = page.getByRole('switch', { name: 'Variables' }).filter({ visible: true })
  await expect(toggle).toHaveCount(1)
  const before = await toggle.getAttribute('aria-checked')
  expect(['true', 'false']).toContain(before)
  const after = before === 'true' ? 'false' : 'true'

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', after)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', before as string)
})
