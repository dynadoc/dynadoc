/**
 * The Design canvas (CanvasKit), in a browser without WebGL.
 *
 * This file runs in the `chromium-no-webgl` project only (see
 * playwright.config.ts): Chromium is launched with --disable-webgl,
 * --disable-webgl2 and --disable-gpu.
 *
 * Guards:
 *   - #101: WebGL was the only drawing surface, and its exception left the
 *     canvas blank. Without WebGL the canvas must fall back to CanvasKit's
 *     software surface and draw;
 *   - #99: the tool bar looked the canvas up by the wrong key and every tool
 *     click was a no-op. The rectangle tool must create a shape, listed in
 *     the Layers panel;
 *   - #100: the right-click menu template carried its click handlers, so
 *     cloning it threw DataCloneError and no menu opened. On the web the menu
 *     goes to the in-app context menu, without any clone.
 */
import { test, expect } from './support/fixtures'
import { createFromDashboard, openApp } from './support/app'
import { STUB_ROOT } from './support/env'
import type { Locator, Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import path from 'node:path'

// Known bug: every Design document keeps its shapes in the same file,
// `assets/design/design.json` at the root of the drive, so a new design opens
// with the shapes of every design made before it (see the fixme below). Each
// test starts from no design file, so its layer count means what it says.
test.beforeEach(() => {
  rmSync(path.join(STUB_ROOT, 'assets', 'design'), { recursive: true, force: true })
})

/** Opaque pixels of the canvas in a CSS-pixel rectangle. */
async function inkIn(
  canvas: Locator,
  area: { x: number; y: number; width: number; height: number }
): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement, rect) => {
    const context = element.getContext('2d')
    if (!context) return -1
    const scale = element.width / element.getBoundingClientRect().width
    const x = Math.round(rect.x * scale)
    const y = Math.round(rect.y * scale)
    const data = context.getImageData(
      x,
      y,
      Math.max(1, Math.min(element.width - x, Math.round(rect.width * scale))),
      Math.max(1, Math.min(element.height - y, Math.round(rect.height * scale)))
    ).data
    let opaque = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++
    return opaque
  }, area)
}

async function openDesign(page: Page): Promise<Locator> {
  await openApp(page)
  await createFromDashboard(page, 'Design')
  const canvas = page.locator('canvas.skia-canvas').first()
  await expect(canvas).toBeVisible({ timeout: 60_000 })
  // The browser really has no WebGL: this is the path under test.
  expect(
    await page.evaluate(() => {
      const probe = document.createElement('canvas')
      return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'))
    })
  ).toBe(false)
  return canvas
}

async function drawRectangle(page: Page, canvas: Locator): Promise<void> {
  // A click on the canvas makes it the active node view, which shows its tools.
  await canvas.click({ position: { x: 40, y: 40 } })
  await page
    .getByTitle(/^Rectangle — /)
    .filter({ visible: true })
    .first()
    .click()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('the canvas has no box')
  await page.mouse.move(box.x + 150, box.y + 150)
  await page.mouse.down()
  await page.mouse.move(box.x + 350, box.y + 300, { steps: 8 })
  await page.mouse.up()
}

test('without WebGL the canvas draws, and the rectangle tool creates a layer', async ({ page }) => {
  const canvas = await openDesign(page)
  const rows = page.locator('.adobe-layer-row')
  await expect(rows).toHaveCount(0)
  const whole = { x: 0, y: 0, width: 4000, height: 4000 }
  const before = await inkIn(canvas, whole)
  expect(before, 'the canvas has a 2D (software) surface').toBeGreaterThanOrEqual(0)

  await drawRectangle(page, canvas)

  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Rectangle')
  // Drawn, not just listed: the canvas now has more ink than before.
  await expect.poll(() => inkIn(canvas, whole)).toBeGreaterThan(before)
  await expect(page.getByText(/WebGL is not available|surface could not be created/)).toHaveCount(0)
})

test('right-click asks for the in-app menu, without DataCloneError', async ({ page }) => {
  const canvas = await openDesign(page)
  await expect(page.locator('.adobe-layer-row')).toHaveCount(0)
  await drawRectangle(page, canvas)
  await expect(page.locator('.adobe-layer-row')).toHaveCount(1)

  // The web path hands the items to the in-app menu with a DOM event. Listen
  // for it (an event listener, nothing exposed by the app).
  const requested = page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        window.addEventListener(
          'show-web-menu',
          (event) =>
            resolve(
              ((event as CustomEvent<Array<{ label: string }>>).detail || []).map(
                (item) => item.label
              )
            ),
          { once: true }
        )
      })
  )
  const box = await canvas.boundingBox()
  if (!box) throw new Error('the canvas has no box')
  await page.mouse.click(box.x + 250, box.y + 220, { button: 'right' })
  const labels = await requested
  // A right-click on the shape selects it, so the object entries come first.
  expect(labels.slice(0, 4)).toEqual(['Duplicate', 'Bring forward', 'Send backward', 'Delete'])
  expect(labels).toContain('Reset position')
  // Uncaught errors (DataCloneError among them) fail the test in the guard.
})

test('the in-app menu appears on right-click', async ({ page }) => {
  test.fixme(
    true,
    'Known bug, web: App.svelte keeps `_showContextMenu` in a plain `let` in a runes-mode ' +
      'component, so the show-web-menu handler sets it and nothing re-renders. The items ' +
      'are requested (see the test above) but no menu is ever drawn.'
  )
  const canvas = await openDesign(page)
  await drawRectangle(page, canvas)
  const box = await canvas.boundingBox()
  if (!box) throw new Error('the canvas has no box')
  await page.mouse.click(box.x + 250, box.y + 220, { button: 'right' })
  await expect(page.getByText('Bring forward', { exact: true })).toBeVisible()
})

test('a new design starts empty', async ({ page }) => {
  test.fixme(
    true,
    'Known bug: Design documents share one shape store, assets/design/design.json at the ' +
      'drive root, so a new design shows the shapes of earlier ones.'
  )
  const canvas = await openDesign(page)
  await drawRectangle(page, canvas)
  await expect(page.locator('.adobe-layer-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  await openDesign(page)
  await expect(page.locator('.adobe-layer-row')).toHaveCount(0)
})
