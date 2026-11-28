/**
 * Presentations (Konva slides).
 *
 * Guards:
 *   - adding a slide with a layout from "New slide";
 *   - editing a placeholder: a double-click opens the slide's text editor and
 *     typing goes into the title;
 *   - variables in slides: "@" in a text box opens the @ menu, and a created
 *     variable shows its value in the slide;
 *   - the slideshow opens one window on the web (#/presentation), which shows
 *     the slides, moves with the arrow keys and ends on Escape (#150: it
 *     threw on window.presentationAPI before the driver was installed, and
 *     the click opened two windows).
 *
 * Skipped, with the reason below: the .pptx export/re-import (no download
 * path on the web build against the stub).
 */
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  createVariableFromMenu,
  openApp,
  typeKeys,
  variableMenu
} from './support/app'
import type { Locator, Page } from '@playwright/test'

// Slides are laid out at 1280 x 720 and drawn scaled into their stage.
const SLIDE_WIDTH = 1280

/** Double-clicks a point given in slide pixels on a slide's stage. */
async function dblclickSlide(page: Page, stage: Locator, x: number, y: number): Promise<void> {
  await stage.scrollIntoViewIfNeeded()
  const box = await stage.boundingBox()
  if (!box) throw new Error('the slide has no box')
  const scale = box.width / SLIDE_WIDTH
  await page.mouse.dblclick(box.x + x * scale, box.y + y * scale)
}

/**
 * The slides' own text editors: every Tiptap editor but the document's (the
 * paginated one the deck lives in).
 */
function slideEditors(page: Page): Locator {
  return page.locator('.tiptap.ProseMirror:not(.rm-with-pagination)')
}

/** The slide editor a double-click just opened, once it has the focus. */
function focusedSlideEditor(page: Page): Locator {
  return page.locator('.tiptap.ProseMirror-focused:not(.rm-with-pagination)')
}

async function newDeckWithContentSlide(page: Page): Promise<Locator> {
  await openApp(page)
  await createFromDashboard(page, 'Presentation')
  const stages = page.locator('.konvajs-content')
  await expect(stages.first()).toBeVisible({ timeout: 60_000 })
  const slides = page.getByRole('complementary', { name: 'Slides' }).locator('li')
  await expect(slides).toHaveCount(1)

  await page.getByTitle('New slide').click()
  await page.getByRole('menuitem', { name: 'Title and content' }).click()
  await expect(slides).toHaveCount(2)
  await expect(stages).toHaveCount(2)
  return stages.last()
}

test('add a slide with a layout, type a title and insert @client', async ({ page }) => {
  const stage = await newDeckWithContentSlide(page)

  // Title placeholder of "Title and content": x 64..1216, y 40..150.
  await dblclickSlide(page, stage, 640, 95)
  await expect(focusedSlideEditor(page)).toBeVisible()
  await typeKeys(page, 'Mon titre')
  await expect(slideEditors(page).locator('h1', { hasText: 'Mon titre' })).toHaveCount(1)

  // Body placeholder: x 64..1216, y 170..670.
  await dblclickSlide(page, stage, 640, 300)
  await expect(focusedSlideEditor(page).filter({ hasNotText: 'Mon titre' })).toBeVisible()
  await typeKeys(page, 'Client : @client')
  await expect(variableMenu(page)).toBeVisible()
  await createVariableFromMenu(page, 'ACME SARL')
  const body = slideEditors(page).filter({ hasText: 'Client :' })
  await expect(body).toHaveCount(1)
  const chip = body.locator('span[data-variable="client"]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('ACME SARL')
})

test('the slideshow opens one window, shows the slides and ends on Escape (#150)', async ({
  page,
  context
}) => {
  const stage = await newDeckWithContentSlide(page)
  // Title placeholder of "Title and content": x 64..1216, y 40..150.
  await dblclickSlide(page, stage, 640, 95)
  await expect(focusedSlideEditor(page)).toBeVisible()
  await typeKeys(page, 'Mon titre')
  await expect(slideEditors(page).locator('h1', { hasText: 'Mon titre' })).toHaveCount(1)

  const opened: Page[] = []
  context.on('page', (opener) => opened.push(opener))
  const popup = context.waitForEvent('page')
  await page.getByTitle('Present from the first slide').click()
  const show = await popup
  await expect.poll(() => show.url()).toContain('#/presentation')
  // The show draws the deck (page errors there fail the test in the guard),
  // from the first slide; the arrow key moves to the second, with the title.
  await expect(show.locator('.slide-show-deck').first()).toBeAttached({ timeout: 30_000 })
  await show.keyboard.press('ArrowRight')
  await expect(show.getByText('Mon titre')).toBeVisible()
  // One window: the popup handle is kept, no "blocked" fallback opens a tab.
  expect(opened).toHaveLength(1)

  const closed = show.waitForEvent('close')
  // keydown alone: the window is gone before a keyup could reach it.
  await show.keyboard.down('Escape')
  await closed
})

test('export to .pptx and import it back', async () => {
  test.skip(
    true,
    'Not available on the web build against the stub: "Export to PowerPoint" asks the bridge ' +
      'for a save location (dialog:saveFile) and writes the file through it. The stub refuses ' +
      'dialog channels by design and the web build offers no browser download for it, so ' +
      'there is no download event to catch. The .pptx writer and reader are covered by ' +
      'tests/smoke/pptx.test.mjs.'
  )
})
