import fs from 'node:fs'
import path from 'node:path'
import { canvasResetCss } from '../shared/reset'
import { RENDER_TAGS } from '../shared/tags'
import type { FontFaceDef, PNode, Styles, StyleValue } from '../shared/types'
import { extFor, importAssetUrl, storeBuffer } from './assets'
import { ROOT_DIR } from './config'
import { wait, type Page } from './browser'
import { engine } from './engine'
import { sanitizeSvgMarkup } from './html'
import type { OpenFile } from './workspace'

// URL import: load a live page in a hidden window, walk its rendered DOM
// (extract.js), recover authored sizing from the page's CSS via the DevTools
// protocol so layouts stay fluid, pull images and web fonts into local
// storage, and turn the result into design nodes.

const EXTRACT_SRC = fs
  .readFileSync(path.join(ROOT_DIR, 'src/server/import/extract.js'), 'utf8')
  .replace(/^[\s\S]*?export default /, '')

const MAX_NODES = 6000

const MAX_ASSETS = 250

const MAX_ASSET_BYTES = 12 * 1024 * 1024

const MAX_FONT_FILES = 40

interface XNode {
  i: number
  tag: string
  type: 'Frame' | 'Text' | 'Image' | 'SVG'
  name?: string | null
  styles: Record<string, string>
  sz?: Record<string, string>
  fixedSize?: boolean
  text?: string
  src?: string
  alt?: string | null
  svg?: string
  href?: string
  role?: string
  fixed?: { top: number; left: number; width: number }
  colSpan?: number
  rowSpan?: number
  sticky?: boolean
  children: XNode[]
}

interface Extracted {
  title: string
  url: string
  width: number
  height: number
  rootFontSize: number
  rootStyles: Record<string, string>
  root: XNode
  count: number
  marked: number
  truncated: boolean
  families: string[]
}

export interface ImportResult {
  nodes: PNode[]
  fontFaces: FontFaceDef[]
  title: string
  stats: { layers: number; images: number; imagesFailed: number; fonts: number; ms: number }
  warnings: string[]
}

type Progress = (label: string, pct: number) => void

export async function importUrl(
  f: OpenFile,
  opts: { url: string; width?: number; name?: string; onProgress?: Progress },
): Promise<ImportResult> {
  const t0 = Date.now()
  const progress = opts.onProgress ?? (() => {})
  const url = normalizeUrl(opts.url)
  const width = Math.max(320, Math.min(2560, Math.round(opts.width ?? 1440)))
  const warnings: string[] = []

  const page = await engine.openImportPage(width)

  try {
    const sheets = new Map<string, string>()
    page.on('CSS.styleSheetAdded', (e: { header: { styleSheetId: string; sourceURL: string } }) =>
      sheets.set(e.header.styleSheetId, e.header.sourceURL || url),
    )
    await page.send('DOM.enable')
    await page.send('CSS.enable')

    progress('Loading page', 5)
    const status = await page.goto(url)

    if (status && status >= 400) warnings.push(`The page responded with HTTP ${status}.`)
    await page.networkIdle(8000)

    progress('Loading lazy content', 18)
    await page.evaluate(async () => {
      const step = Math.max(400, window.innerHeight * 0.8)

      for (
        let y = step, i = 0;
        i < 40 && y < document.documentElement.scrollHeight + step;
        y += step, i++
      ) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 110))
      }

      window.scrollTo(0, 0)
      await new Promise((r) => setTimeout(r, 250))
    })
    await page.networkIdle(5000)
    await page.evaluate(() => {
      const banners = document.querySelectorAll(
        '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="onetrust" i],[id*="cookiebot" i],[class*="gdpr" i],[id*="usercentrics" i],[class*="cc-window"],[aria-label*="cookie" i]',
      )

      for (const el of banners) {
        const pos = getComputedStyle(el).position

        if (pos === 'fixed' || pos === 'sticky') el.remove()
      }

      for (const a of document.getAnimations()) {
        try {
          a.finish()
        } catch {}
      }
    })
    await wait(250)

    progress('Reading the page', 32)

    // SAFETY: extract.js returns the documented Extracted payload for the given options.
    const data = (await page.evaluate(
      `(${EXTRACT_SRC})(${JSON.stringify({ resetCss: canvasResetCss('body'), maxNodes: MAX_NODES, renderTags: [...RENDER_TAGS] })})`,
    )) as Extracted

    if (data.truncated)
      warnings.push(`The page is very large; only the first ${MAX_NODES} elements were imported.`)

    progress('Reading authored CSS', 45)
    const authored = await authoredSizing(page, data.marked, warnings)

    progress('Building layers', 60)
    const nodes: PNode[] = []
    const urls = new Set<string>()
    const rootId = f.mint()

    const rootStyles = condense({
      ...trimDefaults(data.rootStyles),
      width: `${width}px`,
      height: 'fit-content',
    })

    nodes.push({
      id: rootId,
      type: 'Frame',
      name: (opts.name || data.title || new URL(data.url).hostname).slice(0, 50),
      tag: 'div',
      styles: rootStyles,
      parent: null,
      children: [],
    })
    collectUrls(rootStyles, urls)
    const ctx = { rootFs: data.rootFontSize || 16, authored, urls }

    for (const c of data.root.children) {
      const sub = build(f, c, rootId, ctx)

      if (sub.length) {
        nodes[0].children.push(sub[0].id)
        nodes.push(...sub)
      }
    }

    progress('Downloading images', 70)
    const assetMap = await downloadAssets(page, [...urls], data.url, warnings)
    let imagesOk = 0

    for (const n of nodes) {
      if (n.src && assetMap.has(n.src)) {
        n.src = assetMap.get(n.src)
        imagesOk++
      }

      for (const [k, v] of Object.entries(n.styles))
        if (isStyleString(v) && v.includes('url(')) n.styles[k] = rewriteUrls(v, assetMap)
    }

    progress('Downloading fonts', 88)
    const fontFaces = await downloadFonts(page, sheets, data.families, warnings)

    progress('Placing on canvas', 97)

    return {
      nodes,
      fontFaces,
      title: data.title,
      stats: {
        layers: nodes.length - 1,
        images: imagesOk,
        imagesFailed: [...urls].filter((u) => !assetMap.has(u)).length,
        fonts: fontFaces.length,
        ms: Date.now() - t0,
      },
      warnings,
    }
  } finally {
    await page.close()
  }
}

interface InheritedDefaults {
  [prop: string]: string[]
}

const INHERITED_DEFAULTS: InheritedDefaults = {
  fontStyle: ['normal'],
  letterSpacing: ['normal'],
  wordSpacing: ['0px', 'normal'],
  textAlign: ['start', 'left'],
  textTransform: ['none'],
  textIndent: ['0px'],
  whiteSpace: ['normal'],
  wordBreak: ['normal'],
  overflowWrap: ['normal'],
  textShadow: ['none'],
  fontVariantNumeric: ['normal'],
  fontFeatureSettings: ['normal'],
  fontVariationSettings: ['normal'],
  listStyleType: ['disc'],
  listStylePosition: ['outside'],
  direction: ['ltr'],
  hyphens: ['manual'],
  textWrap: ['wrap'],
  WebkitTextStrokeWidth: ['0px'],
  lineHeight: ['normal'],
}

/** Drop inherited values that are just browser defaults. */
function trimDefaults(styles: Record<string, string>) {
  const out: Record<string, string> = {}

  for (const [k, v] of Object.entries(styles)) {
    if (INHERITED_DEFAULTS[k]?.includes(v)) continue

    if ((k === 'WebkitTextStrokeColor' || k === 'WebkitTextFillColor') && v === styles.color)
      continue
    out[k] = v
  }

  return out
}

function normalizeUrl(input: string): string {
  let u = input.trim()

  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  const parsed = new URL(u)

  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be imported.')

  return parsed.toString()
}

// ---- authored sizing via CDP --------------------------------------------------------

const SIZING = new Set([
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'top',
  'right',
  'bottom',
  'left',
  'flex-basis',
  'grid-template-columns',
  'grid-template-rows',
])

interface LogicalCssMap {
  [logical: string]: string
}

const LOGICAL: LogicalCssMap = {
  'inline-size': 'width',
  'block-size': 'height',
  'min-inline-size': 'min-width',
  'max-inline-size': 'max-width',
  'min-block-size': 'min-height',
  'max-block-size': 'max-height',
  'margin-inline-start': 'margin-left',
  'margin-inline-end': 'margin-right',
  'margin-block-start': 'margin-top',
  'margin-block-end': 'margin-bottom',
  'inset-inline-start': 'left',
  'inset-inline-end': 'right',
  'inset-block-start': 'top',
  'inset-block-end': 'bottom',
}

type Authored = Record<string, { v: string; imp: boolean }>

interface CssProp {
  name: string
  value: string
  important?: boolean
  disabled?: boolean
  parsedOk?: boolean
}

async function authoredSizing(
  cdp: Page,
  expected: number,
  warnings: string[],
): Promise<(Authored | undefined)[]> {
  // SAFETY: DOM.getDocument resolves with a root node id.
  const { root } = (await cdp.send('DOM.getDocument', { depth: 0 })) as {
    root: { nodeId: number }
  }

  // SAFETY: DOM.querySelectorAll resolves with the matching node ids.
  const { nodeIds } = (await cdp.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: '[data-pw-i]',
  })) as { nodeIds: number[] }

  if (nodeIds.length !== expected) {
    warnings.push('Authored CSS could not be matched to every element; some sizes are fixed.')

    return []
  }

  const out: (Authored | undefined)[] = Array.from<Authored | undefined>({
    length: nodeIds.length,
  })

  const BATCH = 80

  for (let s = 0; s < nodeIds.length; s += BATCH) {
    await Promise.all(
      nodeIds.slice(s, s + BATCH).map(async (nodeId, k) => {
        try {
          // SAFETY: CSS.getMatchedStylesForNode resolves with inline, attribute and matched rule styles.
          const r = (await cdp.send('CSS.getMatchedStylesForNode', { nodeId })) as {
            inlineStyle?: { cssProperties: CssProp[] }
            attributesStyle?: { cssProperties: CssProp[] }
            matchedCSSRules?: { rule: { origin: string; style: { cssProperties: CssProp[] } } }[]
          }

          const res: Authored = {}

          const apply = (props: CssProp[]) => {
            for (const p of props) {
              if (p.disabled || p.parsedOk === false) continue
              const name = LOGICAL[p.name] ?? p.name

              if (!SIZING.has(name)) continue
              const imp = !!p.important || /!\s*important/i.test(p.value)
              const v = p.value.replace(/\s*!\s*important\s*$/i, '').trim()

              if (res[name]?.imp && !imp) continue
              res[name] = { v, imp }
            }
          }

          // Presentational attributes (width="85%") rank below author rules.
          if (r.attributesStyle) apply(r.attributesStyle.cssProperties)

          for (const m of r.matchedCSSRules ?? [])
            if (m.rule.origin === 'regular') apply(m.rule.style.cssProperties)

          if (r.inlineStyle) apply(r.inlineStyle.cssProperties)
          out[s + k] = res
        } catch {
          out[s + k] = undefined
        }
      }),
    )
  }

  return out
}

const VIEWPORT_UNITS = /\d(?:vw|vh|vmin|vmax|dvh|svh|lvh|dvw|svw|lvw|cqw|cqh|cqi|cqb)\b/

const SIZE_KEYS: [string, string][] = [
  ['width', 'width'],
  ['height', 'height'],
  ['min-width', 'minWidth'],
  ['min-height', 'minHeight'],
  ['max-width', 'maxWidth'],
  ['max-height', 'maxHeight'],
  ['margin-top', 'marginTop'],
  ['margin-right', 'marginRight'],
  ['margin-bottom', 'marginBottom'],
  ['margin-left', 'marginLeft'],
  ['top', 'top'],
  ['right', 'right'],
  ['bottom', 'bottom'],
  ['left', 'left'],
  ['flex-basis', 'flexBasis'],
  ['grid-template-columns', 'gridTemplateColumns'],
  ['grid-template-rows', 'gridTemplateRows'],
]

function usableSize(v: string | undefined) {
  return !v || v === 'auto' || v === 'none' || v === 'normal' ? null : v
}

function resolveSize(
  prop: string,
  authored: string | undefined,
  computed: string | undefined,
  n: XNode,
  rootFs: number,
): string | null {
  const isMargin = prop.startsWith('margin')
  const emBase = parseFloat(n.sz?._fs ?? '16') || 16

  if (authored !== undefined) {
    if (/^(auto|initial|unset|revert|revert-layer|normal)$/i.test(authored))
      return isMargin && authored === 'auto' ? 'auto' : null

    if (
      authored === 'inherit' ||
      /var\(|env\(|attr\(/.test(authored) ||
      VIEWPORT_UNITS.test(authored)
    )
      return usableSize(computed)

    return authored
      .replace(/(-?\d*\.?\d+)rem\b/g, (_m, v: string) => `${round(Number(v) * rootFs)}px`)
      .replace(/(-?\d*\.?\d+)em\b/g, (_m, v: string) => `${round(Number(v) * emBase)}px`)
  }

  if (isMargin) return computed && computed !== '0px' ? computed : null

  if (n.fixedSize && (prop === 'width' || prop === 'height')) return usableSize(computed)

  return null
}

function round(v: number) {
  return Math.round(v * 100) / 100
}

// ---- node building ------------------------------------------------------------------

interface ImportFrameNameMap {
  [tag: string]: string
}

const FRAME_NAMES: ImportFrameNameMap = {
  div: 'Frame',
  section: 'Section',
  header: 'Header',
  footer: 'Footer',
  nav: 'Nav',
  main: 'Main',
  aside: 'Aside',
  article: 'Article',
  button: 'Button',
  ul: 'List',
  ol: 'List',
  li: 'List Item',
  form: 'Form',
  figure: 'Figure',
  a: 'Link',
}

function build(
  f: OpenFile,
  n: XNode,
  parent: string,
  ctx: { rootFs: number; authored: (Authored | undefined)[]; urls: Set<string> },
): PNode[] {
  const styles: Styles = { ...n.styles }

  if (n.i >= 0) {
    const a = ctx.authored[n.i]

    for (const [kebab, camel] of SIZE_KEYS) {
      const v = resolveSize(kebab, a?.[kebab]?.v, n.sz?.[camel], n, ctx.rootFs)

      if (v !== null) styles[camel] = v
    }
  }

  if (n.fixed) {
    styles.top = `${round(n.fixed.top)}px`
    styles.left = `${round(n.fixed.left)}px`

    if (!styles.width || String(styles.width).includes('%'))
      styles.width = `${round(n.fixed.width)}px`
    delete styles.right
    delete styles.bottom
  }

  if (n.sticky) {
    delete styles.top
    delete styles.bottom
  }

  const clean = condense(styles)
  collectUrls(clean, ctx.urls)

  const id = f.mint()
  const attrs: Record<string, string> = {}

  if (n.href) attrs.href = n.href

  if (n.role) attrs.role = n.role

  if (n.alt != null) attrs.alt = n.alt

  if (n.colSpan) attrs.colspan = String(n.colSpan)

  if (n.rowSpan) attrs.rowspan = String(n.rowSpan)

  const node: PNode = {
    id,
    type: n.type,
    name: (n.name || defaultName(n)).slice(0, 50),
    tag: n.type === 'Image' ? 'img' : n.type === 'SVG' ? 'svg' : n.tag,
    styles: clean,
    parent,
    children: [],
  }

  if (Object.keys(attrs).length) node.attrs = attrs

  if (n.type === 'Text') node.text = n.text ?? ''

  if (n.type === 'Image') {
    node.src = n.src?.startsWith('data:') ? safeData(n.src) : n.src

    if (node.src && !node.src.startsWith('/media/')) ctx.urls.add(node.src)
  }

  if (n.type === 'SVG') node.svg = sanitizeSvgMarkup(n.svg ?? '<svg/>')

  const out: PNode[] = [node]

  for (const c of n.children ?? []) {
    const sub = build(f, c, id, ctx)

    if (sub.length) {
      node.children.push(sub[0].id)
      out.push(...sub)
    }
  }

  return out
}

function defaultName(n: XNode): string {
  if (n.type === 'Text') return (n.text ?? '').replace(/\s+/g, ' ').slice(0, 40) || 'Text'

  if (n.type === 'Image') return n.alt?.slice(0, 40) || 'Image'

  if (n.type === 'SVG') return 'SVG'

  return FRAME_NAMES[n.tag] ?? n.tag.charAt(0).toUpperCase() + n.tag.slice(1)
}

function safeData(src: string): string {
  try {
    return importAssetUrl(src)
  } catch {
    return src
  }
}

// ---- style clean-up -------------------------------------------------------------------

function hex2(n: number) {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0')
}

function hexColors(v: string): string {
  return v.replace(
    /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/g,
    (_m, r, g, b, a) => {
      const alpha = a === undefined ? 1 : Number(a)

      if (alpha === 0) return 'transparent'

      return `#${hex2(+r)}${hex2(+g)}${hex2(+b)}${alpha < 1 ? hex2(alpha * 255) : ''}`.toUpperCase()
    },
  )
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

/** Merge longhands into shorthands and prettify values so layers are editable. */
function condense(input: Styles): Styles {
  const s: Record<string, string> = {}

  for (const [k, v] of Object.entries(input)) s[k] = hexColors(String(v))

  const box = (prop: 'padding' | 'margin') => {
    const vals = SIDES.map((side) => s[`${prop}${side}`])

    if (vals.every((v) => v === undefined)) return
    const [t, r, b, l] = vals.map((v) => v ?? '0px')

    for (const side of SIDES) delete s[`${prop}${side}`]

    if (t === r && r === b && b === l) s[prop] = t
    else if (t === b && r === l) s[prop] = `${t} ${r}`
    else if (r === l) s[prop] = `${t} ${r} ${b}`
    else s[prop] = `${t} ${r} ${b} ${l}`
  }

  box('padding')
  box('margin')

  // Borders: only sides that actually draw.
  const sides = SIDES.map((side) => ({
    side,
    w: s[`border${side}Width`],
    st: s[`border${side}Style`],
    c: s[`border${side}Color`],
  }))

  for (const side of SIDES) {
    delete s[`border${side}Width`]
    delete s[`border${side}Style`]
    delete s[`border${side}Color`]
  }

  const drawn = sides.flatMap((x) =>
    x.w && parseFloat(x.w) > 0 && x.st !== 'none' && x.st !== 'hidden'
      ? [{ side: x.side, value: `${x.w} ${x.st ?? 'solid'} ${x.c ?? 'currentColor'}` }]
      : [],
  )

  if (drawn.length === 4 && drawn.every((d) => d.value === drawn[0].value))
    s.border = drawn[0].value
  else for (const d of drawn) s[`border${d.side}`] = d.value

  const corners = [
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'borderBottomRightRadius',
    'borderBottomLeftRadius',
  ]

  if (corners.some((c) => s[c] !== undefined)) {
    const v = corners.map((c) => s[c] ?? '0px')

    for (const c of corners) delete s[c]

    if (v.some((x) => x !== '0px')) s.borderRadius = v.every((x) => x === v[0]) ? v[0] : v.join(' ')
  }

  if (s.rowGap !== undefined || s.columnGap !== undefined) {
    const rg = s.rowGap ?? 'normal'
    const cg = s.columnGap ?? 'normal'
    delete s.rowGap
    delete s.columnGap

    if (rg === cg) s.gap = rg
    else s.gap = `${rg === 'normal' ? '0px' : rg} ${cg === 'normal' ? '0px' : cg}`
  }

  if (s.overflowX !== undefined && s.overflowX === s.overflowY) {
    s.overflow = s.overflowX
    delete s.overflowX
    delete s.overflowY
  }

  if (s.outlineStyle === 'none' || s.outlineWidth === '0px') {
    delete s.outlineStyle
    delete s.outlineWidth
    delete s.outlineColor
    delete s.outlineOffset
  }

  if (s.textDecorationLine === 'none') {
    delete s.textDecorationColor
    delete s.textDecorationStyle
    delete s.textDecorationThickness
  }

  return s
}

// ---- assets -----------------------------------------------------------------------------

function collectUrls(styles: Styles, urls: Set<string>) {
  for (const v of Object.values(styles)) {
    if (!isStyleString(v) || !v.includes('url(')) continue

    for (const m of v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g))
      if (/^https?:/.test(m[2])) urls.add(m[2])
  }
}

function rewriteUrls(v: string, map: Map<string, string>): string {
  return v.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q: string, u: string) =>
    map.has(u) ? `url(${q}${map.get(u)}${q})` : m,
  )
}

function isStyleString(v: StyleValue): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

async function downloadAssets(
  page: Page,
  urls: string[],
  referer: string,
  warnings: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const list = urls.filter((u) => /^https?:/.test(u)).slice(0, MAX_ASSETS)

  if (urls.length > MAX_ASSETS)
    warnings.push(
      `Only the first ${MAX_ASSETS} images were downloaded; the rest still point at the live site.`,
    )
  let next = 0

  const worker = async () => {
    while (next < list.length) {
      const u = list[next++]

      try {
        const res = await page.fetch(u, { timeout: 15_000, referrer: referer })

        if (!res.ok) continue
        const body = Buffer.from(await res.arrayBuffer())

        if (body.length > MAX_ASSET_BYTES) continue
        const ext = extFor(res.headers.get('content-type') ?? undefined, u)

        if (!ext) continue
        map.set(u, storeBuffer(body, ext))
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: 8 }, worker))

  return map
}

function coversLatin(range: string | undefined): boolean {
  if (!range) return true

  for (const part of range.split(',')) {
    const r = part.trim().replace(/^u\+/i, '')
    let lo: number
    let hi: number

    if (r.includes('?')) {
      lo = parseInt(r.replace(/\?/g, '0'), 16)
      hi = parseInt(r.replace(/\?/g, 'F'), 16)
    } else {
      const [a, b] = r.split('-')
      lo = parseInt(a, 16)
      hi = parseInt(b ?? a, 16)
    }

    if (lo <= 0x61 && hi >= 0x61) return true
  }

  return false
}

async function downloadFonts(
  cdp: Page,
  sheets: Map<string, string>,
  families: string[],
  warnings: string[],
): Promise<FontFaceDef[]> {
  const used = new Set(families.map((f) => f.toLowerCase()))

  const faces: {
    family: string
    url: string
    weight?: string
    style?: string
    unicodeRange?: string
  }[] = []

  for (const [id, base] of sheets) {
    let text = ''

    try {
      // SAFETY: CSS.getStyleSheetText resolves with the stylesheet text.
      text = ((await cdp.send('CSS.getStyleSheetText', { styleSheetId: id })) as { text: string })
        .text
    } catch {
      continue
    }

    for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = m[1]

      const family = body
        .match(/font-family\s*:\s*([^;]+)/i)?.[1]
        .trim()
        .replace(/^["']|["']$/g, '')

      if (!family || !used.has(family.toLowerCase())) continue
      const src = body.match(/src\s*:\s*([^;]+)/i)?.[1] ?? ''

      const candidates = [
        ...src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/g),
      ].map((u) => ({
        url: u[2],
        format: u[3] ?? '',
      }))

      const pick =
        candidates.find((c) => /woff2/.test(c.format) || /\.woff2(\?|$)/.test(c.url)) ??
        candidates.find((c) => !c.url.startsWith('data:') || c.url.length < 2_000_000)

      if (!pick) continue
      const unicodeRange = body.match(/unicode-range\s*:\s*([^;]+)/i)?.[1].trim()

      if (!coversLatin(unicodeRange)) continue
      let abs: string

      try {
        abs = new URL(pick.url, base).toString()
      } catch {
        continue
      }

      faces.push({
        family,
        url: abs,
        weight: body.match(/font-weight\s*:\s*([^;]+)/i)?.[1].trim(),
        style: body.match(/font-style\s*:\s*([^;]+)/i)?.[1].trim(),
        unicodeRange,
      })
    }
  }

  const out: FontFaceDef[] = []

  for (const face of faces.slice(0, MAX_FONT_FILES)) {
    try {
      let src: string

      if (face.url.startsWith('data:')) src = importAssetUrl(face.url)
      else {
        const res = await cdp.fetch(face.url, { timeout: 15_000 })

        if (!res.ok) continue
        const ext = extFor(res.headers.get('content-type') ?? undefined, face.url) ?? 'woff2'
        src = storeBuffer(Buffer.from(await res.arrayBuffer()), ext)
      }

      out.push({
        family: face.family,
        src,
        weight: face.weight,
        style: face.style,
        unicodeRange: face.unicodeRange,
      })
    } catch {}
  }

  if (faces.length > MAX_FONT_FILES)
    warnings.push(`Only ${MAX_FONT_FILES} font files were downloaded.`)

  return out
}
