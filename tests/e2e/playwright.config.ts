/**
 * Playwright config for the web e2e suite. See tests/e2e/README.md.
 *
 * Two servers are started for the run:
 *   - the stub bridge on STUB_PORT (7071), with a fresh drive root;
 *   - the web app on WEB_PORT (4180): the production bundle built by
 *     `build:web:e2e` and served by `vite preview`, whose `/api` proxy forwards
 *     to the stub (see vite.e2e.config.mts for why it goes through a proxy).
 *
 * The bundle is built once per run unless E2E_SKIP_BUILD=1 (CI builds it in
 * its own step). E2E_SERVER=dev serves the sources with vite dev instead, for
 * iterating on a spec without rebuilding.
 */
import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { BASE_URL, SERVER_MODE, STUB_PORT, STUB_ROOT, WEB_PORT } from './support/env'

const CI = Boolean(process.env.CI)
const repoRoot = path.resolve(__dirname, '..', '..')
const viteConfig = 'tests/e2e/vite.e2e.config.mts'

const webCommand =
  SERVER_MODE === 'dev'
    ? `npx vite --config ${viteConfig}`
    : process.env.E2E_SKIP_BUILD === '1'
      ? `npx vite preview --config ${viteConfig}`
      : `npm run build:web:e2e && npx vite preview --config ${viteConfig}`

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: path.join(repoRoot, 'test-results'),
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  // One worker: the specs share one stub, and its UI settings store is reset
  // before each test. The app is heavy enough that parallel browsers on a CI
  // runner slow every test down more than they gain.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' }
  },
  // Baselines are only written on request (test:e2e:update-snapshots), never
  // as a side effect of a run on a machine whose fonts differ from CI's.
  updateSnapshots: 'none',
  reporter: CI
    ? [
        ['list'],
        ['github'],
        ['html', { outputFolder: path.join(repoRoot, 'playwright-report'), open: 'never' }],
        ['json', { outputFile: path.join(repoRoot, 'test-results', 'results.json') }]
      ]
    : [
        ['list'],
        ['html', { outputFolder: path.join(repoRoot, 'playwright-report'), open: 'never' }]
      ],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    actionTimeout: 20_000,
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
      testIgnore: ['**/design.spec.ts']
    },
    {
      // The Design canvas must still show content where WebGL is unavailable,
      // so its spec runs in a browser that has none.
      name: 'chromium-no-webgl',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 900 },
        launchOptions: { args: ['--disable-webgl', '--disable-webgl2', '--disable-gpu'] }
      },
      testMatch: '**/design.spec.ts'
    }
  ],
  webServer: [
    {
      command: 'node tests/e2e/start-stub.mjs',
      cwd: repoRoot,
      port: STUB_PORT,
      // Never reuse: a stub left running has another drive root, and the
      // fixtures reset the settings file of this one.
      reuseExistingServer: false,
      timeout: 30_000,
      // The stub logs every refusal on stderr; the guard reports the ones that matter.
      stdout: 'ignore',
      stderr: 'ignore',
      env: { E2E_STUB_PORT: String(STUB_PORT), E2E_STUB_ROOT: STUB_ROOT }
    },
    {
      command: webCommand,
      cwd: repoRoot,
      url: BASE_URL,
      reuseExistingServer: !CI,
      // A cold production build of the renderer takes several minutes.
      timeout: 15 * 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        E2E_STUB_PORT: String(STUB_PORT),
        E2E_WEB_PORT: String(WEB_PORT),
        NODE_OPTIONS: '--max-old-space-size=8192'
      }
    }
  ]
})
