#!/usr/bin/env node
// Search and replace across files (#137).
//
// Why this exists
//   Replace used to run a regular expression over the raw HTML while search
//   ran over text stripped of tags. A replace could rewrite a link's URL or an
//   attribute, skipped a match split by formatting (`Acme <b>Corp</b>`), and
//   wrote straight to disk with no preview, no backup and no log.
//
//   This bundles src/main/search/fileSearch.ts (no Electron import) with
//   esbuild and checks, on real files in a temporary folder:
//   - only text nodes change, never tags, attributes, URLs, comments or scripts;
//   - a match split by inline formatting is found and replaced, and the
//     replacement takes the formatting of the first replaced character;
//   - matches never span two paragraphs or an embedded object, and text inside
//     a variable chip is listed as skipped, never written;
//   - the preview lists exactly what the apply writes; a file edited after the
//     preview is skipped; each changed file is copied to a backup first, a
//     manifest and a log line are written, and the backup restores the file.
//
// Usage
//   npm run test:smoke:search-replace

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'main', 'search', 'index.ts')

const log = (...args) => console.log('[search-replace]', ...args)
let failures = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-search-replace-'))
try {
  const compiled = path.join(work, 'search.mjs')
  const esbuild = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  const build = spawnSync(
    esbuild,
    [SOURCE, '--bundle', '--platform=node', '--format=esm', `--outfile=${compiled}`],
    { encoding: 'utf8' }
  )
  if (build.status !== 0) {
    console.error(`[search-replace] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const search = await import(`file://${compiled}`)
  const {
    createSearchRegExp,
    planReplace,
    htmlTextModel,
    searchInFiles,
    previewReplaceInFiles,
    applyReplaceInFiles,
    restoreReplaceBackup
  } = search

  const replaceHtml = (html, query, replacement, options = {}) =>
    planReplace('doc.html', html, createSearchRegExp(query, options), replacement).output

  log('text nodes only')
  check(
    'link text changes, its URL does not',
    replaceHtml('<p>See <a href="https://acme.example/acme">Acme site</a></p>', 'acme', 'Globex'),
    '<p>See <a href="https://acme.example/acme">Globex site</a></p>'
  )
  check(
    'attributes, comments, scripts and styles are left alone',
    replaceHtml(
      '<p title="acme" class="acme"><!-- acme --><img alt="acme" src="acme.png">acme</p>' +
        '<script>var acme = 1</script><style>.acme{}</style>',
      'acme',
      'X'
    ),
    '<p title="acme" class="acme"><!-- acme --><img alt="acme" src="acme.png">X</p>' +
      '<script>var acme = 1</script><style>.acme{}</style>'
  )
  check(
    'the head (title, meta) is not document text',
    replaceHtml(
      '<html><head><title>acme</title><meta name="acme"></head><body><p>acme</p></body></html>',
      'acme',
      'X'
    ),
    '<html><head><title>acme</title><meta name="acme"></head><body><p>X</p></body></html>'
  )
  check(
    'a tag name is never matched',
    replaceHtml('<p><span>span</span></p>', 'span', 'X'),
    '<p><span>X</span></p>'
  )

  log('across inline formatting')
  check(
    'Acme <b>Corp</b> is one match, written where the first character is',
    replaceHtml('<p>Acme <b>Corp</b> rules</p>', 'Acme Corp', 'Globex Inc'),
    '<p>Globex Inc<b></b> rules</p>'
  )
  check(
    'the replacement takes the formatting of the first replaced character',
    replaceHtml('<p><b>Ac</b>me Corp</p>', 'Acme', 'Globex'),
    '<p><b>Globex</b> Corp</p>'
  )
  check(
    'three runs, nested marks',
    replaceHtml('<p>A<i>c<u>m</u></i>e!</p>', 'acme', 'Z'),
    '<p>Z<i><u></u></i>!</p>'
  )
  check(
    'collapsed white space between runs still matches',
    replaceHtml('<p>Acme\n    <b>Corp</b></p>', 'Acme Corp', 'Globex'),
    '<p>Globex<b></b></p>'
  )
  check(
    '&nbsp; reads as a space',
    replaceHtml('<p>Acme&nbsp;Corp</p>', 'Acme Corp', 'Globex'),
    '<p>Globex</p>'
  )
  check(
    'character references are decoded, the replacement is escaped',
    replaceHtml('<p>Tom &amp; Jerry</p>', 'Tom & Jerry', 'A < B & C'),
    '<p>A &lt; B &amp; C</p>'
  )

  log('boundaries')
  check(
    'a match never spans two paragraphs',
    replaceHtml('<p>Acme</p><p>Corp</p>', 'Acme Corp', 'X'),
    '<p>Acme</p><p>Corp</p>'
  )
  check(
    'a match never spans a line break',
    replaceHtml('<p>Acme<br>Corp</p>', 'Acme Corp', 'X'),
    '<p>Acme<br>Corp</p>'
  )
  check(
    'an image between two halves breaks the word, and is never removed',
    replaceHtml('<p>Ac<img src="a.png">me</p>', 'Acme', 'X'),
    '<p>Ac<img src="a.png">me</p>'
  )
  check(
    'a regular expression cannot eat an image',
    replaceHtml('<p>a<img src="a.png">b</p>', 'a.b', 'X', { isRegex: true }),
    '<p>a<img src="a.png">b</p>'
  )
  check(
    'text inside a variable chip is never written',
    replaceHtml(
      '<p>client <span class="variable-chip" data-variable="client">{client}</span></p>',
      'client',
      'X'
    ),
    '<p>X <span class="variable-chip" data-variable="client">{client}</span></p>'
  )
  check(
    'a variable chip as the editor saves it keeps every attribute',
    replaceHtml(
      '<p><span name="client" value="ACME" class="variable-chip" data-variable="client">{client}</span> ACME</p>',
      'acme|client',
      'X',
      { isRegex: true }
    ),
    '<p><span name="client" value="ACME" class="variable-chip" data-variable="client">{client}</span> X</p>'
  )
  check(
    'an HTML comment placeholder is protected',
    replaceHtml('<p><span data-html-comment="acme">acme</span> acme</p>', 'acme', 'X'),
    '<p><span data-html-comment="acme">acme</span> X</p>'
  )
  check(
    'contenteditable="false" is protected too',
    replaceHtml('<p>a <span contenteditable="false">acme</span> acme</p>', 'acme', 'X'),
    '<p>a <span contenteditable="false">acme</span> X</p>'
  )
  check(
    'white space inside <pre> is kept as is',
    replaceHtml('<pre>a  acme\n acme</pre>', 'acme', 'X'),
    '<pre>a  X\n X</pre>'
  )
  check(
    'the text model of a split word',
    htmlTextModel('<p>Ac<b>me</b> Corp</p>').text,
    'Acme Corp\n'
  )
  check(
    'plain text files replace as text, CRLF kept',
    planReplace(
      'notes.md',
      'acme\r\n[acme](https://acme.example)\r\n',
      createSearchRegExp('acme', {}),
      'X'
    ).output,
    'X\r\n[X](https://X.example)\r\n'
  )

  log('files: search, preview, apply, backup, log, restore')
  const root = path.join(work, 'drive')
  const docDir = path.join(root, 'Contract')
  mkdirSync(docDir, { recursive: true })
  const docPath = path.join(docDir, 'index.html')
  const original =
    '<p>Acme <b>Corp</b> signs with <a href="https://acme.example">Acme Corp</a>.</p>' +
    '<p><span data-variable="acme">{acme}</span></p>'
  writeFileSync(docPath, original)
  const otherPath = path.join(root, 'other.html')
  writeFileSync(otherPath, '<p>Nothing here</p>')
  const outside = path.join(work, 'outside.html')
  writeFileSync(outside, '<p>Acme Corp</p>')
  const backupRoot = path.join(work, 'backups')

  const base = {
    rootPath: root,
    query: 'Acme Corp',
    includePattern: '**/*.html',
    excludePattern: ''
  }

  const found = await searchInFiles(base)
  check('search finds the split match and the link text', found.totalMatches, 2)
  check(
    'search shows the visible text',
    found.files[0]?.items.map((item) => item.match),
    ['Acme Corp', 'Acme Corp']
  )

  const preview = await previewReplaceInFiles({ ...base, replaceText: 'Globex Inc' })
  check('preview: one file, two replacements', [preview.changedFiles, preview.replacements], [1, 2])
  check(
    'preview: each change with its replacement',
    preview.files[0]?.changes.map((change) => [change.match, change.replacement]),
    [
      ['Acme Corp', 'Globex Inc'],
      ['Acme Corp', 'Globex Inc']
    ]
  )
  check('preview writes nothing', readFileSync(docPath, 'utf8'), original)

  const escape = await previewReplaceInFiles({
    ...base,
    replaceText: 'X',
    restrictToPaths: [outside]
  })
  check('a restricted path outside the search root is ignored', escape.files.length, 0)

  writeFileSync(docPath, original + '<p>edited</p>')
  const stale = await applyReplaceInFiles(
    {
      ...base,
      replaceText: 'Globex Inc',
      files: preview.files.map((file) => ({ path: file.path, hash: file.hash }))
    },
    backupRoot
  )
  check(
    'a file edited after the preview is skipped',
    stale.skippedFiles.map((f) => f.reason),
    ['changed since the preview']
  )
  check('and left as it is', readFileSync(docPath, 'utf8'), original + '<p>edited</p>')
  writeFileSync(docPath, original)

  const applied = await applyReplaceInFiles(
    {
      ...base,
      replaceText: 'Globex Inc',
      files: preview.files.map((file) => ({ path: file.path, hash: file.hash }))
    },
    backupRoot
  )
  const expected =
    '<p>Globex Inc<b></b> signs with <a href="https://acme.example">Globex Inc</a>.</p>' +
    '<p><span data-variable="acme">{acme}</span></p>'
  check('apply: replaced', [applied.changedFiles, applied.replacements], [1, 2])
  check(
    'apply: the file has the new text, URL and chip intact',
    readFileSync(docPath, 'utf8'),
    expected
  )
  const manifest = JSON.parse(readFileSync(path.join(applied.backupDir, 'manifest.json'), 'utf8'))
  check(
    'apply: the backup copy is the file as it was',
    readFileSync(path.join(applied.backupDir, manifest.files[0].backup), 'utf8'),
    original
  )
  const logLines = readFileSync(applied.logPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  check(
    'apply: one log line per run, the last one with what changed',
    [logLines.length, logLines.at(-1).replacements, logLines.at(-1).files[0].changes[0].after],
    [2, 2, 'Globex Inc signs with Globex Inc.']
  )

  const restored = await restoreReplaceBackup(applied.backupId, backupRoot)
  check(
    'restore: the file is back',
    [restored.restored.length, readFileSync(docPath, 'utf8')],
    [1, original]
  )

  const again = await applyReplaceInFiles(
    {
      ...base,
      replaceText: 'Z',
      files: [
        {
          path: docPath,
          hash: (await previewReplaceInFiles({ ...base, replaceText: 'Z' })).files[0].hash
        }
      ]
    },
    backupRoot
  )
  writeFileSync(docPath, 'edited after the replace')
  const refused = await restoreReplaceBackup(again.backupId, backupRoot)
  check(
    'restore never overwrites a file edited after the replace',
    refused.skippedFiles.map((f) => f.reason),
    ['changed since the replace']
  )
  check(
    'restore refuses an id that is not a backup',
    (await restoreReplaceBackup('../x', backupRoot)).ok,
    false
  )
  check(
    'the other file was never touched',
    existsSync(otherPath) && readFileSync(otherPath, 'utf8'),
    '<p>Nothing here</p>'
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.error(`[search-replace] ${failures} check(s) failed`)
  process.exit(1)
}
log('all checks passed')
