import { strToU8, zipSync } from 'fflate'
import { ShapeType } from '../../../../utils/canvas.types'
import type { DynadocElement, DynadocPresentation, DynadocSlide } from './presentationImport'
import { SLIDE_HEIGHT, SLIDE_THEMES, SLIDE_WIDTH, getSlideTheme } from './slideDesign'
import { elementTextStyle, type SlideData, type SlideElement, type TextBlock } from './slideContent'
import { safeCssColor, safeFontFamily, safeTextAlign } from './cssValues'

// .pptx both ways. Export writes the OOXML parts itself and zips them with
// fflate (already a dependency). Import maps what @cliftonc/pptx-to-json
// parses into the DynadocPresentation shape presentationImport.ts turns into
// slide files. Pure (no DOM, no Node) so tests/smoke/slides.test.mjs runs it.

// What pptx-to-json parses, and the raw XML tree it unzips, are untyped JSON;
// every value is checked or coerced where it is read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** EMU per CSS pixel at 96 dpi. */
export const EMU_PER_PX = 9525

const emu = (px: number): number => Math.round((Number(px) || 0) * EMU_PER_PX)

const xmlEscape = (value: string): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 does not allow: C0 controls other than tab, LF and
    // CR, lone surrogates (a pair is kept), U+FFFE and U+FFFF.
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      ''
    )

const NAMED_COLORS: Record<string, string> = {
  white: 'FFFFFF',
  black: '000000',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  gray: '808080',
  grey: '808080'
}

/** A CSS colour as OOXML hex (RRGGBB) and alpha (0..1); null when transparent or unknown. */
export function cssColorToHex(value: Json): { hex: string; alpha: number } | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v || v === 'transparent' || v === 'none') return null
  if (NAMED_COLORS[v]) return { hex: NAMED_COLORS[v], alpha: 1 }
  let m = v.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length === 6) return { hex: h.toUpperCase(), alpha: 1 }
    if (h.length === 8)
      return { hex: h.slice(0, 6).toUpperCase(), alpha: parseInt(h.slice(6), 16) / 255 }
    return null
  }
  m = v.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    const hex = parts
      .slice(0, 3)
      .map((n) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
      .toUpperCase()
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    return alpha <= 0 ? null : { hex, alpha }
  }
  return null
}

function colorXml(value: Json): string {
  const c = cssColorToHex(value)
  if (!c) return ''
  const alpha = c.alpha < 1 ? `<a:alpha val="${Math.round(c.alpha * 100000)}"/>` : ''
  return `<a:srgbClr val="${c.hex}">${alpha}</a:srgbClr>`
}

const solidFill = (value: unknown): string => {
  const color = colorXml(value)
  return color ? `<a:solidFill>${color}</a:solidFill>` : ''
}

/**
 * Dynadoc (Konva) rotates a box about its top-left corner; OOXML about its
 * centre. Both functions return the other side's top-left.
 */
export function rotationToOoxml(
  x: number,
  y: number,
  w: number,
  h: number,
  deg: number
): { x: number; y: number } {
  if (!deg) return { x, y }
  const a = (deg * Math.PI) / 180
  const cx = x + (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a)
  const cy = y + (w / 2) * Math.sin(a) + (h / 2) * Math.cos(a)
  return { x: cx - w / 2, y: cy - h / 2 }
}

export function rotationFromOoxml(
  x: number,
  y: number,
  w: number,
  h: number,
  deg: number
): { x: number; y: number } {
  if (!deg) return { x, y }
  const a = (deg * Math.PI) / 180
  const cx = x + w / 2
  const cy = y + h / 2
  return {
    x: cx - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a),
    y: cy - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a)
  }
}

function xfrm(el: SlideElement, extra = ''): string {
  const rotation = Number(el.rotation) || 0
  const w = Math.abs(Number(el.w) || 0)
  const h = Math.abs(Number(el.h) || 0)
  const pos = rotationToOoxml(Number(el.x) || 0, Number(el.y) || 0, w, h, rotation)
  const rot = rotation ? ` rot="${Math.round((((rotation % 360) + 360) % 360) * 60000)}"` : ''
  return `<a:xfrm${rot}${extra}><a:off x="${emu(pos.x)}" y="${emu(pos.y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`
}

// ---------------------------------------------------------------- text ------

/** A font size in px as OOXML `sz` (hundredths of a point), within the schema's 100..400000. */
const pxToHundredthsPt = (px: number): number =>
  Math.min(400000, Math.max(100, Math.round((Number(px) || 0) * 0.75 * 100)))

function runXml(
  run: TextBlock['runs'][number],
  base: { fontSize: number; fontFamily: string; color: string }
): string {
  const attrs = [
    'lang="en-US"',
    `sz="${pxToHundredthsPt(run.fontSize ?? base.fontSize)}"`,
    run.bold ? 'b="1"' : '',
    run.italic ? 'i="1"' : '',
    run.underline ? 'u="sng"' : '',
    run.strike ? 'strike="sngStrike"' : '',
    'dirty="0"'
  ]
    .filter(Boolean)
    .join(' ')
  const face = xmlEscape(run.fontFamily || base.fontFamily)
  const highlight =
    run.highlight && colorXml(run.highlight)
      ? `<a:highlight>${colorXml(run.highlight)}</a:highlight>`
      : ''
  const props = `<a:rPr ${attrs}>${solidFill(run.color || base.color)}${highlight}<a:latin typeface="${face}"/><a:cs typeface="${face}"/></a:rPr>`
  return run.text
    .split('\n')
    .map((part) => (part ? `<a:r>${props}<a:t>${xmlEscape(part)}</a:t></a:r>` : ''))
    .join('<a:br>' + props + '</a:br>')
}

const ALIGN: Record<string, string> = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }

export function blocksToParagraphXml(
  blocks: TextBlock[],
  base: { fontSize: number; fontFamily: string; color: string }
): string {
  if (!blocks.length) blocks = [{ kind: 'paragraph', level: 1, runs: [] }]
  return blocks
    .map((block) => {
      const algn = block.align && ALIGN[block.align] ? ` algn="${ALIGN[block.align]}"` : ''
      let pPr = `<a:pPr${algn}><a:buNone/></a:pPr>`
      if (block.kind === 'bullet' || block.kind === 'number') {
        const level = Math.max(0, block.level)
        const marL = 342900 * (level + 1)
        // The marker takes the colour of the item's text, written out so that
        // readers which default it to the master's text colour agree.
        const markerColor = colorXml(block.runs[0]?.color || base.color)
        const bullet =
          (markerColor ? `<a:buClr>${markerColor}</a:buClr>` : '') +
          (block.kind === 'bullet'
            ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>'
            : '<a:buAutoNum type="arabicPeriod"/>')
        pPr = `<a:pPr marL="${marL}" lvl="${Math.min(8, level)}" indent="-342900"${algn}>${bullet}</a:pPr>`
      }
      // A heading is bold on the slide (static HTML and editor both draw h1 at 700).
      const runs = block.runs
        .map((run) => runXml(block.kind === 'heading' ? { ...run, bold: true } : run, base))
        .join('')
      const end = `<a:endParaRPr lang="en-US" sz="${pxToHundredthsPt(block.runs[0]?.fontSize ?? base.fontSize)}" dirty="0"/>`
      return `<a:p>${pPr}${runs}${end}</a:p>`
    })
    .join('')
}

// ---------------------------------------------------------------- shapes ----

const PRESET: Record<string, string> = {
  [ShapeType.Rect]: 'rect',
  [ShapeType.Ellipse]: 'ellipse',
  [ShapeType.Circle]: 'ellipse',
  [ShapeType.Triangle]: 'triangle'
}

type Media = { name: string; rId: string }

function shapeXml(el: SlideElement, id: number, themeId: string, media?: Media): string {
  const name = xmlEscape(el.name || `Shape ${id}`)
  if (el.type === ShapeType.File) {
    if (!media) return ''
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${media.rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  }
  if (el.type === ShapeType.Line) {
    const flip = `${(Number(el.w) || 0) < 0 ? ' flipH="1"' : ''}${(Number(el.h) || 0) < 0 ? ' flipV="1"' : ''}`
    const line = `<a:ln w="${emu(Number(el.strokeWidth) || 2)}">${solidFill(el.stroke || '#111827')}</a:ln>`
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(el, flip)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${line}</p:spPr></p:cxnSp>`
  }
  const fill = solidFill(el.fill) || '<a:noFill/>'
  const line = el.stroke
    ? `<a:ln w="${emu(Number(el.strokeWidth) || 1)}">${solidFill(el.stroke)}</a:ln>`
    : '<a:ln><a:noFill/></a:ln>'
  if (PRESET[el.type as string]) {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="${PRESET[el.type as string]}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>`
  }
  // Text box. Titles are a title placeholder so PowerPoint (and the
  // importer) know the slide's title; the rest are plain text boxes.
  const base = elementTextStyle(el, themeId)
  const ph = el.role === 'title' ? '<p:ph type="title"/>' : ''
  const inset = emu(6)
  const body = `<a:bodyPr wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${blocksToParagraphXml(el.blocks ?? [], base)}`
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${ph ? '' : ' txBox="1"'}>${ph ? '<a:spLocks noGrp="1"/>' : ''}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solidFill(el.fill) || '<a:noFill/>'}</p:spPr><p:txBody>${body}</p:txBody></p:sp>`
}

function backgroundXml(background: Json): string {
  let fill = ''
  if (
    background &&
    typeof background === 'object' &&
    Array.isArray(background.stops || background.Stops)
  ) {
    const stopList: Json[] = background.stops || background.Stops
    const stops = stopList
      .map((stop: Json) => {
        const color = colorXml(stop.color ?? stop.Color)
        const pos = Math.round(
          Math.max(0, Math.min(1, Number(stop.position ?? stop.Position ?? 0))) * 100000
        )
        return color ? `<a:gs pos="${pos}">${color}</a:gs>` : ''
      })
      .join('')
    const angle = Number(background.angle ?? background.Angle ?? 180)
    // CSS 180deg (top to bottom) is OOXML 90deg.
    const ang = Math.round(((((angle - 90) % 360) + 360) % 360) * 60000)
    // A gradient needs two stops at least; one valid stop is a solid fill.
    const valid = stopList.filter((stop: Json) => colorXml(stop?.color ?? stop?.Color))
    if (valid.length >= 2)
      fill = `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`
    else if (valid.length === 1) fill = solidFill(valid[0].color ?? valid[0].Color)
  } else {
    const value =
      typeof background === 'string' ? background : background?.color || background?.fill
    const css =
      typeof value === 'string'
        ? (value.match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/i)?.[0] ?? value)
        : value
    fill = solidFill(css)
  }
  return fill ? `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>` : ''
}

// ---------------------------------------------------------------- package ---

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument'

const rels = (items: [string, string, string][]): string =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"/>`
    )
    .join('')}</Relationships>`

const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

function themeXml(name: string, major: string, minor: string, accent: string): string {
  const accentHex = cssColorToHex(accent)?.hex ?? '4472C4'
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const line = (w: number): string =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xmlEscape(name)}"><a:themeElements><a:clrScheme name="${xmlEscape(name)}"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="${accentHex}"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="${xmlEscape(name)}"><a:majorFont><a:latin typeface="${xmlEscape(major)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${xmlEscape(minor)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="${xmlEscape(name)}"><a:fillStyleLst>${fills}${fills}${fills}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fills}${fills}${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
}

export type PptxImage = { data: Uint8Array; ext: string }

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp'
  // No svg: an SVG must reach buildPptx already rasterised to PNG (see
  // pptxExport.ts); a bare SVG blip is not valid for PowerPoint.
}

/**
 * The deck as a .pptx file. `loadImage` reads an image element's bytes (null
 * leaves the image out). Variables are already resolved in `slides`.
 */
export async function buildPptx(
  slides: SlideData[],
  loadImage: (src: string) => Promise<PptxImage | null>,
  options: { title?: string } = {}
): Promise<Uint8Array> {
  const width = slides[0]?.width || SLIDE_WIDTH
  const height = slides[0]?.height || SLIDE_HEIGHT
  const theme = getSlideTheme(slides[0]?.themeId)
  const files: Record<string, Uint8Array> = {}
  const put = (path: string, text: string): Uint8Array => (files[path] = strToU8(text))
  const imageExts = new Set<string>()
  let mediaCount = 0

  const slideRefs: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const n = i + 1
    const slide = slides[i]
    const slideRels: [string, string, string][] = [
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]
    ]
    let shapeId = 2
    const shapes: string[] = []
    for (const el of slide.elements) {
      let media: Media | undefined
      if (el.type === ShapeType.File) {
        const image = el.src ? await loadImage(el.src) : null
        if (!image || !IMAGE_TYPES[image.ext]) continue
        mediaCount++
        imageExts.add(image.ext)
        const mediaName = `image${mediaCount}.${image.ext}`
        files[`ppt/media/${mediaName}`] = image.data
        media = { name: mediaName, rId: `rId${slideRels.length + 1}` }
        slideRels.push([media.rId, 'image', `../media/${mediaName}`])
      }
      const xml = shapeXml(el, shapeId, slide.themeId, media)
      if (xml) {
        shapes.push(xml)
        shapeId++
      }
    }
    put(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld ${NS}><p:cSld>${backgroundXml(slide.background)}${EMPTY_TREE}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    )
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(slideRels))
    const notes = blocksToParagraphXml(
      (slide.notes || '')
        .split('\n')
        .map((line) => ({ kind: 'paragraph', level: 1, runs: line ? [{ text: line }] : [] })),
      { fontSize: 16, fontFamily: theme.bodyFont, color: '#000000' }
    )
    put(
      `ppt/notesSlides/notesSlide${n}.xml`,
      `${XML}<p:notes ${NS}><p:cSld>${EMPTY_TREE}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notes}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
    )
    put(
      `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      rels([
        ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
        ['rId2', 'slide', `../slides/slide${n}.xml`]
      ])
    )
    slideRefs.push(`ppt/slides/slide${n}.xml`)
  }

  const presRels: [string, string, string][] = [
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'],
    ['rId4', 'presProps', 'presProps.xml'],
    ['rId5', 'viewProps', 'viewProps.xml'],
    ['rId6', 'tableStyles', 'tableStyles.xml']
  ]
  const sldIds = slides
    .map((_, i) => {
      const rId = `rId${presRels.length + 1}`
      presRels.push([rId, 'slide', `slides/slide${i + 1}.xml`])
      return `<p:sldId id="${256 + i}" r:id="${rId}"/>`
    })
    .join('')
  put(
    'ppt/presentation.xml',
    `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${emu(width)}" cy="${emu(height)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`
  )
  put('ppt/_rels/presentation.xml.rels', rels(presRels))
  put('ppt/presProps.xml', `${XML}<p:presentationPr ${NS}/>`)
  put(
    'ppt/viewProps.xml',
    `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`
  )
  put(
    'ppt/tableStyles.xml',
    `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
  )
  put('ppt/theme/theme1.xml', themeXml(theme.name, theme.titleFont, theme.bodyFont, theme.accent))
  put('ppt/theme/theme2.xml', themeXml('Notes', theme.bodyFont, theme.bodyFont, theme.accent))
  const level1 = (sz: number): string =>
    `<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`
  put(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${level1(4400)}</p:titleStyle><p:bodyStyle>${level1(2400)}</p:bodyStyle><p:otherStyle>${level1(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`
  )
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml']
    ])
  )
  put(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  )
  put(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  )
  put(
    'ppt/notesMasters/notesMaster1.xml',
    `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${level1(1200)}</p:notesStyle></p:notesMaster>`
  )
  put(
    'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    rels([['rId1', 'theme', '../theme/theme2.xml']])
  )
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  put(
    'docProps/core.xml',
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(options.title || 'Presentation')}</dc:title><dc:creator>Dynadoc</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  )
  put(
    'docProps/app.xml',
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Dynadoc</Application><Slides>${slides.length}</Slides><Notes>${slides.length}</Notes></Properties>`
  )
  put(
    '_rels/.rels',
    rels([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      [
        'rId2',
        'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
        'docProps/core.xml'
      ],
      ['rId3', 'extended-properties', 'docProps/app.xml']
    ])
  )
  const over = (part: string, type: string): string =>
    `<Override PartName="/${part}" ContentType="${type}"/>`
  const overrides = [
    over('ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`),
    over('ppt/presProps.xml', `${CT}.presentationml.presProps+xml`),
    over('ppt/viewProps.xml', `${CT}.presentationml.viewProps+xml`),
    over('ppt/tableStyles.xml', `${CT}.presentationml.tableStyles+xml`),
    over('ppt/theme/theme1.xml', `${CT}.theme+xml`),
    over('ppt/theme/theme2.xml', `${CT}.theme+xml`),
    over('ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`),
    over('ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`),
    over('ppt/notesMasters/notesMaster1.xml', `${CT}.presentationml.notesMaster+xml`),
    ...slideRefs.map((part) => over(part, `${CT}.presentationml.slide+xml`)),
    ...slides.map((_, i) =>
      over(`ppt/notesSlides/notesSlide${i + 1}.xml`, `${CT}.presentationml.notesSlide+xml`)
    ),
    over('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'),
    over('docProps/app.xml', `${CT}.extended-properties+xml`)
  ]
  const defaults = [...imageExts].map(
    (ext) => `<Default Extension="${ext}" ContentType="${IMAGE_TYPES[ext]}"/>`
  )
  put(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults.join('')}${overrides.join('')}</Types>`
  )
  // [Content_Types].xml first, as Office writes it.
  const ordered: Record<string, Uint8Array> = {
    '[Content_Types].xml': files['[Content_Types].xml']
  }
  for (const [path, data] of Object.entries(files))
    if (path !== '[Content_Types].xml') ordered[path] = data
  return zipSync(ordered, { level: 6 })
}

// ---------------------------------------------------------------- import ----

/** pptx-to-json drops leading zeros of some colours ("#59669" for #059669). */
export function normalizeImportedColor(value: Json): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v || v === 'transparent' || v === 'none') return undefined
  const m = v.match(/^#?([0-9a-fA-F]{1,6})$/)
  if (m && (v.startsWith('#') || m[1].length === 6))
    return `#${m[1].padStart(6, '0').toUpperCase()}`
  // Anything else only when it is a valid CSS colour.
  return safeCssColor(v) ?? undefined
}

const ptToPx = (value: Json, scale: number): number | undefined => {
  const num = parseFloat(String(value ?? ''))
  return Number.isFinite(num) && num > 0 ? Math.round(num * scale * 10) / 10 : undefined
}

/** Rewrites a pptx-to-json rich text doc into this editor's marks (textStyle, px). */
function mapRichText(doc: Json, style: Json, scale: number, isTitle: boolean): Json {
  const baseSize = ptToPx(style?.fontSize, scale)
  // pptx-to-json fills `style` from the first run. Its colour is the box's
  // only when no run has a colour of its own; otherwise it would spread the
  // first run's colour to every run.
  const anyRunColor = JSON.stringify(doc ?? {}).includes('"color":')
  const baseColor = anyRunColor ? undefined : normalizeImportedColor(style?.color)
  const baseFont = safeFontFamily(style?.fontFamily)
  const align = style?.textAlign !== 'left' ? safeTextAlign(style?.textAlign) : null
  const visit = (node: Json): Json => {
    if (!node || typeof node !== 'object') return node
    const next: Json = { ...node }
    if (node.type === 'text') {
      const attrs: Record<string, Json> = {}
      for (const mark of node.marks ?? []) {
        if (mark?.type === 'bold') attrs.fontWeight = 'bold'
        else if (mark?.type === 'italic') attrs.fontStyle = 'italic'
        else if (mark?.type === 'underline') attrs.textDecoration = 'underline'
        else if (mark?.type === 'strike') attrs.textDecoration = 'line-through'
        else if (mark?.type === 'textStyle') {
          const a = mark.attrs || {}
          const color = normalizeImportedColor(a.color)
          if (color) attrs.color = color
          const fontFamily = safeFontFamily(a.fontFamily)
          if (fontFamily) attrs.fontFamily = fontFamily
          const size = ptToPx(a.fontSize, scale)
          if (size) attrs.fontSize = `${size}px`
        }
      }
      if (!attrs.fontSize && baseSize) attrs.fontSize = `${baseSize}px`
      if (!attrs.color && baseColor && baseColor !== '#000000') attrs.color = baseColor
      if (!attrs.fontFamily && baseFont) attrs.fontFamily = baseFont
      if (!attrs.fontWeight && style?.fontWeight === 'bold' && isTitle) attrs.fontWeight = 'bold'
      next.marks = Object.keys(attrs).length ? [{ type: 'textStyle', attrs }] : []
      return next
    }
    if ((node.type === 'paragraph' || node.type === 'heading') && align) {
      next.attrs = { ...(node.attrs || {}), textAlign: align }
    }
    if (Array.isArray(node.content)) next.content = node.content.map(visit)
    return next
  }
  const mapped = visit(doc && doc.type === 'doc' ? doc : { type: 'doc', content: [] })
  if (isTitle && mapped.content?.[0]?.type === 'paragraph') {
    // Same structure as a title typed in Dynadoc.
    mapped.content[0] = {
      ...mapped.content[0],
      type: 'heading',
      attrs: { ...(mapped.content[0].attrs || {}), level: 1 }
    }
  }
  return mapped
}

const SHAPE_KINDS: Record<string, string> = {
  rectangle: 'rect',
  rect: 'rect',
  roundrect: 'rect',
  ellipse: 'ellipse',
  oval: 'ellipse',
  circle: 'ellipse',
  triangle: 'triangle',
  isoscelestriangle: 'triangle',
  line: 'line'
}

/** Reads `p:bg` of a slide from the raw parts pptx-to-json unzipped. */
function rawSlideBackground(
  raw: Record<string, Json>,
  slideFile?: string | null
): string | undefined {
  if (!slideFile) return undefined
  const bg = raw?.[slideFile]?.['p:sld']?.['p:cSld']?.['p:bg']
  const hex = bg?.['p:bgPr']?.['a:solidFill']?.['a:srgbClr']?.['$val']
  return typeof hex === 'string' && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : undefined
}

/**
 * Maps pptx-to-json's parse (`parsed`) and raw parts (`raw`, from
 * PPTXParser.buffer2json) into a DynadocPresentation at 1280 px wide.
 * Images keep the data: URIs the parser produces; the caller writes them out.
 */
export function pptxToPresentation(parsed: Json, raw: Record<string, Json>): DynadocPresentation {
  const sldSz = raw?.['ppt/presentation.xml']?.['p:presentation']?.['p:sldSz']
  const cx = Number(sldSz?.['$cx']) || 12192000
  const cy = Number(sldSz?.['$cy']) || 6858000
  // Component geometry comes in px at 96 dpi (EMU / 9525, as slideDimensions),
  // font sizes in points; slides here are 1280 px wide.
  const scale = SLIDE_WIDTH / (Number(parsed?.slideDimensions?.width) || cx / EMU_PER_PX)
  const fontScale = (96 / 72) * scale
  const widthPx = SLIDE_WIDTH
  const heightPx = Math.round((SLIDE_WIDTH * cy) / cx)

  const slides: DynadocSlide[] = (parsed?.slides ?? []).map((slide: Json, index: number) => {
    let titleTaken = false
    const elements: DynadocElement[] = []
    const components = [...(slide.components ?? [])].sort(
      (a: Json, b: Json) => (a.zIndex ?? 0) - (b.zIndex ?? 0)
    )
    for (const comp of components) {
      const w = (Number(comp.width) || 0) * scale
      const h = (Number(comp.height) || 0) * scale
      const rotation = Number(comp.rotation ?? comp.style?.rotation) || 0
      const pos = rotationFromOoxml(
        (Number(comp.x) || 0) * scale,
        (Number(comp.y) || 0) * scale,
        w,
        h,
        rotation
      )
      const box = { x: pos.x, y: pos.y, width: w, height: h, rotation }
      if (comp.type === 'image' && comp.src) {
        elements.push({ ...box, type: 'image', name: comp.alt || 'Image', src: comp.src })
      } else if (comp.type === 'text') {
        const isTitle =
          !titleTaken &&
          !!slide.title &&
          String(comp.content ?? '').trim() === String(slide.title).trim()
        titleTaken = titleTaken || isTitle
        const bg = comp.backgroundShape?.fill?.color
        elements.push({
          ...box,
          type: 'text',
          name: isTitle ? 'Title' : 'Text',
          role: isTitle ? 'title' : undefined,
          text: comp.content ?? '',
          tiptapContent: mapRichText(comp.richText, comp.style, fontScale, isTitle),
          fill: normalizeImportedColor(bg) ?? null
        } as DynadocElement)
      } else if (comp.type === 'shape' || comp.type === 'connection') {
        const kind = String(
          comp.shapeType ?? comp.geometry?.preset ?? comp.geometry?.type ?? ''
        ).toLowerCase()
        const isLine = comp.type === 'connection' || SHAPE_KINDS[kind] === 'line'
        elements.push({
          ...box,
          type: 'shape',
          name: comp.content || 'Shape',
          shape: isLine ? 'line' : (SHAPE_KINDS[kind] ?? 'rect'),
          fill: isLine ? null : (normalizeImportedColor(comp.style?.fillColor) ?? null),
          stroke:
            normalizeImportedColor(comp.style?.borderColor ?? comp.style?.color) ??
            (isLine ? '#111827' : null),
          strokeWidth:
            (Number(comp.style?.borderWidth ?? comp.style?.lineWidth) || 0) * scale ||
            (isLine ? 2 : null)
        })
      }
    }
    return {
      id: undefined,
      slideIndex: index,
      name: slide.title || `Slide ${index + 1}`,
      notes: slide.notes ?? null,
      background: rawSlideBackground(raw, slide.metadata?.slideFile),
      elements
    }
  })
  // A deck exported from here names its theme (theme1.xml); bring it back, so
  // the slides get the theme's text colour, fonts and list markers again.
  const themeName = raw?.['ppt/theme/theme1.xml']?.['a:theme']?.['$name']
  const themeId =
    typeof themeName === 'string'
      ? SLIDE_THEMES.find((theme) => theme.name.toLowerCase() === themeName.toLowerCase())?.id
      : undefined
  return { version: '1', widthPx, heightPx, themeId, slides }
}
