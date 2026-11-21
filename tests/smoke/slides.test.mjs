/**
 * Gate: the pure parts of the presentation editor.
 *
 * Slide layouts and themes (slideDesign.ts) and the reading of a slide's
 * Y.Doc into text blocks with variables resolved (slideContent.ts). The
 * editor, the thumbnails and the slideshow all read slides through these, so
 * a wrong layout box, a variable that shows its id instead of its value, or a
 * run that loses its bold shows up everywhere at once.
 *
 * The modules import nothing but yjs, so esbuild bundles them with yjs into
 * one file and the assertions use that same yjs (two copies of yjs do not
 * recognise each other's types).
 *
 * Written without helper functions or callbacks: the repository's ESLint
 * config wants a return type on every function, which plain .mjs cannot give.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const slideUtils = path.join(
  repoRoot,
  'src/renderer/src/extensions/tiptap/CustomSlideExtension/utils'
)

const outDir = mkdtempSync(path.join(tmpdir(), 'slides-smoke-'))
const entry = path.join(outDir, 'entry.ts')
const compiled = path.join(outDir, 'slides.mjs')
writeFileSync(
  entry,
  [
    `export * as Y from 'yjs'`,
    `export * from ${JSON.stringify(path.join(slideUtils, 'slideDesign.ts'))}`,
    `export * from ${JSON.stringify(path.join(slideUtils, 'slideContent.ts'))}`
  ].join('\n')
)
const build = spawnSync(
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${compiled}`,
    // The entry sits in a temporary directory, outside node_modules' reach.
    `--alias:yjs=${path.join(repoRoot, 'node_modules', 'yjs')}`
  ],
  { encoding: 'utf-8', cwd: repoRoot }
)
if (build.status !== 0) {
  console.error(
    `[slides] FAIL: could not compile the slide modules\n${build.stdout}${build.stderr}`
  )
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const S = await import(`file://${compiled}`)
const { Y } = S
const newId = randomUUID.bind(null)
// [what, passed, detail]
const results = []
const json = JSON.stringify

// --- layouts -----------------------------------------------------------------
{
  const roles = {}
  let inside = true
  for (const { id } of S.SLIDE_LAYOUTS) {
    roles[id] = []
    for (const p of S.getLayoutPlaceholders(id)) {
      roles[id].push(p.role)
      inside &&= p.x >= 0 && p.y >= 0 && p.x + p.w <= S.SLIDE_WIDTH && p.y + p.h <= S.SLIDE_HEIGHT
    }
  }
  results.push([
    'title layout has a title and a subtitle',
    json(roles.title) === json(['title', 'subtitle']),
    json(roles.title)
  ])
  results.push([
    'title + content layout',
    json(roles['title-content']) === json(['title', 'body']),
    json(roles['title-content'])
  ])
  results.push([
    'two-column layout has two bodies',
    json(roles['two-column']) === json(['title', 'body', 'body2']),
    json(roles['two-column'])
  ])
  results.push(['blank layout has no placeholder', roles.blank.length === 0, json(roles.blank)])
  results.push(['every placeholder lies inside the 1280x720 slide', inside, ''])
  const [, left, right] = S.getLayoutPlaceholders('two-column')
  results.push(['the two columns do not overlap', left.x + left.w <= right.x, json([left, right])])
  const scaled = S.getLayoutPlaceholders('title-content', 1920, 1080)[1]
  results.push([
    'placeholders scale with the slide size',
    scaled.x === 96 && scaled.w === 1728,
    json(scaled)
  ])
}

// --- seeding and re-layout ---------------------------------------------------
{
  const doc = new Y.Doc()
  S.seedSlideDoc(doc, 'title-content', 'midnight', newId)
  const meta = doc.getMap('meta')
  const texts = doc.getMap('texts')
  const byRole = {}
  for (const shape of doc.getMap('shapes').values()) byRole[shape.role] = shape
  results.push([
    'a new title + content slide has a title and a body box',
    json(Object.keys(byRole).sort()) === json(['body', 'title']),
    json(Object.keys(byRole))
  ])
  results.push([
    'the new slide records layout and theme',
    meta.get('layout') === 'title-content' && meta.get('theme') === 'midnight',
    json(meta.toJSON())
  ])
  const titleFragment = texts.get(byRole.title.id)
  results.push([
    'the title box starts as an empty heading',
    titleFragment.toArray()[0].nodeName === 'heading',
    titleFragment.toString()
  ])
  const bodyFragment = texts.get(byRole.body.id)
  results.push([
    'the body box starts as a bullet list',
    bodyFragment.toArray()[0].nodeName === 'bulletList',
    bodyFragment.toString()
  ])

  // Type into the title, then switch to two columns, then to blank.
  titleFragment.toArray()[0].toArray()[0].insert(0, 'Quarterly review')
  S.applyLayoutToDoc(doc, 'two-column', newId)
  const afterTwo = []
  for (const shape of doc.getMap('shapes').values()) afterTwo.push(shape.role)
  results.push([
    'two columns keep the title and add a second body',
    json(afterTwo.sort()) === json(['body', 'body2', 'title']),
    json(afterTwo)
  ])
  const kept = S.blocksToPlainText(S.fragmentToBlocks(texts.get(byRole.title.id)))
  results.push(['the title kept its text through the re-layout', kept === 'Quarterly review', kept])
  S.applyLayoutToDoc(doc, 'blank', newId)
  const afterBlank = []
  for (const shape of doc.getMap('shapes').values()) afterBlank.push(shape.role)
  results.push([
    'blank drops the empty placeholders but keeps the typed title',
    json(afterBlank) === json(['title']),
    json(afterBlank)
  ])
  results.push([
    'the background falls back to the theme',
    S.resolveSlideBackground(meta) === '#0f172a',
    S.resolveSlideBackground(meta)
  ])
  meta.set('background', '#ff0000')
  results.push([
    'a slide background wins over the theme',
    S.resolveSlideBackground(meta) === '#ff0000',
    S.resolveSlideBackground(meta)
  ])
  results.push([
    'an unknown theme id falls back to the first theme',
    S.getSlideTheme('nope').id === 'default',
    ''
  ])
}

// --- text, styles and variables ------------------------------------------------
{
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('f')
  const heading = new Y.XmlElement('heading')
  heading.setAttribute('level', 1)
  heading.setAttribute('textAlign', 'center')
  const headingText = new Y.XmlText()
  heading.insert(0, [headingText])
  const para = new Y.XmlElement('paragraph')
  const before = new Y.XmlText()
  const chip = new Y.XmlElement('variable')
  chip.setAttribute('name', 'uuid-client')
  chip.setAttribute('value', 'stale')
  const afterText = new Y.XmlText()
  para.insert(0, [before, chip, afterText])
  const list = new Y.XmlElement('bulletList')
  const item = new Y.XmlElement('listItem')
  const itemPara = new Y.XmlElement('paragraph')
  const itemText = new Y.XmlText()
  itemPara.insert(0, [itemText])
  item.insert(0, [itemPara])
  list.insert(0, [item])
  fragment.insert(0, [heading, para, list])
  headingText.insert(0, 'Hello ', { textStyle: { fontWeight: 'bold', color: '#ff0000' } })
  headingText.insert(6, 'world', { textStyle: { fontStyle: 'italic', fontSize: '30px' } })
  before.insert(0, 'Prepared for ')
  afterText.insert(0, '.')
  itemText.insert(0, 'First point')

  // The resolver stands in for variableManipulator.getVariable: a Map lookup.
  const values = new Map([['uuid-client', 'Acme Corp']])
  const resolve = values.get.bind(values)
  const blocks = S.fragmentToBlocks(fragment, resolve)
  const kinds = []
  for (const b of blocks) kinds.push(b.kind)
  results.push([
    'blocks keep their kind',
    json(kinds) === json(['heading', 'paragraph', 'bullet']),
    json(kinds)
  ])
  results.push(['alignment is read', blocks[0].align === 'center', blocks[0].align])
  results.push([
    'bold and colour come from textStyle',
    blocks[0].runs[0].bold === true && blocks[0].runs[0].color === '#ff0000',
    json(blocks[0].runs[0])
  ])
  results.push([
    'italic and font size come from textStyle',
    blocks[0].runs[1].italic === true && blocks[0].runs[1].fontSize === 30,
    json(blocks[0].runs[1])
  ])
  const shown = S.blocksToPlainText([blocks[1]])
  results.push(['a variable shows its current value', shown === 'Prepared for Acme Corp.', shown])
  values.set('uuid-client', 'Globex')
  const changed = S.blocksToPlainText([S.fragmentToBlocks(fragment, resolve)[1]])
  results.push([
    'a changed variable shows its new value on the next read',
    changed === 'Prepared for Globex.',
    changed
  ])
  const unknown = S.blocksToPlainText([
    S.fragmentToBlocks(fragment, new Map().get.bind(new Map()))[1]
  ])
  results.push([
    'an unknown variable falls back to the value stored on the chip',
    unknown === 'Prepared for stale.',
    unknown
  ])
  const html = S.blocksToHtml(blocks)
  results.push([
    'HTML has the heading, the list and the variable value',
    html.includes('<h1 style="text-align:center">') &&
      html.includes('<ul><li') &&
      html.includes('data-variable="uuid-client"') &&
      html.includes('Globex') === false,
    html
  ])
  const escaped = S.blocksToHtml([{ kind: 'paragraph', level: 1, runs: [{ text: '<b>' }] }])
  results.push(['HTML escapes text', !escaped.includes('<b>'), escaped])
}

// --- a whole slide -----------------------------------------------------------
{
  const doc = new Y.Doc()
  S.seedSlideDoc(doc, 'title', 'sunrise', newId)
  doc.getMap('shapes').set('rect-1', {
    id: 'rect-1',
    type: 'rect',
    x: 10,
    y: 20,
    w: 100,
    h: 50,
    z: 9,
    fill: '#ea580c'
  })
  doc
    .getMap('shapes')
    .set('img-1', { id: 'img-1', type: 'file', x: 0, y: 0, w: 10, h: 10, z: 10, src: '/tmp/a.png' })
  doc.getMap('meta').set('notes', 'Say hello')
  const data = S.readSlideData(doc)
  const types = []
  for (const e of data.elements) types.push(e.type)
  results.push([
    'slide data is ordered by z',
    json(types) === json(['text', 'text', 'rect', 'file']),
    json(types)
  ])
  results.push([
    'slide data carries notes, theme and background',
    data.notes === 'Say hello' && data.themeId === 'sunrise' && data.background === '#fff7ed',
    json([data.notes, data.themeId, data.background])
  ])
  const html = S.renderSlideHtml(data, encodeURI)
  results.push([
    'static HTML draws the rectangle and the image',
    html.includes('background:#ea580c') && html.includes('src="/tmp/a.png"'),
    html
  ])
  results.push([
    'static HTML uses the theme fonts',
    html.includes("font-family:'Georgia'") && html.includes("font-family:'Arial'"),
    html
  ])
}

rmSync(outDir, { recursive: true, force: true })
let failures = 0
for (const [what, passed, detail] of results) {
  if (passed) {
    console.log(`[slides]   ok    ${what}`)
  } else {
    failures++
    console.error(`[slides]   FAIL  ${what}\n                     ${detail}`)
  }
}
if (failures) {
  console.error(`[slides] ${failures} failure(s)`)
  process.exit(1)
}
console.log('[slides] all checks passed')
