/**
 * Screenshot comparison, on terms that keep it honest.
 *
 * Baselines are only valid in the environment they were made in: fonts,
 * anti-aliasing and GPU fallbacks differ between machines, and a baseline
 * made on a laptop fails on CI for reasons that have nothing to do with the
 * app. So:
 *   - comparisons run only with E2E_VISUAL=1, which CI sets inside the
 *     official Playwright image (mcr.microsoft.com/playwright:v<version>-noble);
 *   - a missing baseline skips the test with a message saying how to make
 *     one, rather than writing it silently (updateSnapshots is 'none');
 *   - baselines are made with `npm run test:e2e:update-snapshots` inside that
 *     same image, or by the workflow's `update_snapshots` input, which uploads
 *     them as an artifact to commit. See tests/e2e/README.md.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { VISUAL } from './env'

export function requireVisualEnvironment(): void {
  test.skip(
    !VISUAL,
    'Screenshot comparisons only run where their baselines were made: the Playwright Docker ' +
      'image, with E2E_VISUAL=1 (CI sets both). See tests/e2e/README.md.'
  )
}

export async function expectScreenshot(
  target: Page | Locator,
  name: string,
  options: { mask?: Locator[]; clip?: { x: number; y: number; width: number; height: number } } = {}
): Promise<void> {
  const info = test.info()
  const baseline = info.snapshotPath(name, { kind: 'screenshot' })
  if (!existsSync(baseline) && info.config.updateSnapshots === 'none') {
    test.skip(
      true,
      `No baseline for ${name} (${baseline}). Create it inside the Playwright image with ` +
        '`npm run test:e2e:update-snapshots`, or run the "E2E web" workflow with ' +
        'update_snapshots=true and commit the files from its artifact.'
    )
  }
  await expect(target).toHaveScreenshot(name, {
    mask: options.mask,
    clip: options.clip,
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
    caret: 'hide'
  })
}
