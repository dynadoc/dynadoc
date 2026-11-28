# Web e2e suite

Playwright tests of the **web build**, run against the local stub bridge
(`tools/stub-bridge`). They replace the regression checks that used to be done
by hand: each spec drives the app the way a person does (clicks, keys typed
one at a time) and asserts what the person would see.

`open-timing.test.mjs` and `fixtures/` in this folder are an older, separate
check (puppeteer, desktop timing budget) and are not part of this suite.

## Run it

```sh
npm ci
npx playwright install chromium     # once; not needed inside the Playwright image
npm run test:e2e                    # builds the web app, then runs every spec
npm run test:e2e -- variables-sheet # one spec
npm run test:e2e:ui                 # Playwright's UI mode
```

What `npm run test:e2e` starts, and stops at the end:

| Server      | Port                   | What                                                                                                                                           |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| stub bridge | 7071 (`E2E_STUB_PORT`) | `start-stub.mjs`: a fresh drive in `tests/e2e/.stub-root/drive` (`E2E_STUB_ROOT`), UI settings seeded with the onboarding tours marked as seen |
| web app     | 4180 (`E2E_WEB_PORT`)  | `npm run build:web:e2e` (the production bundle, into `tests/e2e/.web-dist`), then `vite preview`                                               |

The stub runs on 7071 so a stub you keep on 7070 for development is left
alone. The renderer's Content Security Policy only allows `localhost:7070` on
the loopback interface, so the browser does not call the stub directly:
`vite.e2e.config.mts` builds with `VITE_API_URL` set to the preview server's
own origin, and the preview server proxies `/api` to the stub. The CSP is
tested exactly as shipped.

Useful variables:

- `E2E_SKIP_BUILD=1`: reuse the bundle already in `tests/e2e/.web-dist` (CI
  builds it in its own step).
- `E2E_SERVER=dev`: serve the sources with `vite` instead of a build. Much
  faster to iterate on a spec; the first load compiles for a minute. Locally,
  a server already listening on 4180 is reused.
- `E2E_VISUAL=1`: run the screenshot comparisons (see below).

The production build needs about 6 GB of memory (`NODE_OPTIONS` is set to
8 GB) and takes two to three minutes. A whole run takes about five more.

Reports: `playwright-report/` (HTML, `npx playwright show-report`) and
`test-results/` (traces and screenshots of failed tests,
`npx playwright show-trace <trace.zip>`).

## What every test checks, whatever it is about

`support/fixtures.ts` wraps every test (import `test` and `expect` from there):

- before the test, the stub's settings store is reset, so no test inherits
  the tabs another one left open, and the browser context starts without
  `ddoc.api_url` and `ddoc.web_auto_signin`;
- after it, the test fails on any uncaught page error, any file of the app
  that fails to load, any console error not in `ALLOWED_CONSOLE_ERRORS`, and
  any failed call to the stub that is not a
  refusal by design (`[dynadoc local stub] ... is not implemented`) or in
  `ALLOWED_STUB_FAILURES`. Every allow-list entry says why it is there;
  entries marked **KNOWN BUG** are real bugs listed so the rest of the suite
  can run, to be removed with the fix.

`openApp()` (`support/app.ts`) opens the app as a returning user and fails on
a blank screen: the splash must be gone, no "Sign-in required" card, and the
app root must show text.

## The specs

| Spec                         | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                    | Guards against                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.spec.ts`              | The app boots against the stub, the dashboard and its create tiles show, the session is the stub's local user, a reload brings the dashboard back.                                                                                                                                                                                                                                                                                 | A shell that does not start, a sign-in wall, the splash never leaving (svelte-i18n formatting before the locale was set, fixed alongside this suite). |
| `variables-document.spec.ts` | In a new text document, `Contrat pour @cl` typed key by key opens the @ menu on `@` and filters as letters come; "Create" makes `client = ACME SARL` and the chip shows it; editing through the pencil changes every chip to "ACME Group"; `ville = Lyon 69000` and `adresse = Rue 12` show as typed.                                                                                                                              | The date bug ("Lyon 69000" shown as a date); chips not following an edit.                                                                             |
| `variables-sheet.spec.ts`    | In a spreadsheet cell, the @ menu stays open after each of `@`, `c`, `l`, `i`; picking `client` puts "ACME SARL" in the cell (checked with `=LEN(B2)` = 9); `=B2*@taux` with `taux = 0.2` and B2 = 100 gives 20.                                                                                                                                                                                                                   | The closing-dropdown bug; variables in formulas.                                                                                                      |
| `mode-bar.spec.ts`           | The mode menu lists Editing / Suggesting / Viewing with the current one checked; in Suggesting, typed text becomes insertion marks and the existing text does not; the @ Variables switch flips `aria-checked` both ways.                                                                                                                                                                                                          | A bar that says one mode while the editor does another.                                                                                               |
| `rtl.spec.ts`                | In an RTL paragraph (ribbon "Paragraph direction RTL") the @ menu is fully in the window and hangs from the start side of the caret; with `<html dir="rtl">` a variable reads `@client` (the `@` is drawn left of the `c`); spreadsheet cells draw in an RTL page and the grid is `direction: ltr`.                                                                                                                                | The menu opening off screen over the text; `client@`; an empty grid.                                                                                  |
| `set-content.spec.ts`        | `setContent` on the app's own editor (reached through its DOM node, as Tiptap sets `element.editor`) does not throw, replaces the text, and one undo brings the text back.                                                                                                                                                                                                                                                         | dynadoc#93 (setContent recursing until "Maximum call stack size exceeded").                                                                           |
| `design.spec.ts`             | Runs in Chromium with WebGL disabled. The canvas has a software surface and draws; the rectangle tool creates a shape listed as "Rectangle" in Layers; a right-click requests the in-app menu with the object entries first, without DataCloneError.                                                                                                                                                                               | #101 (blank canvas without WebGL), #99 (tool clicks doing nothing), #100 (DataCloneError on right-click).                                             |
| `presentation.spec.ts`       | A new presentation gets a "Title and content" slide; double-clicking the title placeholder and typing fills the title; `@client` in the body opens the @ menu and the created variable shows "ACME SARL"; the slideshow window opens on `#/presentation`.                                                                                                                                                                          | Slide editing and variables in slides.                                                                                                                |
| `perf-variables.spec.ts`     | 20 variables in "All my files", then one updated 4 times: each update reaches every chip in under 5 s, makes fewer than 10 calls touching a `vars.json`, and no long task over 500 ms happens during the updates.                                                                                                                                                                                                                  | The vars.json read storm.                                                                                                                             |
| `xlsx-import.spec.ts`        | An .xlsx built with exceljs, imported from the dashboard into the spreadsheet viewer: the import report lists formulas kept, the defined name approximated and the chart lost; `=B1*TauxTVA` recalculates when B1 changes; the first save asks before overwriting, "Keep the original" leaves the file on the drive unchanged and offers a copy. The test plays the bridge's part of the upload (the stub has no upload endpoint). | #141 and #143: formulas and defined names dropped on import, losses not reported, the original overwritten without asking.                            |
| `visual.spec.ts`             | Screenshots of the dashboard, a document with a chip and the @ menu open, the mode menu, a sheet with values and a slide. Tagged `@visual`.                                                                                                                                                                                                                                                                                        | Layout and rendering regressions nobody asserts on.                                                                                                   |

## Skipped on purpose

Each of these is a `test.fixme` or `test.skip` with its reason in the code, so
it shows up in every report:

- **Known bugs** (fixme; remove the fixme with the fix and the test guards it):
  - Ctrl+Z undoes two steps (editor keymap plus the window-level shortcut in
    `LeftQuickAccessToolBar.svelte`); `set-content.spec.ts`;
  - the in-app context menu never appears on the web (`_showContextMenu` is a
    plain `let` in runes-mode `App.svelte`); `design.spec.ts`;
  - every Design document shares `assets/design/design.json` at the drive
    root, so a new design shows earlier shapes; `design.spec.ts` (each design
    test removes that file first);
  - the slideshow window throws on `window.presentationAPI.getInitialData`
    and stays blank on the web; `presentation.spec.ts`.
- **Not available on the web build against the stub**: the .pptx export and
  re-import. Export asks the bridge for a save location (`dialog:saveFile`),
  which the stub refuses by design, and the web build has no browser download
  for it. `tests/smoke/pptx.test.mjs` covers the writer and the reader.
- **Visual comparisons** outside the Playwright image, and for views that have
  no baseline yet (see below).

Known bugs that do not stop a scenario are allow-listed in
`support/fixtures.ts` with **KNOWN BUG**: the sheet saving an object to
`assets/sheet/sheet.json`, the collaboration socket falling back to the
production URL, and the LaTeX worker shipped as a `data:` URL in the
production build.

## Screenshots

`toHaveScreenshot` baselines only mean something in the environment that made
them, so the comparisons run only with `E2E_VISUAL=1`, which CI sets inside
the official image `mcr.microsoft.com/playwright:v1.63.0-noble` (the version
of `@playwright/test`). A view without a baseline is skipped with a message,
and runs never write baselines on their own (`updateSnapshots: 'none'`).
Dynamic areas (connection status, drive statistics, the caret) are masked or
hidden, and a diff under 1% of the pixels passes.

No baselines are committed yet. To create or update them:

- in CI: run the **E2E web** workflow by hand with `update_snapshots` checked,
  download the `e2e-web-screenshots-*` artifact and commit its files under
  `tests/e2e/__screenshots__/`;
- locally, inside the same image:

  ```sh
  docker run --rm --ipc=host -v "$PWD":/work -w /work \
    mcr.microsoft.com/playwright:v1.63.0-noble \
    bash -c 'npm ci --ignore-scripts && npm run test:e2e:update-snapshots'
  ```

  This installs the container's `node_modules` into your checkout; run
  `npm ci` again afterwards if your machine is not Linux x64.

Review the images before committing them.

## CI

`.github/workflows/e2e.yml`, job `e2e-web`:

- runs on every push to `main` and by hand; not on pull requests (too heavy,
  and not a required check);
- is also the first job of `web-image.yml`, whose image build `needs:` it:
  no image is built from a commit that fails the suite. `e2e.yml` skips the
  pushes that `web-image.yml` already tests (`paths-ignore`), so keep the two
  path lists the same;
- runs in the Playwright image, builds the bundle, runs the suite with one
  retry, and on failure writes the commit to revert in the job summary (the
  policy: a red e2e on main means reverting that commit) and uploads
  `playwright-report/` and `test-results/`;
- lists flaky tests (failed, then passed on the retry) in the job summary and
  as warning annotations. They do not fail the run by default: the verdict on
  main decides reverts and image builds, and a flaky test is not evidence
  against the commit. The `fail_on_flaky` input makes them fail;
- inputs: `repeat_each` (run every test N times, to hunt flakiness),
  `update_snapshots`, `fail_on_flaky`.

## Adding a test

1. Put it in `tests/e2e/<area>.spec.ts` and import `test`/`expect` from
   `./support/fixtures`. Start with `openApp(page)` or `newTextDocument(page)`.
2. Drive the UI: roles, labels, titles and text first (`getByRole`,
   `getByLabel`, `getByTitle`, `getByText`). Add a `data-testid` to the app
   only where nothing else is stable, and say why next to it. None was needed
   so far.
3. Wait on what the user would wait on: `expect(locator)` assertions and
   `expect.poll`. No `waitForTimeout`. When you need the app to have saved,
   `expectSavedToDisk(text)` reads the stub's drive.
4. Canvas content (sheets, slides, designs) has no DOM: go through the name
   box and status area of the sheet (`support/sheet.ts`), the slide editors
   that open on double-click, or the canvas pixels, as the existing specs do.
5. Each test must stand alone: create what it needs, assert, and leave
   nothing the next test relies on. The stub's drive lives for the whole run
   (and across a retry), so text you wait for on disk and variables in the
   "All my files" scope need names of their own: `uniqueToken()`.
6. Run it several times before pushing:
   `npm run test:e2e -- <spec> --repeat-each=5`.
7. If the scenario cannot work on the web build, keep it as a `test.skip` (or
   `test.fixme` for a bug) with the reason, rather than faking it.
