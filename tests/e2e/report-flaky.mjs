#!/usr/bin/env node
/**
 * Reads the JSON report of a Playwright run and makes flaky tests visible.
 *
 * In CI a test that fails and then passes on its retry ends "flaky": the run
 * is green and nothing says so. This script lists them in the GitHub job
 * summary and emits one `::warning` annotation per test, so a flaky test is
 * never silently green. With FAIL_ON_FLAKY=true it also exits 1.
 *
 * Usage: node tests/e2e/report-flaky.mjs [test-results/results.json]
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const reportPath = process.argv[2] || 'test-results/results.json'
const summaryPath = process.env.GITHUB_STEP_SUMMARY
const failOnFlaky = process.env.FAIL_ON_FLAKY === 'true'

const summary = (text) => {
  if (summaryPath) appendFileSync(summaryPath, `${text}\n`)
  else console.log(text)
}

if (!existsSync(reportPath)) {
  summary(
    `### e2e-web: no test report\n\n\`${reportPath}\` was not written; the run stopped before the tests.`
  )
  process.exit(0)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }
const flaky = []

const walk = (suite, titles) => {
  for (const child of suite.suites || []) walk(child, [...titles, child.title].filter(Boolean))
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      counts[test.status] = (counts[test.status] || 0) + 1
      if (test.status !== 'flaky') continue
      const failures = (test.results || [])
        .filter((result) => result.status !== 'passed' && result.status !== 'skipped')
        .map(
          (result) => (result.error?.message || result.errors?.[0]?.message || '').split('\n')[0]
        )
        .filter(Boolean)
      flaky.push({
        file: spec.file,
        line: spec.line,
        title: [...titles, spec.title].join(' › '),
        project: test.projectName,
        firstFailure: failures[0] || 'failed on the first attempt'
      })
    }
  }
}
for (const suite of report.suites || []) walk(suite, [])

summary('### e2e-web results\n')
summary('| passed | failed | flaky | skipped |')
summary('| --- | --- | --- | --- |')
summary(`| ${counts.expected} | ${counts.unexpected} | ${counts.flaky} | ${counts.skipped} |\n`)

if (flaky.length) {
  summary('#### Flaky tests (failed, then passed on retry)\n')
  summary(
    'A flaky test is a bug, in the test or in the app. Hunt it with the workflow input `repeat_each`.\n'
  )
  for (const test of flaky) {
    summary(`- \`${test.file}:${test.line}\` [${test.project}] ${test.title}: ${test.firstFailure}`)
    const message = `${test.title} [${test.project}] passed only on retry: ${test.firstFailure}`
      .replace(/%/g, '%25')
      .replace(/\r?\n/g, ' ')
    console.log(
      `::warning file=tests/e2e/${test.file},line=${test.line},title=Flaky e2e test::${message}`
    )
  }
}

if (flaky.length && failOnFlaky) {
  console.log(`::error title=Flaky e2e tests::${flaky.length} flaky test(s) and FAIL_ON_FLAKY=true`)
  process.exit(1)
}
