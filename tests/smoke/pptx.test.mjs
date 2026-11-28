/**
 * Gate: .pptx export and import of a presentation (pptxMapping.ts).
 *
 * A deck is built from slide Y.Docs the way the editor stores them, written
 * as a .pptx, unzipped and checked part by part, then read back through
 * @cliftonc/pptx-to-json (the importer's parser) and mapped to slides again.
 * What breaks quietly is asserted directly: a variable written with a stale
 * value, a title that is no longer a title, boxes that come back at the
 * wrong size, notes or images that go missing, XML that does not parse.
 *
 * Written without helper functions or callbacks, like slides.test.mjs: the
 * repository's ESLint config wants a return type on every function.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const slideUtils = path.join(
  repoRoot,
  'src/renderer/src/extensions/tiptap/CustomSlideExtension/utils'
)

const outDir = mkdtempSync(path.join(tmpdir(), 'pptx-smoke-'))
const entry = path.join(outDir, 'entry.ts')
const compiled = path.join(outDir, 'pptx.mjs')
writeFileSync(
  entry,
  [
    `export * as Y from 'yjs'`,
    `export { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'`,
    `export * from ${JSON.stringify(path.join(slideUtils, 'slideDesign.ts'))}`,
    `export * from ${JSON.stringify(path.join(slideUtils, 'slideContent.ts'))}`,
    `export * from ${JSON.stringify(path.join(slideUtils, 'pptxMapping.ts'))}`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/renderer/src/shared/zipLimits.ts'))}`
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
    `--alias:yjs=${path.join(repoRoot, 'node_modules', 'yjs')}`,
    `--alias:fflate=${path.join(repoRoot, 'node_modules', 'fflate')}`
  ],
  { encoding: 'utf-8', cwd: repoRoot }
)
if (build.status !== 0) {
  console.error(`[pptx] FAIL: could not compile the slide modules\n${build.stdout}${build.stderr}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

const S = await import(pathToFileURL(compiled).href)
const { Y } = S
const require = createRequire(path.join(repoRoot, 'package.json'))
const P = await import(pathToFileURL(require.resolve('@cliftonc/pptx-to-json')).href)
const newId = randomUUID.bind(null)
// [what, passed, detail]
const results = []
const json = JSON.stringify

// --- a two-slide deck --------------------------------------------------------
// Slide 1: title layout, "Quarterly review" and "For <variable client>".
const doc1 = new Y.Doc()
S.seedSlideDoc(doc1, 'title', 'midnight', newId)
const byRole = {}
for (const shape of doc1.getMap('shapes').values()) byRole[shape.role] = shape
const titleText = doc1.getMap('texts').get(byRole.title.id).toArray()[0].toArray()[0]
titleText.insert(0, 'Quarterly review')
const subtitlePara = doc1.getMap('texts').get(byRole.subtitle.id).toArray()[0]
const forText = subtitlePara.toArray()[0]
forText.insert(0, 'For ')
const chip = new Y.XmlElement('variable')
chip.setAttribute('name', 'client')
chip.setAttribute('value', 'stale value')
subtitlePara.insert(1, [chip])
doc1.getMap('meta').set('notes', 'Welcome everyone.\nSecond line.')

// Slide 2: blank, a rectangle, an ellipse turned by 30 degrees, an image.
const doc2 = new Y.Doc()
S.seedSlideDoc(doc2, 'blank', 'midnight', newId)
const shapes2 = doc2.getMap('shapes')
shapes2.set('r', { id: 'r', type: 'rect', x: 100, y: 120, w: 300, h: 150, z: 1, fill: '#ea580c' })
shapes2.set('e', {
  id: 'e',
  type: 'ellipse',
  x: 700,
  y: 200,
  w: 200,
  h: 100,
  z: 2,
  rotation: 30,
  fill: 'rgba(37, 99, 235, 0.5)'
})
shapes2.set('i', { id: 'i', type: 'file', x: 500, y: 400, w: 64, h: 48, z: 3, src: '/x/a.png' })

// The resolver stands in for variableManipulator.getVariable.
const values = new Map([['client', 'Acme & Co']])
const resolve = values.get.bind(values)
const slides = [S.readSlideData(doc1, resolve), S.readSlideData(doc2, resolve)]

// A 1x1 PNG.
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
)
const images = new Map([['/x/a.png', { data: png, ext: 'png' }]])
const bytes = await S.buildPptx(slides, images.get.bind(images), { title: 'Smoke <deck>' })

// --- the package -------------------------------------------------------------
const files = S.unzipSync(bytes)
const names = Object.keys(files)
results.push([
  '[Content_Types].xml is the first part',
  names[0] === '[Content_Types].xml',
  names[0]
])
let allParse = true
let badPart = ''
for (const name of names) {
  if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
  const text = S.strFromU8(files[name])
  // Well-formedness, roughly: one root, balanced tags, no raw ampersand.
  const opened = (text.match(/<[a-zA-Z][^>]*[^/]>/g) || []).length
  const closed = (text.match(/<\/[a-zA-Z][^>]*>/g) || []).length
  if (opened !== closed || /&(?![a-z]+;|#\d+;)/.test(text)) {
    allParse = false
    badPart = name
  }
}
results.push(['every XML part is balanced and escaped', allParse, badPart])
const types = S.strFromU8(files['[Content_Types].xml'])
results.push([
  'content types declare both slides, their notes and png',
  types.includes('/ppt/slides/slide2.xml') &&
    types.includes('/ppt/notesSlides/notesSlide1.xml') &&
    types.includes('Extension="png"'),
  types
])
const presentation = S.strFromU8(files['ppt/presentation.xml'])
results.push([
  'the slide size is 1280x720 px in EMU',
  presentation.includes('<p:sldSz cx="12192000" cy="6858000"/>'),
  presentation.match(/<p:sldSz[^>]*>/)?.[0]
])
const slide1 = S.strFromU8(files['ppt/slides/slide1.xml'])
results.push([
  'the title is a title placeholder, in bold',
  /<p:ph type="title"\/>/.test(slide1) &&
    /<a:rPr[^>]*b="1"[^>]*>.*?<a:t>Quarterly review/.test(slide1),
  slide1
])
results.push([
  'a variable is written with its current value, escaped',
  slide1.includes('<a:t>Acme &amp; Co</a:t>') && !slide1.includes('stale value'),
  slide1
])
results.push([
  'the slide background is the theme background',
  /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A">/.test(slide1),
  slide1.match(/<p:bg>.*?<\/p:bg>/)?.[0]
])
const notes1 = S.strFromU8(files['ppt/notesSlides/notesSlide1.xml'])
results.push([
  'speaker notes keep their lines',
  notes1.includes('<a:t>Welcome everyone.</a:t>') && notes1.includes('<a:t>Second line.</a:t>'),
  notes1
])
const slide2 = S.strFromU8(files['ppt/slides/slide2.xml'])
results.push([
  'shapes become preset geometry with their fill',
  slide2.includes('prst="rect"') &&
    slide2.includes('<a:srgbClr val="EA580C">') &&
    slide2.includes('prst="ellipse"') &&
    slide2.includes('<a:alpha val="50000"/>'),
  slide2
])
results.push([
  'a rotated shape carries rot in 60000ths of a degree',
  slide2.includes('rot="1800000"'),
  slide2
])
const rels2 = S.strFromU8(files['ppt/slides/_rels/slide2.xml.rels'])
results.push([
  'the image is embedded and related to its slide',
  slide2.includes('<p:pic>') &&
    rels2.includes('Target="../media/image1.png"') &&
    files['ppt/media/image1.png']?.length === png.length,
  rels2
])
const core = S.strFromU8(files['docProps/core.xml'])
results.push(['the title is escaped', core.includes('Smoke &lt;deck&gt;'), core])

// --- colours and rotation ----------------------------------------------------
results.push([
  'CSS colours become OOXML hex',
  json(S.cssColorToHex('#abc')) === json({ hex: 'AABBCC', alpha: 1 }) &&
    json(S.cssColorToHex('rgb(255, 0, 16)')) === json({ hex: 'FF0010', alpha: 1 }) &&
    S.cssColorToHex('transparent') === null,
  json([S.cssColorToHex('#abc'), S.cssColorToHex('rgb(255, 0, 16)')])
])
const there = S.rotationToOoxml(700, 200, 200, 100, 30)
const back = S.rotationFromOoxml(there.x, there.y, 200, 100, 30)
results.push([
  'rotation about the corner and about the centre are inverse',
  Math.abs(back.x - 700) < 1e-6 && Math.abs(back.y - 200) < 1e-6,
  json([there, back])
])
results.push([
  'imported colours get their dropped leading zeros back',
  S.normalizeImportedColor('#59669') === '#059669' &&
    S.normalizeImportedColor('FF0000') === '#FF0000',
  S.normalizeImportedColor('#59669')
])

// --- read back through the importer's parser ---------------------------------
const raw = await new P.PPTXParser().buffer2json(bytes)
const parsed = await new P.PowerPointParser().parseJson(raw)
const deck = S.pptxToPresentation(parsed, raw)
results.push([
  'the deck comes back with two slides at 1280x720',
  deck.slides.length === 2 && deck.widthPx === 1280 && deck.heightPx === 720,
  json([deck.slides.length, deck.widthPx, deck.heightPx])
])
const [in1, in2] = deck.slides
const inTitle = in1.elements.find((e) => e.role === 'title')
results.push([
  'the title comes back as the title, as a heading, where it was',
  !!inTitle &&
    inTitle.tiptapContent?.content?.[0]?.type === 'heading' &&
    Math.abs(inTitle.x - byRole.title.x) < 1 &&
    Math.abs(inTitle.width - byRole.title.w) < 1,
  json(inTitle && [inTitle.x, inTitle.y, inTitle.width, inTitle.height, byRole.title])
])
const inSubtitle = in1.elements.find((e) => e.role !== 'title')
results.push([
  'the variable comes back as its value',
  String(inSubtitle?.text).includes('For Acme & Co'),
  inSubtitle?.text
])
const sizes = []
for (const node of inTitle?.tiptapContent?.content?.[0]?.content ?? []) {
  for (const mark of node.marks ?? []) if (mark.attrs?.fontSize) sizes.push(mark.attrs.fontSize)
}
results.push([
  'font sizes come back in px (44 px title)',
  sizes.length > 0 && sizes.every((size) => size === '44px'),
  json(sizes)
])
results.push([
  'notes and background come back',
  String(in1.notes).includes('Welcome everyone.') && in1.background === '#0F172A',
  json([in1.notes, in1.background])
])
const kinds = []
for (const e of in2.elements) kinds.push(e.type === 'shape' ? e.shape : e.type)
results.push([
  'shapes and the image come back',
  kinds.includes('rect') && kinds.includes('ellipse') && kinds.includes('image'),
  json(kinds)
])
const inRect = in2.elements.find((e) => e.shape === 'rect')
results.push([
  'a shape comes back at its place and size',
  !!inRect &&
    Math.abs(inRect.x - 100) < 1 &&
    Math.abs(inRect.y - 120) < 1 &&
    Math.abs(inRect.width - 300) < 1 &&
    Math.abs(inRect.height - 150) < 1,
  json(inRect)
])
const inEllipse = in2.elements.find((e) => e.shape === 'ellipse')
results.push([
  'a rotated shape comes back at its place',
  !!inEllipse &&
    Math.abs(inEllipse.x - 700) < 1 &&
    Math.abs(inEllipse.y - 200) < 1 &&
    Math.abs(inEllipse.rotation - 30) < 0.5,
  json(inEllipse)
])

results.push([
  'elements keep their stacking order in spTree and on import',
  slide2.indexOf('prst="rect"') < slide2.indexOf('prst="ellipse"') &&
    slide2.indexOf('prst="ellipse"') < slide2.indexOf('<p:pic>') &&
    json(kinds) === json(['rect', 'ellipse', 'image']),
  json(kinds)
])
results.push([
  'the deck theme comes back (its text colour, fonts and list markers)',
  deck.themeId === 'midnight',
  deck.themeId
])
const listXml = S.blocksToParagraphXml(
  [
    { kind: 'bullet', level: 0, runs: [{ text: 'coloured', color: '#38bdf8' }] },
    { kind: 'number', level: 0, runs: [{ text: 'plain' }] }
  ],
  { fontSize: 24, fontFamily: 'Verdana', color: '#f1f5f9' }
)
results.push([
  'list markers carry the colour of their text (buClr)',
  listXml.includes('<a:buClr><a:srgbClr val="38BDF8"></a:srgbClr></a:buClr><a:buFont') &&
    listXml.includes('<a:buClr><a:srgbClr val="F1F5F9"></a:srgbClr></a:buClr><a:buAutoNum'),
  listXml
])

{
  // pptx-to-json fills a text box's style from its first run.
  const bleed = S.pptxToPresentation(
    {
      slideDimensions: { width: 1280, height: 720 },
      slides: [
        {
          components: [
            {
              type: 'text',
              x: 10,
              y: 10,
              width: 400,
              height: 200,
              content: 'Red first\nPlain second',
              style: { color: '#C01010', fontSize: 18 },
              richText: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'text',
                        text: 'Red first',
                        marks: [{ type: 'textStyle', attrs: { color: '#C01010' } }]
                      }
                    ]
                  },
                  { type: 'paragraph', content: [{ type: 'text', text: 'Plain second' }] }
                ]
              }
            }
          ]
        }
      ]
    },
    {}
  )
  const runs = bleed.slides[0].elements[0].tiptapContent.content.map(
    (para) => para.content[0].marks?.[0]?.attrs?.color ?? null
  )
  results.push([
    "one run's colour does not spread to the runs without one",
    json(runs) === json(['#C01010', null]),
    json(runs)
  ])
}

// --- export details ----------------------------------------------------------
{
  const doc = new Y.Doc()
  S.seedSlideDoc(doc, 'blank', 'midnight', newId)
  doc
    .getMap('shapes')
    .set('s', { id: 's', type: 'file', x: 0, y: 0, w: 10, h: 10, z: 1, src: '/x/a.svg' })
  doc
    .getMap('meta')
    .set('notes', 'bad\uFFFE\uFFFF chars \uD800 here, \uDE00 there, \uD83D\uDE00 kept')
  doc.getMap('meta').set('background', { stops: [{ color: '#123456', position: 0 }] })
  const data = S.readSlideData(doc)
  data.elements.push({
    id: 'tiny',
    type: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 20,
    blocks: [
      { kind: 'paragraph', level: 1, runs: [{ text: 'tiny', fontSize: 0.01 }] },
      { kind: 'paragraph', level: 1, runs: [{ text: 'huge', fontSize: 999999 }] }
    ]
  })
  const svg = new Map([['/x/a.svg', { data: S.strToU8('<svg/>'), ext: 'svg' }]])
  const out = S.unzipSync(await S.buildPptx([data], svg.get.bind(svg)))
  const slide = S.strFromU8(out['ppt/slides/slide1.xml'])
  results.push([
    'a bare SVG is not written as a picture (the exporter rasterises SVG first)',
    !slide.includes('<p:pic>') && !Object.keys(out).some((name) => name.endsWith('.svg')),
    Object.keys(out).join(', ')
  ])
  const sizes = [...slide.matchAll(/ sz="(\d+)"/g)].map((m) => Number(m[1]))
  results.push([
    'font sizes are clamped to 100..400000',
    sizes.length > 0 &&
      sizes.every((sz) => sz >= 100 && sz <= 400000) &&
      sizes.includes(100) &&
      sizes.includes(400000),
    json(sizes)
  ])
  results.push([
    'a gradient with one stop is a solid fill',
    slide.includes('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="123456">') &&
      !slide.includes('gradFill'),
    slide.match(/<p:bg>.*?<\/p:bg>/)?.[0]
  ])
  const notes = S.strFromU8(out['ppt/notesSlides/notesSlide1.xml'])
  results.push([
    'characters XML 1.0 forbids are dropped, a surrogate pair is kept',
    !/[\uFFFE\uFFFF]/.test(notes) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(notes) &&
      notes.includes('\uD83D\uDE00 kept'),
    json(notes.match(/bad.*kept/)?.[0])
  ])
}

// --- a crafted file: markup in colour, background and font values -----------
{
  const evil = 'FF0000"&gt;&lt;img src=x onerror=alert(1)&gt;'
  const parts = S.unzipSync(bytes)
  let xml = S.strFromU8(parts['ppt/slides/slide1.xml'])
  // run colour, background colour and font face, each as the parser reads them
  xml = xml.replace(/<a:srgbClr val="F1F5F9">/, `<a:srgbClr val='${evil}'>`)
  xml = xml.replace(
    /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A">/,
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val='${evil}'>`
  )
  xml = xml.replace(
    /<a:latin typeface="[^"]*"/,
    `<a:latin typeface='Arial"&gt;&lt;img src=x onerror=alert(2)&gt;'`
  )
  parts['ppt/slides/slide1.xml'] = S.strToU8(xml)
  const crafted = S.zipSync(parts)
  const craftedRaw = await new P.PPTXParser().buffer2json(crafted)
  const craftedParsed = await new P.PowerPointParser().parseJson(craftedRaw)
  results.push([
    'the parser does hand the crafted values on (the test is live)',
    JSON.stringify([craftedParsed, craftedRaw]).includes('onerror'),
    ''
  ])
  const mapped = S.pptxToPresentation(craftedParsed, craftedRaw)
  // Every style value the mapping produced, wherever it sits.
  const styleValues = []
  const stack = [mapped]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    for (const [key, value] of Object.entries(node)) {
      if (
        typeof value === 'string' &&
        /^(color|fill|stroke|background|fontFamily|textAlign|fontSize)$/.test(key)
      )
        styleValues.push(value)
      else if (value && typeof value === 'object') stack.push(value)
    }
  }
  results.push([
    'no style value from the crafted file carries markup, quotes or a handler',
    styleValues.length > 0 && styleValues.every((v) => !/[<>"'=]|on\w+/i.test(v)),
    json(styleValues)
  ])
  results.push([
    'the crafted run colour and background are dropped',
    !JSON.stringify(mapped).includes('onerror') && mapped.slides[0].background === undefined,
    json(mapped.slides[0].background)
  ])
}

// --- zip limits -------------------------------------------------------------
{
  results.push([
    'a normal presentation is within the import limits',
    S.checkZipLimits(bytes) === null,
    S.checkZipLimits(bytes)
  ])
  const zeros = new Uint8Array(3 * 1024 * 1024)
  // Declares 300 MB in the central directory: refused before anything is inflated.
  const declared = S.zipSync({ 'a.xml': zeros })
  const view = new DataView(declared.buffer, declared.byteOffset, declared.byteLength)
  for (let i = 0; i < declared.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 300 * 1024 * 1024, true)
  }
  const tooBig = S.checkZipLimits(declared)
  results.push([
    'an archive that declares 300 MB is refused',
    /too large/.test(tooBig ?? ''),
    tooBig
  ])
  // Declares 100 bytes but inflates to 3 MB: caught while inflating.
  const lying = S.zipSync({ 'a.xml': zeros })
  const lyingView = new DataView(lying.buffer, lying.byteOffset, lying.byteLength)
  for (let i = 0; i < lying.length - 4; i++) {
    const sig = lyingView.getUint32(i, true)
    if (sig === 0x02014b50) lyingView.setUint32(i + 24, 100, true)
    if (sig === 0x04034b50) lyingView.setUint32(i + 22, 100, true)
  }
  const limits = { maxTotalBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024, maxEntries: 10 }
  const lied = S.checkZipLimits(lying, limits)
  results.push([
    'an archive that lies about its sizes is caught while inflating',
    /too large/.test(lied ?? ''),
    lied
  ])
  const many = {}
  for (let i = 0; i < 12; i++) many[`f${i}.xml`] = S.strToU8('x')
  const tooMany = S.checkZipLimits(S.zipSync(many), limits)
  results.push([
    'an archive with too many entries is refused',
    /too many/.test(tooMany ?? ''),
    tooMany
  ])
  const notZip = S.checkZipLimits(S.strToU8('not a zip at all, just some text'))
  results.push(['a file that is not a zip is refused', /not a valid/.test(notZip ?? ''), notZip])
}

rmSync(outDir, { recursive: true, force: true })
let failures = 0
for (const [what, passed, detail] of results) {
  if (passed) {
    console.log(`[pptx]   ok    ${what}`)
  } else {
    failures++
    console.error(`[pptx]   FAIL  ${what}\n                   ${detail}`)
  }
}
if (failures) {
  console.error(`[pptx] ${failures} failure(s)`)
  process.exit(1)
}
console.log('[pptx] all checks passed')
