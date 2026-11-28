#!/usr/bin/env node
// Checks the two causes of #150 (the slideshow window crashing on the web)
// in the sources, without a browser. tests/e2e/presentation.spec.ts drives
// the real window.
//
// Why this exists
//   1. On the #/presentation and #/presenter routes, main.ts mounted the
//      window before the platform driver had installed
//      window.presentationAPI, and the window threw on `getInitialData`.
//      main.ts must wait for window.__ddocDriverReady on those routes before
//      mount().
//   2. The web (and mobile) driver opened the window with `noopener`, so
//      window.open returned null although the window opened, and the
//      "popup blocked" fallback opened a second one.
//
// Usage
//   npm run test:smoke:slideshow-window

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '..', '..', 'src', 'renderer', 'src')
const read = (...parts) => readFileSync(path.join(src, ...parts), 'utf8')

const log = (...args) => console.log('[slideshow-window]', ...args)
let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`)
  }
}

// 1. main.ts: the presentation routes wait for the driver before mount().
const main = read('main.ts')
const mountApp = main.slice(main.indexOf('async function mountApp'))
const body = mountApp.slice(0, mountApp.indexOf('\n}\n'))
const waitAt = body.search(
  /if \(isPresentation \|\| isPresenterView\)\s*\{\s*await \(window as any\)\.__ddocDriverReady/
)
const mountAt = body.indexOf('mount(ComponentModule.default')
check('main.ts waits for __ddocDriverReady on the presentation routes', waitAt >= 0)
check('main.ts waits before mount()', waitAt >= 0 && mountAt > waitAt)

// 1b. The windows do not throw when the API is missing anyway.
for (const file of ['PresentationWindow.svelte', 'PresenterWindow.svelte']) {
  const text = read('extensions', 'tiptap', 'CustomPresentationExtension', 'components', file)
  // The live onMount, not the one kept in a comment.
  const onMount = text.slice(text.indexOf('\n  onMount(() => {'))
  const guardAt = onMount.indexOf('if (!window.presentationAPI)')
  const firstUse = onMount.indexOf('window.presentationAPI.')
  check(`${file} checks the API before its first use`, guardAt >= 0 && guardAt < firstUse)
}

// 2. No noopener in the features of the window the drivers open.
for (const file of ['web.ts', 'mobile.ts']) {
  const text = read('lib', 'api', 'drivers', file)
  const start = text.indexOf('const openPresentationWindow')
  const fn = text.slice(start, text.indexOf('\n  }\n', start))
  const opens = [...fn.matchAll(/window\.open\(([\s\S]*?)\)/g)].map((match) => match[1])
  check(`${file} opens the slideshow window`, start >= 0 && opens.length > 0)
  check(
    `${file}: no noopener/noreferrer, so the returned handle is real`,
    opens.every((args) => !/noopener|noreferrer/.test(args)),
    opens.join(' | ')
  )
}

if (failures) {
  console.error(`[slideshow-window] ${failures} check(s) failed`)
  process.exit(1)
}
log('all checks passed')
