import { useMemo } from 'react'
import { subtreeIds } from '../shared/ops'
import { camelToKebab, kebabToCamel } from '../shared/styles'
import type { AuditFact, PNode } from '../shared/types'
import { ensureFonts, familiesIn, isWebFont } from './render/fonts'
import { World } from './render/World'
import { store, useStore } from './store'

// Headless layout engine. The server drives this page through Playwright and
// calls window.__engine.call(...) to measure the real DOM.

export function EngineApp() {
  // Offset so artboards at negative coordinates stay on the page.
  const offset = useStore((s) => {
    let minX = 0
    let minY = 0
    const root = s.page ? s.doc?.nodes[s.page.rootId] : undefined
    for (const id of root?.children ?? []) {
      const n = s.doc?.nodes[id]
      minX = Math.min(minX, parseFloat(String(n?.styles.left ?? 0)) || 0)
      minY = Math.min(minY, parseFloat(String(n?.styles.top ?? 0)) || 0)
    }
    return `${minX},${minY}`
  })
  const style = useMemo(() => {
    const [x, y] = offset.split(',').map(Number)
    return { position: 'absolute', left: 100 - x, top: 100 - y } as const
  }, [offset])
  return <World style={style} />
}

// Engine calls often measure hundreds of nodes; index the DOM once per call
// instead of running an attribute selector per node.
let index: Map<string, HTMLElement> | null = null
function el(id: string): HTMLElement | null {
  if (!index) {
    index = new Map()
    for (const e of document.querySelectorAll<HTMLElement>('[data-pid]')) if (!index.has(e.dataset.pid!)) index.set(e.dataset.pid!, e)
  }
  const hit = index.get(id)
  if (hit?.isConnected) return hit
  return document.querySelector<HTMLElement>(`[data-pid="${CSS.escape(id)}"]`)
}
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))

async function settle() {
  if (store.doc) await ensureFonts(familiesIn(store.doc))
  await document.fonts.ready
  // Real components render asynchronously in their own frames.
  for (let t = 0; t < 150 && document.querySelector('.pw-world [data-component-state="loading"]'); t++) await new Promise((r) => setTimeout(r, 100))
  const imgs = [...document.querySelectorAll<HTMLImageElement>('.pw-world img')].filter((i) => !i.complete)
  if (imgs.length)
    await Promise.race([
      Promise.all(imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r))))),
      new Promise((r) => setTimeout(r, 4000)),
    ])
  await frame()
}

function layout({ ids }: { ids: string[] }) {
  const world = document.querySelector('.pw-world')!.getBoundingClientRect()
  const nodes = store.doc!.nodes
  const out: Record<string, unknown> = {}
  for (const id of ids) {
    const e = el(id)
    const n = nodes[id]
    if (!e || !n) continue
    const r = e.getBoundingClientRect()
    const parent = n.parent ? nodes[n.parent] : null
    const pe = parent && parent.type !== 'Root' ? el(parent.id) : null
    const pr = pe?.getBoundingClientRect()
    out[id] = {
      x: r.left - (pr ? pr.left : world.left),
      y: r.top - (pr ? pr.top : world.top),
      width: r.width,
      height: r.height,
      worldX: r.left - world.left,
      worldY: r.top - world.top,
      pageX: r.left + window.scrollX,
      pageY: r.top + window.scrollY,
    }
  }
  return out
}

// ---- computed styles ---------------------------------------------------------

const BOX_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth',
  'maxHeight', 'padding', 'margin', 'overflow', 'backgroundColor', 'backgroundImage', 'backgroundSize',
  'backgroundPosition', 'border', 'borderRadius', 'boxShadow', 'opacity', 'zIndex', 'transform', 'filter',
  'backdropFilter', 'objectFit', 'mixBlendMode', 'aspectRatio', 'outline',
]
const CONTAINER_PROPS = ['flexDirection', 'flexWrap', 'alignItems', 'justifyContent', 'gap', 'gridTemplateColumns', 'gridTemplateRows']
const ITEM_PROPS = ['flexGrow', 'flexShrink', 'flexBasis', 'alignSelf']
const TEXT_PROPS = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textDecorationLine', 'whiteSpace']

// Shorthands whose computed form is noisy; their longhands are reported instead.
const VERBOSE_SHORTHANDS = new Set(['background', 'font', 'flex', 'textDecoration', 'borderColor', 'borderWidth', 'borderStyle', 'inset', 'transition', 'animation', 'grid', 'gridTemplate', 'listStyle'])

const DEFAULTS: Record<string, string[]> = {
  position: ['static'], top: ['auto'], right: ['auto'], bottom: ['auto'], left: ['auto'], minWidth: ['0px', 'auto'],
  minHeight: ['0px', 'auto'], maxWidth: ['none'], maxHeight: ['none'], padding: ['0px'], margin: ['0px'],
  overflow: ['visible'], backgroundColor: ['rgba(0, 0, 0, 0)'], backgroundImage: ['none'], backgroundSize: ['auto'],
  backgroundPosition: ['0% 0%'], borderRadius: ['0px'], boxShadow: ['none'], opacity: ['1'], zIndex: ['auto'],
  transform: ['none'], filter: ['none'], backdropFilter: ['none'], objectFit: ['fill'], mixBlendMode: ['normal'],
  aspectRatio: ['auto'], flexWrap: ['nowrap'], alignItems: ['normal'], justifyContent: ['normal'], gap: ['normal'],
  gridTemplateColumns: ['none'], gridTemplateRows: ['none'], flexGrow: ['0'], flexShrink: ['1'], flexBasis: ['auto'],
  alignSelf: ['auto'], fontStyle: ['normal'], letterSpacing: ['normal'], textAlign: ['start', 'left'],
  textTransform: ['none'], textDecorationLine: ['none'], whiteSpace: ['normal'],
}

function computedFor(n: PNode, e: Element): Record<string, string> {
  const cs = getComputedStyle(e)
  const parent = e.parentElement?.closest('[data-pid]') ?? null
  const parentDisplay = parent ? getComputedStyle(parent).display : ''
  const display = cs.display
  const props = [...BOX_PROPS]
  if (/flex|grid/.test(display)) props.push(...CONTAINER_PROPS)
  if (/flex|grid/.test(parentDisplay)) props.push(...ITEM_PROPS)
  if (n.type === 'Text') props.push(...TEXT_PROPS)
  for (const k of Object.keys(n.styles)) if (!k.startsWith('--') && !props.includes(k) && !VERBOSE_SHORTHANDS.has(k)) props.push(k)
  const out: Record<string, string> = {}
  for (const p of props) {
    let v = cs.getPropertyValue(camelToKebab(p))
    if (p === 'border' && !v) {
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const sv = cs.getPropertyValue(`border-${side.toLowerCase()}`)
        if (sv && !/^0px /.test(sv)) out[`border${side}`] = hexColors(sv)
      }
      continue
    }
    if (!v) continue
    if (p === 'border' && /^0px /.test(v)) continue
    if (p === 'whiteSpace' && v === 'pre-wrap' && n.type === 'Text' && !('whiteSpace' in n.styles)) continue
    if (p === 'outline' && /none/.test(v)) continue
    if (DEFAULTS[p]?.includes(v) && !(p in n.styles)) continue
    if (p === 'width' || p === 'height') v = `${round(parseFloat(v))}px`
    out[p] = hexColors(v)
  }
  const tokens = Object.fromEntries(Object.entries(n.styles).filter(([, v]) => typeof v === 'string' && v.includes('var(')))
  if (Object.keys(tokens).length) out.__tokens = JSON.stringify(tokens)
  return out
}

function computed({ ids }: { ids: string[] }) {
  const out: Record<string, unknown> = {}
  for (const id of ids) {
    const n = store.doc!.nodes[id]
    const e = el(id)
    if (!n || !e) {
      out[id] = { error: 'not rendered' }
      continue
    }
    const c: Record<string, unknown> = computedFor(n, e)
    if (c.__tokens) {
      c.tokenBindings = JSON.parse(String(c.__tokens))
      delete c.__tokens
    }
    out[id] = c
  }
  return out
}

function round(v: number) {
  return Math.round(v * 100) / 100
}

function hex2(n: number) {
  return Math.round(n).toString(16).padStart(2, '0')
}

function hexColors(v: string): string {
  return v.replace(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/g, (_m, r, g, b, a) => {
    const alpha = a === undefined ? 1 : Number(a)
    return `#${hex2(+r)}${hex2(+g)}${hex2(+b)}${alpha < 1 ? hex2(alpha * 255) : ''}`.toUpperCase()
  })
}

// ---- find --------------------------------------------------------------------

const ctx = document.createElement('canvas').getContext('2d')!
function normColor(v: string): string | null {
  ctx.fillStyle = '#010203'
  ctx.fillStyle = v
  const a = ctx.fillStyle
  ctx.fillStyle = '#040506'
  ctx.fillStyle = v
  const b = ctx.fillStyle
  return a === b ? String(a) : null
}

const COLOR_RE = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|oklch\([^)]*\)|oklab\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\))/gi

function globRe(glob: string) {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
}

interface Filter {
  styleName?: string
  styleValue?: string
}

function find({ scope, textValue, filters }: { scope: string; textValue?: string; filters?: Filter[] }) {
  const nodes = store.doc!.nodes
  const textRe = textValue ? globRe(textValue) : null
  const results: unknown[] = []
  for (const id of subtreeIds(nodes, scope)) {
    const n = nodes[id]
    if (n.type === 'Root') continue
    const matched: Record<string, string>[] = []
    if (textRe) {
      if (n.type !== 'Text' || !textRe.test(n.text ?? '')) continue
      matched.push({ textValue: n.text ?? '' })
    }
    if (filters?.length) {
      const e = el(id)
      if (!e) continue
      const cs = getComputedStyle(e)
      let ok = true
      for (const f of filters) {
        const m = matchFilter(n, cs, f)
        if (!m.length) {
          ok = false
          break
        }
        matched.push(...m)
      }
      if (!ok) continue
    }
    results.push({ id, name: n.name, component: n.type, matched })
    if (results.length >= 500) break
  }
  return results
}

function matchFilter(n: PNode, cs: CSSStyleDeclaration, f: Filter) {
  const nameRe = f.styleName && f.styleName.includes('*') ? globRe(f.styleName) : null
  const props = f.styleName && !nameRe
    ? [kebabToCamel(f.styleName)]
    : [...new Set([...Object.keys(n.styles), ...BOX_PROPS, ...CONTAINER_PROPS, ...TEXT_PROPS, 'borderColor', 'fill', 'stroke'])].filter(
        (p) => !nameRe || nameRe.test(p) || nameRe.test(camelToKebab(p)),
      )
  const out: { styleName: string; styleValue: string }[] = []
  const v = f.styleValue?.trim()
  const token = v?.match(/^(?:var\(\s*)?(--[\w-]+)\s*\)?$/)?.[1]
  const color = v && !token && !v.includes('*') ? normColor(v) : null
  const valueRe = v && !token && !color ? globRe(v) : null
  for (const p of props) {
    if (p.startsWith('--')) continue
    const authored = n.styles[p] !== undefined ? String(n.styles[p]) : undefined
    const computedValue = cs.getPropertyValue(camelToKebab(p))
    if (!v) {
      if (authored !== undefined || (computedValue && !DEFAULTS[p]?.includes(computedValue) && (n.type === 'Text' || !TEXT_PROPS.includes(p))))
        out.push({ styleName: p, styleValue: authored ?? computedValue })
      continue
    }
    if (token) {
      if (authored?.includes(`var(${token}`)) out.push({ styleName: p, styleValue: `var(${token})` })
      continue
    }
    if (color) {
      // Only consider inherited text color on Text nodes, not on every container.
      if ((p === 'color' || TEXT_PROPS.includes(p)) && n.type !== 'Text' && authored === undefined) continue
      const fragments = computedValue.match(COLOR_RE) ?? []
      const hit = fragments.find((c) => normColor(c) === color)
      if (hit) {
        const ref = authored?.match(/var\(\s*--[\w-]+\s*\)/)?.[0]
        out.push({ styleName: p, styleValue: ref ?? (fragments.length > 1 ? hexColors(hit) : hexColors(computedValue)) })
      }
      continue
    }
    if (valueRe && (valueRe.test(computedValue) || (authored !== undefined && valueRe.test(authored))))
      out.push({ styleName: p, styleValue: authored ?? computedValue })
  }
  return out
}

// ---- misc --------------------------------------------------------------------

function overflow({ ids }: { ids: string[] }) {
  const out: Record<string, { x: number; y: number }> = {}
  for (const id of ids) {
    const e = el(id)
    if (!e) continue
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    let right = r.left
    let bottom = r.top
    for (const c of e.children) {
      const target = (c as HTMLElement).dataset?.pid ? c : c.firstElementChild
      if (!target) continue
      const ccs = getComputedStyle(target)
      if (ccs.position === 'absolute' || ccs.position === 'fixed') continue
      const cr = target.getBoundingClientRect()
      right = Math.max(right, cr.right + (parseFloat(ccs.marginRight) || 0))
      bottom = Math.max(bottom, cr.bottom + (parseFloat(ccs.marginBottom) || 0))
    }
    out[id] = {
      x: right + (parseFloat(cs.paddingRight) || 0) - r.right,
      y: bottom + (parseFloat(cs.paddingBottom) || 0) - r.bottom,
    }
  }
  return out
}

function fontCheck({ families }: { families: string[] }) {
  const out: Record<string, boolean> = {}
  const sample = 'mmmmmmmmmmlli1WQ@#'
  for (const fam of families) {
    if (isWebFont(fam)) {
      out[fam] = false
      continue
    }
    out[fam] = ['monospace', 'serif', 'sans-serif'].some((base) => {
      ctx.font = `72px ${base}`
      const w0 = ctx.measureText(sample).width
      ctx.font = `72px "${fam}", ${base}`
      return ctx.measureText(sample).width !== w0
    })
  }
  return out
}

async function downscale({ src, max }: { src: string; max: number }) {
  const img = new Image()
  img.src = src
  await img.decode()
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * scale)
  c.height = Math.round(img.naturalHeight * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], width: c.width, height: c.height }
}

// ---- visual diff -----------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! }
}

/**
 * Perceptual pixel diff (YIQ delta, as in pixelmatch). `b` is scaled to `a`'s
 * width when fit === 'width'. Returns a score, a heatmap composite and the
 * largest differing regions (in `a` pixel coordinates).
 */
async function diff({ a, b, threshold = 0.1, fit = 'width', cell = 24, tolerance = 1, parts = false }: { a: string; b: string; threshold?: number; fit?: 'width' | 'none'; cell?: number; tolerance?: number; parts?: boolean }) {
  const [ia, ib] = await Promise.all([loadImage(a), loadImage(b)])
  const W = ia.naturalWidth
  const H = ia.naturalHeight
  let bw = ib.naturalWidth
  let bh = ib.naturalHeight
  if (fit === 'width' && bw !== W) {
    bh = Math.round((bh * W) / bw)
    bw = W
  }
  const w = Math.min(W, bw)
  const A = canvasOf(W, H)
  A.ctx.fillStyle = '#fff'
  A.ctx.fillRect(0, 0, W, H)
  A.ctx.drawImage(ia, 0, 0)
  const B = canvasOf(bw, bh)
  B.ctx.fillStyle = '#fff'
  B.ctx.fillRect(0, 0, bw, bh)
  B.ctx.imageSmoothingQuality = 'high'
  B.ctx.drawImage(ib, 0, 0, bw, bh)
  const da = A.ctx.getImageData(0, 0, W, H).data
  const db = B.ctx.getImageData(0, 0, bw, bh).data

  // Vertical alignment: a design whose content sits a few px higher/lower
  // than the reference would otherwise light up every row.
  const rowLum = (d: Uint8ClampedArray, width: number, height: number) => {
    const out = new Float32Array(height)
    for (let y = 0; y < height; y++) {
      let sum = 0
      for (let x = 0; x < w; x += 2) {
        const p = (y * width + x) * 4
        sum += d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114
      }
      out[y] = sum / Math.ceil(w / 2)
    }
    return out
  }
  const la = rowLum(da, W, H)
  const lb = rowLum(db, bw, bh)
  const err = (sh: number) => {
    let e = 0
    let n = 0
    for (let y = Math.max(0, -sh); y < Math.min(H, bh - sh); y++) {
      e += Math.abs(la[y] - lb[y + sh])
      n++
    }
    return n > H * 0.5 ? e / n : Infinity
  }
  let shift = 0
  const base = err(0)
  let best = base
  for (let sh = -160; sh <= 160; sh++) {
    const e = err(sh)
    if (e < best - 1e-6) {
      best = e
      shift = sh
    }
  }
  if (!(best < base * 0.85)) shift = 0
  const y0 = Math.max(0, -shift)
  const y1 = Math.min(H, bh - shift)
  const h = y1 - y0

  // Background colour (most common) to measure content-only similarity.
  const hist = new Map<number, number>()
  for (let i = 0; i < W * H; i += 97) {
    const p = i * 4
    const key = ((da[p] >> 4) << 8) | ((da[p + 1] >> 4) << 4) | (da[p + 2] >> 4)
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  const bgKey = [...hist].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0xfff
  const bgR = ((bgKey >> 8) & 15) * 17
  const bgG = ((bgKey >> 4) & 15) * 17
  const bgB = (bgKey & 15) * 17

  const heat = new ImageData(w, H)
  const hd = heat.data
  const maxDelta = 35215 * threshold * threshold
  const yiq = (r: number, g: number, b: number) => [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.2741761 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694]
  const [bgY, bgI, bgQ] = yiq(bgR, bgG, bgB)
  const cols = Math.ceil(w / cell)
  const rows = Math.ceil(H / cell)
  const cells = new Uint32Array(cols * rows)
  let count = 0
  let content = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * W + x) * 4
      const hp = (y * w + x) * 4
      const r1 = da[p], g1 = da[p + 1], b1 = da[p + 2]
      const [y1c, i1, q1] = yiq(r1, g1, b1)
      if (y < y0 || y >= y1) {
        const g = 255 - (255 - y1c) * 0.08
        hd[hp] = hd[hp + 1] = hd[hp + 2] = g
        hd[hp + 3] = 255
        continue
      }
      const pb = ((y + shift) * bw + x) * 4
      const [y2c, i2, q2] = yiq(db[pb], db[pb + 1], db[pb + 2])
      let delta = 0.5053 * (y1c - y2c) ** 2 + 0.299 * (i1 - i2) ** 2 + 0.1957 * (q1 - q2) ** 2
      // Anti-aliasing / sub-pixel jitter: accept the same colour within `tolerance` px, both ways.
      if (delta > maxDelta && tolerance > 0) {
        const near = (d: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, ty: number, ti: number, tq: number) => {
          for (let dy = -tolerance; dy <= tolerance; dy++) {
            const yy = cy + dy
            if (yy < 0 || yy >= height) continue
            for (let dx = -tolerance; dx <= tolerance; dx++) {
              const xx = x + dx
              if (xx < 0 || xx >= w || (!dx && !dy)) continue
              const q = (yy * width + xx) * 4
              const [ny, ni, nq] = yiq(d[q], d[q + 1], d[q + 2])
              if (0.5053 * (ny - ty) ** 2 + 0.299 * (ni - ti) ** 2 + 0.1957 * (nq - tq) ** 2 <= maxDelta) return true
            }
          }
          return false
        }
        if (near(db, bw, bh, x, y + shift, y1c, i1, q1) && near(da, W, H, x, y, y2c, i2, q2)) delta = 0
      }
      const nonBgA = 0.5053 * (y1c - bgY) ** 2 + 0.299 * (i1 - bgI) ** 2 + 0.1957 * (q1 - bgQ) ** 2 > maxDelta
      const nonBgB = 0.5053 * (y2c - bgY) ** 2 + 0.299 * (i2 - bgI) ** 2 + 0.1957 * (q2 - bgQ) ** 2 > maxDelta
      if (nonBgA || nonBgB) content++
      if (delta > maxDelta) {
        count++
        cells[((y / cell) | 0) * cols + ((x / cell) | 0)]++
        hd[hp] = 255
        hd[hp + 1] = 40
        hd[hp + 2] = 40
        hd[hp + 3] = 255
      } else {
        const g = 255 - (255 - y1c) * 0.18
        hd[hp] = hd[hp + 1] = hd[hp + 2] = g
        hd[hp + 3] = 255
      }
    }
  }

  // Group dense cells into regions (4-connected).
  const hot = new Uint8Array(cols * rows)
  for (let k = 0; k < cells.length; k++) if (cells[k] > cell * cell * 0.03) hot[k] = 1
  const seen = new Uint8Array(cols * rows)
  const regions: { x: number; y: number; width: number; height: number; pixels: number }[] = []
  for (let k = 0; k < hot.length; k++) {
    if (!hot[k] || seen[k]) continue
    let x1 = cols, y1 = rows, x2 = 0, y2 = 0, px = 0
    const stack = [k]
    seen[k] = 1
    while (stack.length) {
      const c = stack.pop()!
      const cx = c % cols
      const cy = (c / cols) | 0
      x1 = Math.min(x1, cx); y1 = Math.min(y1, cy); x2 = Math.max(x2, cx); y2 = Math.max(y2, cy)
      px += cells[c]
      for (const nb of [c - 1, c + 1, c - cols, c + cols]) {
        if (nb < 0 || nb >= hot.length || seen[nb] || !hot[nb]) continue
        if ((nb === c - 1 && cx === 0) || (nb === c + 1 && cx === cols - 1)) continue
        seen[nb] = 1
        stack.push(nb)
      }
    }
    regions.push({ x: x1 * cell, y: y1 * cell, width: Math.min(w, (x2 + 1) * cell) - x1 * cell, height: Math.min(H, (y2 + 1) * cell) - y1 * cell, pixels: px })
  }
  regions.sort((p, q) => q.pixels - p.pixels)

  const H2 = canvasOf(w, H)
  H2.ctx.putImageData(heat, 0, 0)
  const summary = {
    compared: { width: w, height: h, from: y0 },
    design: { width: W, height: H },
    reference: { width: ib.naturalWidth, height: ib.naturalHeight, scaledTo: [bw, bh] },
    shift,
    diffPixels: count,
    score: 1 - count / Math.max(1, w * h),
    contentPixels: content,
    contentScore: content ? 1 - count / content : 1,
    regions: regions.slice(0, 8),
  }
  // The images separately (b scaled to a's width, heatmap in a's pixels), for callers that lay them out themselves.
  if (parts) return { ...summary, a: A.c.toDataURL('image/jpeg', 0.85), b: B.c.toDataURL('image/jpeg', 0.85), heat: H2.c.toDataURL('image/jpeg', 0.85) }

  // Side-by-side composite for the agent: design | reference | heatmap.
  const s = Math.min(1, 1600 / H, 760 / w)
  const pw = Math.max(1, Math.round(w * s))
  const ph = Math.max(1, Math.round(H * s))
  const gap = 12
  const C = canvasOf(pw * 3 + gap * 2, ph)
  C.ctx.fillStyle = '#e7e5e4'
  C.ctx.fillRect(0, 0, C.c.width, C.c.height)
  C.ctx.imageSmoothingQuality = 'high'
  C.ctx.drawImage(A.c, 0, 0, w, H, 0, 0, pw, ph)
  // Reference drawn aligned to the design (shifted by the detected offset).
  C.ctx.drawImage(B.c, 0, 0, w, bh, pw + gap, -shift * s, pw, bh * s)
  C.ctx.drawImage(H2.c, 0, 0, w, H, (pw + gap) * 2, 0, pw, ph)
  C.ctx.strokeStyle = '#2563eb'
  C.ctx.lineWidth = 2
  for (const r of regions.slice(0, 8)) C.ctx.strokeRect((pw + gap) * 2 + r.x * s, r.y * s, r.width * s, r.height * s)

  return { ...summary, composite: C.c.toDataURL('image/jpeg', 0.85).split(',')[1] }
}

// ---- design audit ------------------------------------------------------------

let probe: CanvasRenderingContext2D | null = null
const rgbaCache = new Map<string, number[]>()

/** Any CSS color as sRGB [r, g, b, a], by painting it. */
function rgba(css: string): number[] {
  const hit = rgbaCache.get(css)
  if (hit) return hit
  if (!probe) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    probe = c.getContext('2d', { willReadFrequently: true })!
  }
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#000'
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const d = probe.getImageData(0, 0, 1, 1).data
  const out = [d[0], d[1], d[2], d[3] / 255]
  rgbaCache.set(css, out)
  return out
}

const over = (top: number[], below: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3]))
const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** The opaque color behind an element: its and its ancestors' backgrounds, over white. */
function backdrop(e: Element): number[] {
  const layers: number[][] = []
  for (let cur: Element | null = e; cur && !cur.classList.contains('pw-world'); cur = cur.parentElement) {
    const c = rgba(getComputedStyle(cur).backgroundColor)
    if (c[3] > 0) layers.push(c)
    if (c[3] >= 1) break
  }
  return layers.reduceRight((below, c) => over(c, below), [255, 255, 255])
}

function luminance(c: number[]) {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const num = (v: string) => Math.round((parseFloat(v) || 0) * 100) / 100

function audit({ ids }: { ids: string[] }) {
  const nodes = store.doc!.nodes
  const out: Record<string, AuditFact[]> = {}
  for (const root of ids) {
    const facts: AuditFact[] = []
    const walk = (id: string, depth: number) => {
      const n = nodes[id]
      const e = el(id)
      if (!n || !e || n.hidden) return
      const r = e.getBoundingClientRect()
      const cs = getComputedStyle(e)
      if (!r.width || !r.height || cs.visibility === 'hidden') return
      const bg = rgba(cs.backgroundColor)
      const borderWidth = num(cs.borderTopWidth) + num(cs.borderRightWidth) + num(cs.borderBottomWidth) + num(cs.borderLeftWidth)
      const f: AuditFact = {
        id,
        type: n.type,
        name: n.name,
        tag: n.tag,
        depth,
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(num),
        radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(num),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
      if (/flex|grid/.test(cs.display)) f.gap = [num(cs.rowGap), num(cs.columnGap)]
      if (bg[3] > 0) f.background = hex(bg)
      if (borderWidth > 0) f.border = hex(rgba(cs.borderTopColor))
      if (n.type === 'Text' && (n.text ?? '').trim()) {
        const behind = backdrop(e)
        const fg = over(rgba(cs.color), behind)
        f.text = (n.text ?? '').trim().slice(0, 120)
        f.fontSize = num(cs.fontSize)
        f.fontWeight = num(cs.fontWeight)
        f.fontFamily = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim()
        f.color = hex(fg)
        f.backdrop = hex(behind)
        f.contrast = Math.round(contrast(fg, behind) * 100) / 100
      }
      facts.push(f)
      if (n.type !== 'Component') for (const c of n.children) walk(c, depth + 1)
    }
    walk(root, 0)
    out[root] = facts
  }
  return out
}

const METHODS: Record<string, (args: never) => unknown> = { layout, computed, find, overflow, fontCheck, downscale, diff, audit, settle: () => true }

export function installEngine() {
  ;(window as unknown as { __engine: unknown }).__engine = {
    async call(method: string, args: unknown, version: number, pageId?: string) {
      await store.waitForVersion(version)
      if (pageId && store.pageId !== pageId && store.doc?.pages.some((p) => p.id === pageId)) {
        store.pageId = pageId
        store.emit()
      }
      await frame()
      await settle()
      const fn = METHODS[method]
      if (!fn) throw new Error(`Unknown engine method ${method}`)
      index = null
      try {
        return await fn(args as never)
      } finally {
        index = null
      }
    },
  }
}
