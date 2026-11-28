#!/usr/bin/env node
// Search inside Word (.docx) and Excel (.xlsx) files (#136).
//
// Why this exists
//   The multi-file search skipped .docx and .xlsx files without a word: they
//   were not in the default include pattern, not in the list of text
//   extensions, and a zip has NUL bytes, so the binary check dropped them too.
//
//   This bundles src/main/search/officeText.ts (fflate and htmlparser2, no
//   Electron import) with esbuild, builds synthetic packages with fflate and
//   handwritten XML (no file from anyone's disk), and checks that the text
//   of every part is read, once, with a location, and that what must not be
//   read (deleted text, field codes, the VML copy of a text box, phonetic
//   hints) is not. It then runs the search of the main process over a folder
//   holding both packages, through src/main/search/officeSearch.ts.
//
// Usage
//   npm run test:smoke:office-search

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const log = (...args) => console.log('[office-search]', ...args)
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

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-office-search-'))
try {
  const entry = path.join(work, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(repoRoot, 'src/main/search/officeText.ts'))}`,
      `export * from ${JSON.stringify(path.join(repoRoot, 'src/main/search/officeSearch.ts'))}`,
      `export { zipSync, strToU8 } from 'fflate'`
    ].join('\n')
  )
  const compiled = path.join(work, 'office.mjs')
  const build = spawnSync(
    path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${compiled}`,
      `--alias:fflate=${path.join(repoRoot, 'node_modules', 'fflate')}`,
      `--alias:htmlparser2=${path.join(repoRoot, 'node_modules', 'htmlparser2')}`
    ],
    { encoding: 'utf8', cwd: repoRoot }
  )
  if (build.status !== 0) {
    console.error(`[office-search] FAIL: could not compile\n${build.stdout}${build.stderr}`)
    process.exit(1)
  }
  const office = await import(`file://${compiled}`)
  const { extractOfficeText, searchOfficeFile, stripHeaderFooterCodes, zipSync, strToU8 } = office

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
  const run = (text, bold = false) =>
    `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
  const para = (...runs) => `<w:p>${runs.join('')}</w:p>`
  const textBox = (text) =>
    `<w:r><mc:AlternateContent>` +
    `<mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent>${para(run(text))}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${para(run(text))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>` +
    `</mc:AlternateContent></w:r>`

  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W} ${MC}><w:body>` +
        para(run('Ac'), run('me Corp', true)) +
        para(run('Avant '), textBox('Boîte texte'), run(' après')) +
        para(run('Gardé '), `<w:del><w:r><w:delText>supprimé</w:delText></w:r></w:del>`) +
        para(
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>`,
          `<w:r><w:fldChar w:fldCharType="separate"/></w:r>`,
          run('3'),
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
        ) +
        para(
          run('Ligne un'),
          '<w:r><w:br/></w:r>',
          run('ligne deux'),
          '<w:r><w:tab/></w:r>',
          run('R&amp;D')
        ) +
        `<w:tbl><w:tr><w:tc>${para(run('Cellule tableau'))}</w:tc></w:tr></w:tbl>` +
        `<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent>${para(run('Ancienne zone'))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>` +
        `</w:body></w:document>`
    ),
    'word/header1.xml': strToU8(`<w:hdr ${W}>${para(run('Confidentiel société'))}</w:hdr>`),
    'word/footer1.xml': strToU8(`<w:ftr ${W}>${para(run('Pied unique'))}</w:ftr>`),
    'word/footnotes.xml': strToU8(
      `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${para('<w:r><w:separator/></w:r>')}</w:footnote>` +
        `<w:footnote w:id="1">${para(run('Note de bas'))}</w:footnote></w:footnotes>`
    ),
    'word/endnotes.xml': strToU8(
      `<w:endnotes ${W}><w:endnote w:id="1">${para(run('Note de fin'))}</w:endnote></w:endnotes>`
    ),
    'word/comments.xml': strToU8(
      `<w:comments ${W}><w:comment w:id="0" w:author="A">${para(run('Remarque relecteur'))}</w:comment></w:comments>`
    ),
    'word/styles.xml': strToU8(
      `<w:styles ${W}>${para(run('Acme Corp in a style, not text'))}</w:styles>`
    )
  })

  log('docx')
  const doc = extractOfficeText(docx, 'docx')
  check('a docx is read', doc.ok, true)
  const find = (segments, needle) => segments.filter((s) => s.text.includes(needle))
  const labels = (segments, needle) => find(segments, needle).map((s) => s.label)
  check('a word split across runs is one paragraph', labels(doc.segments, 'Acme Corp'), [
    'body, paragraph 1'
  ])
  check('header', labels(doc.segments, 'Confidentiel société'), ['header 1, paragraph 1'])
  check('footer', labels(doc.segments, 'Pied unique'), ['footer 1, paragraph 1'])
  check('footnote', labels(doc.segments, 'Note de bas'), ['footnote 1, paragraph 1'])
  check('endnote', labels(doc.segments, 'Note de fin'), ['endnote 1, paragraph 1'])
  check('comment', labels(doc.segments, 'Remarque relecteur'), ['comment 0, paragraph 1'])
  check(
    'a text box stored as DrawingML and VML is read once, with its anchor',
    labels(doc.segments, 'Boîte texte'),
    ['text box 1 (body, paragraph 2), paragraph 1']
  )
  check(
    'the paragraph around a text box keeps its own text',
    find(doc.segments, 'Avant').map((s) => s.text),
    ['Avant  après']
  )
  check('a VML-only text box (older files) is read', labels(doc.segments, 'Ancienne zone'), [
    'text box 2 (body, paragraph 7), paragraph 1'
  ])
  check('deleted tracked text is not read', find(doc.segments, 'supprimé').length, 0)
  check(
    'field codes are not read, field results are',
    [find(doc.segments, 'PAGE').length, find(doc.segments, '3').length],
    [0, 1]
  )
  check(
    'breaks, tabs and entities',
    find(doc.segments, 'Ligne un')[0]?.text,
    'Ligne un\nligne deux\tR&D'
  )
  check('table cells are paragraphs of the body', labels(doc.segments, 'Cellule tableau'), [
    'body, paragraph 6'
  ])
  check('styles are not document text', find(doc.segments, 'in a style').length, 0)

  log('xlsx')
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const xlsx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      `<workbook ${NS} ${R}><sheets><sheet name="Données" sheetId="1" r:id="rId1"/></sheets>` +
        `<definedNames><definedName name="TauxTVA">Données!$B$1</definedName></definedNames></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst ${NS}><si><r><t>Société </t></r><r><rPr><b/></rPr><t>générale</t></r></si>` +
        `<si><t>Tokyo</t><rPh sb="0" eb="1"><t>トウキョウ</t></rPh></si></sst>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet ${NS} ${R}><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>0.2</v></c><c r="C1" t="s"><v>1</v></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>Chaîne en ligne</t></is></c><c r="B2" t="b"><v>1</v></c></row>` +
        `<row r="3"><c r="B3"><f>B1*TauxTVA</f><v>0.04</v></c></row>` +
        `<row r="4"><c r="B4"><f t="shared" ref="B4:B5" si="0">SUM(B1:B2)</f><v>1.2</v></c></row>` +
        `<row r="5"><c r="B5"><f t="shared" si="0"/><v>1.2</v></c></row>` +
        `<row r="6"><c r="A6" t="str"><f>"Total "&amp;A1</f><v>Total texte</v></c></row>` +
        `</sheetData><headerFooter><oddHeader>&amp;L&amp;"Arial,Bold"Confidentiel&amp;R&amp;P</oddHeader></headerFooter>` +
        `<drawing r:id="rId2"/></worksheet>`
    ),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>`
    ),
    'xl/comments1.xml': strToU8(
      `<comments ${NS}><authors><author>A</author></authors><commentList><comment ref="B3" authorId="0"><text><r><t>Vérifier le taux</t></r></text></comment></commentList></comments>`
    ),
    'xl/threadedComments/threadedComment1.xml': strToU8(
      `<ThreadedComments><threadedComment ref="A1" id="{1}"><text>Discussion fil</text></threadedComment></ThreadedComments>`
    ),
    'xl/drawings/drawing1.xml': strToU8(
      `<xdr:wsDr xmlns:xdr="x" xmlns:a="a"><xdr:twoCellAnchor><xdr:sp><xdr:txBody><a:p><a:r><a:t>Zone </a:t></a:r><a:r><a:t>de texte</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:twoCellAnchor></xdr:wsDr>`
    )
  })
  const book = extractOfficeText(xlsx, 'xlsx')
  check('an xlsx is read', book.ok, true)
  check('sheet name', labels(book.segments, 'Données').slice(0, 1), ['sheet name'])
  check('defined name', labels(book.segments, 'TauxTVA ='), ['defined name TauxTVA'])
  check('rich text split in two runs', labels(book.segments, 'Société générale'), ['Données!A1'])
  check('phonetic hints are not read', find(book.segments, 'トウ').length, 0)
  check('inline string', labels(book.segments, 'Chaîne en ligne'), ['Données!A2'])
  check('numbers as stored', labels(book.segments, '0.2'), ['Données!B1'])
  check(
    'booleans',
    find(book.segments, 'TRUE').map((s) => s.label),
    ['Données!B2']
  )
  check('formula', labels(book.segments, '=B1*TauxTVA'), ['Données!B3 (formula)'])
  check('a shared formula is reported on its master cell only', labels(book.segments, 'SUM('), [
    'Données!B4 (formula)'
  ])
  check('a formula string result', labels(book.segments, 'Total texte'), ['Données!A6'])
  check('comment', labels(book.segments, 'Vérifier le taux'), ['Données!B3 (comment)'])
  check('threaded comment', labels(book.segments, 'Discussion fil'), [
    'Données!A1 (threaded comment)'
  ])
  check(
    'header, codes removed',
    find(book.segments, 'Confidentiel').map((s) => [s.label, s.text]),
    [['Données (odd header)', 'Confidentiel']]
  )
  check('shape text', labels(book.segments, 'Zone de texte'), ['Données, shape 1, paragraph 1'])
  check(
    'header and footer codes',
    stripHeaderFooterCodes('&C&"Arial"&12Page &P of &N && co'),
    'Page of & co'
  )

  log('limits and broken files')
  const notZip = extractOfficeText(strToU8('not a zip at all'), 'docx')
  check('a file that is not a package is refused, without throwing', notZip.ok, false)
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(3 * 1024 * 1024) })
  check(
    'a package that unpacks past the limits is refused',
    extractOfficeText(bomb, 'docx', {
      maxTotalBytes: 1024 * 1024,
      maxEntryBytes: 1024 * 1024,
      maxEntries: 10
    }).ok,
    false
  )
  const brokenXml = zipSync({
    'word/document.xml': strToU8(
      `<w:document ${W}><w:body>${para(run('Encore lisible'))}<w:p><w:r>`
    )
  })
  check('unclosed XML still yields what it holds', extractOfficeText(brokenXml, 'docx').ok, true)

  log('search over a folder')
  const folder = path.join(work, 'folder')
  mkdirSync(folder)
  writeFileSync(path.join(folder, 'Contrat.docx'), docx)
  writeFileSync(path.join(folder, 'Budget.xlsx'), xlsx)
  const regex = /TauxTVA/gi
  const fromBook = searchOfficeFile(path.join(folder, 'Budget.xlsx'), xlsx, regex, 100)
  check(
    'TauxTVA matches the defined name and the formula',
    fromBook.matches.map((m) => m.location.label),
    ['defined name TauxTVA', 'Données!B3 (formula)']
  )
  const fromDoc = searchOfficeFile(path.join(folder, 'Contrat.docx'), docx, /acme corp/gi, 100)
  check(
    'a match carries its part, its label and its text around',
    [fromDoc.matches[0]?.location, fromDoc.matches[0]?.match, fromDoc.matches[0]?.after],
    [{ part: 'word/document.xml', label: 'body, paragraph 1' }, 'Acme Corp', '']
  )
  check(
    'a broken package reports why',
    searchOfficeFile('x.docx', strToU8('nope'), /a/g, 10).skipped !== undefined,
    true
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.error(`[office-search] ${failures} check(s) failed`)
  process.exit(1)
}
log('all checks passed')
