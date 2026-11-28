/**
 * Presentations (Konva slides).
 *
 * Guards:
 *   - adding a slide with a layout from "New slide";
 *   - editing a placeholder: a double-click opens the slide's text editor and
 *     typing goes into the title;
 *   - variables in slides: "@" in a text box opens the @ menu, and a created
 *     variable shows its value in the slide;
 *   - the slideshow opens its window on the web (#/presentation).
 *
 * Skipped, with reasons below: what the slideshow window shows (it crashes on
 * the web today), and the .pptx export/re-import (no download path on the web
 * build against the stub).
 */
import { test, expect } from './support/fixtures'
import {
  createFromDashboard,
  createVariableFromMenu,
  openApp,
  typeKeys,
  variableMenu
} from './support/app'
import { STUB_ROOT } from './support/env'
import type { Locator, Page } from '@playwright/test'
import { readdirSync } from 'node:fs'
import path from 'node:path'

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

test('a new deck keeps one file per slide in its own folder (#149)', async ({ page }) => {
  const slideFiles = (): string[] =>
    (readdirSync(STUB_ROOT, { recursive: true }) as string[])
      .map((entry) => entry.split(path.sep).join('/'))
      .filter((entry) => /(^|\/)assets\/slide\/[^/]+\.json$/.test(entry))
  const before = new Set(slideFiles())
  const created = (): string[] => slideFiles().filter((file) => !before.has(file))

  await newDeckWithContentSlide(page)
  // Two slides, two files, both in the new document's folder: before #149 on
  // the web they were all one `assets/slide/slide.json` at the drive root.
  await expect.poll(() => created().length).toBe(2)
  for (const file of created()) {
    expect(file).toMatch(/^home\/[^/]+\/[^/]+\/assets\/slide\/[^/]+\.json$/)
  }
  expect(new Set(created().map((file) => file.split('/').slice(0, 3).join('/'))).size).toBe(1)
})

test('the slideshow opens its window', async ({ page, context }) => {
  await newDeckWithContentSlide(page)
  const popup = context.waitForEvent('page')
  await page.getByTitle('Present from the first slide').click()
  const show = await popup
  await expect.poll(() => show.url()).toContain('#/presentation')
  await show.close()
})

test('the slideshow window shows the slides', async ({ page, context }) => {
  test.fixme(
    true,
    'Known bug, web: the #/presentation window throws "Cannot read properties of undefined ' +
      "(reading 'getInitialData')\" in PresentationWindow.svelte (window.presentationAPI is " +
      'not installed on that route) and stays blank.'
  )
  const stage = await newDeckWithContentSlide(page)
  await dblclickSlide(page, stage, 640, 95)
  await typeKeys(page, 'Mon titre')
  const popup = context.waitForEvent('page')
  await page.getByTitle('Present from the first slide').click()
  const show = await popup
  await expect(show.getByText('Mon titre')).toBeVisible()
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
