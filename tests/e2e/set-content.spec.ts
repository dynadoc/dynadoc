/**
 * editor.commands.setContent() on the app's own editor.
 *
 * Guards dynadoc#93: CustomHtmlStyleExtension overrides setContent to keep
 * <style> blocks, and its override called itself, so every setContent threw
 * "Maximum call stack size exceeded". The smoke suite checks the extension in
 * a headless editor; this checks it in the app, with every extension loaded.
 *
 * There is no UI path that calls setContent with arbitrary HTML, so the test
 * reaches the editor the app already created through its DOM node: Tiptap
 * itself sets `element.editor` on the editor's root. Nothing is added to the
 * app for the test.
 */
import { test, expect } from './support/fixtures'
import { expectSavedToDisk, newTextDocument, typeKeys, uniqueToken } from './support/app'

/** The Tiptap editor its root element carries, as far as this test uses it. */
type WithEditor = HTMLElement & {
  editor?: {
    commands: {
      setContent: (content: string, options?: { emitUpdate?: boolean }) => boolean
      undo: () => boolean
    }
  }
}

test('setContent replaces the document without throwing and can be undone', async ({ page }) => {
  const editor = await newTextDocument(page)
  // Unique, so the save waited for below is this document's.
  const original = `Texte original ${uniqueToken()}`
  await typeKeys(page, original)
  await expect(editor).toContainText(original)
  // Saved means the typing is its own undo step: the collaborative undo
  // manager merges changes less than half a second apart into one.
  await expectSavedToDisk(original)

  const result = await editor.evaluate((element) => {
    const instance = (element as WithEditor).editor
    if (!instance) return { reached: false, error: '' }
    try {
      instance.commands.setContent(
        '<style>.e2e-note { color: rgb(200, 0, 0); }</style><p class="e2e-note">Contenu remplacé</p>',
        { emitUpdate: true }
      )
      return { reached: true, error: '' }
    } catch (error) {
      return { reached: true, error: String(error) }
    }
  })
  test.skip(!result.reached, 'the editor instance is not reachable from its DOM node')
  expect(result.error).toBe('')

  await expect(editor).toContainText('Contenu remplacé')
  await expect(editor).not.toContainText(original)

  // One undo step, through the same editor. Neither UI path can be used here
  // today: Ctrl+Z undoes twice (see the fixme below) and the title bar's Undo
  // button stays disabled ("Nothing to undo") while the editor has history.
  const undone = await editor.evaluate((element) =>
    Boolean((element as WithEditor).editor?.commands.undo())
  )
  expect(undone).toBe(true)
  await expect(editor).toContainText(original)
  await expect(editor).not.toContainText('Contenu remplacé')
})

test('Ctrl+Z in the editor undoes one step', async ({ page }) => {
  test.fixme(
    true,
    'Known bug: Ctrl+Z is handled twice, by the editor keymap and by the window-level ' +
      'shortcut in LeftQuickAccessToolBar.svelte, which does not check event.defaultPrevented. ' +
      'One keystroke undoes two steps.'
  )
  const editor = await newTextDocument(page)
  const first = `Premier ${uniqueToken()}`
  await typeKeys(page, first)
  await expectSavedToDisk(first)
  await typeKeys(page, ' second')
  await expectSavedToDisk(`${first} second`)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor).not.toContainText('second')
  await expect(editor).toContainText(first)
})
