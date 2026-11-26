/**
 * Variables at scale: 20 variables in the "All my files" (desktop) scope, then
 * one of them updated several times.
 *
 * Guards the vars.json read storm: every save of a variable re-read the
 * variables file of every scope, once per variable, which froze the editor
 * for seconds with a few dozen variables. On the web each of those reads is a
 * call to the bridge, so the test counts them, and checks that the page never
 * blocks for long and that each save shows up in the document quickly.
 */
import { test, expect } from './support/fixtures'
import {
  createVariableFromMenu,
  newTextDocument,
  typeKeys,
  uniqueToken,
  variableMenu
} from './support/app'
import type { Page } from '@playwright/test'

const VARIABLES = 20
const UPDATES = 4
/** A task this long is a visible freeze. */
const LONG_TASK_LIMIT_MS = 500
/** From "Update and insert" to every chip showing the new value. */
const SAVE_LIMIT_MS = 5_000
/** Calls touching a vars.json for one save. The storm made hundreds. */
const VARS_CALLS_LIMIT = 10

/** Long tasks Chromium has recorded on the page so far (buffered entries). */
async function longTasks(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const durations: number[] = []
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration)
        })
        observer.observe({ type: 'longtask', buffered: true })
        // Buffered entries are delivered on the next task.
        setTimeout(() => {
          for (const entry of observer.takeRecords()) durations.push(entry.duration)
          observer.disconnect()
          resolve(durations)
        }, 0)
      })
  )
}

test('20 desktop variables: updates stay fast and do not storm vars.json', async ({
  page,
  guard
}) => {
  test.setTimeout(6 * 60_000)
  const editor = await newTextDocument(page)
  // Desktop variables outlive the test: names of their own, every run.
  const prefix = uniqueToken()
  const target = `${prefix}n7`

  for (let i = 1; i <= VARIABLES; i++) {
    await typeKeys(page, ` @${prefix}n${i}`)
    await createVariableFromMenu(page, `valeur ${i}`, { scope: 'All my files' })
    await expect(editor.locator(`span[data-variable="${prefix}n${i}"]`)).toHaveText(`valeur ${i}`)
  }

  // Long tasks while the document was being built are the app's start-up and
  // the first renders; only the updates below are measured.
  const startUp = (await longTasks(page)).length

  for (let round = 1; round <= UPDATES; round++) {
    const value = `mise à jour ${round}`
    await typeKeys(page, ` @${target}`)
    const menu = variableMenu(page)
    await menu.getByRole('button', { name: `Edit "@${target}"` }).click()
    await menu.getByLabel('Value').fill(value)

    const callsBefore = guard.stubCalls.length
    const started = Date.now()
    await menu.getByRole('button', { name: 'Update and insert' }).click()
    const chips = editor.locator(`span[data-variable="${target}"]`)
    await expect(chips).toHaveCount(round + 1)
    await expect
      .poll(async () => (await chips.allTextContents()).every((text) => text.trim() === value), {
        timeout: SAVE_LIMIT_MS
      })
      .toBe(true)
    const elapsed = Date.now() - started
    expect(elapsed, `update ${round} reached every chip in ${elapsed} ms`).toBeLessThan(
      SAVE_LIMIT_MS
    )

    // Let the save itself finish: the stub has written the new value.
    await expect
      .poll(() =>
        guard.stubCalls
          .slice(callsBefore)
          .some((call) => call.channel === 'fs:writeFile' && /vars\.json$/.test(call.arg))
      )
      .toBe(true)
    const varsCalls = guard.stubCalls
      .slice(callsBefore)
      .filter((call) => /vars\.json$/.test(call.arg))
    test.info().annotations.push({
      type: 'perf',
      description: `update ${round}: ${elapsed} ms, ${varsCalls.length} vars.json calls`
    })
    expect(varsCalls.length, `vars.json calls for update ${round}`).toBeLessThan(VARS_CALLS_LIMIT)
  }

  const tasks = (await longTasks(page)).slice(startUp)
  const longest = Math.max(0, ...tasks)
  test.info().annotations.push({
    type: 'perf',
    description: `${tasks.length} long tasks during the updates, longest ${Math.round(longest)} ms`
  })
  expect(longest, 'longest task during the updates (ms)').toBeLessThan(LONG_TASK_LIMIT_MS)
})
