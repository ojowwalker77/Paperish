import type {
  GetFileNodesResponse,
  GetImageFillsResponse,
  GetImagesResponse,
} from '@figma/rest-api-spec'
import { extFor, storeBuffer } from '../assets'
import { htmlToNodes } from '../commands'
import type { ImportResult, Progress } from '../importer'
import { figmaToken } from '../settings'
import type { ImportJob } from '../tasks'
import type { OpenFile } from '../workspace'
import {
  autoLayout,
  background,
  boxOf,
  look,
  pct,
  px,
  round,
  sizing,
  visible,
  type Css,
  type Kind,
  type Layer,
} from './figma-css'

const API = 'https://api.figma.com/v1'

const VECTOR_TYPES = new Set(['VECTOR', 'STAR', 'LINE', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION'])

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'])

export function figmaJob(f: OpenFile, opts: { url: string; name?: string }): ImportJob {
  return {
    label: 'Figma',
    run: (progress) => importFigma(f, { ...parseFigmaUrl(opts.url), name: opts.name }, progress),
  }
}

function parseFigmaUrl(input: string) {
  let url: URL

  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Paste a figma.com link to a frame.')
  }

  const m = url.pathname.match(
    /^\/(?:design|file|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/,
  )

  if (!/(^|\.)figma\.com$/.test(url.hostname) || !m)
    throw new Error('Paste a figma.com link to a frame.')
  const nodeId = url.searchParams.get('node-id')?.replace(/-/g, ':')

  if (!nodeId)
    throw new Error(
      'The link has no frame in it. In Figma, right-click a frame → Copy link to selection.',
    )

  return { fileKey: m[2] ?? m[1], nodeId }
}

async function api<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } })

  if (res.status === 403)
    throw new Error(
      'Figma rejected the token, or it can’t read this file (needs file_content:read).',
    )

  if (res.status === 404) throw new Error('Figma couldn’t find that file or frame.')

  if (res.status === 429) throw new Error('Figma’s rate limit was hit. Try again in a minute.')

  if (!res.ok) throw new Error(`Figma responded with HTTP ${res.status}.`)

  // SAFETY: Figma REST responses follow @figma/rest-api-spec for the requested endpoint.
  return (await res.json()) as T
}

async function importFigma(
  f: OpenFile,
  ref: { fileKey: string; nodeId: string; name?: string },
  progress: Progress,
): Promise<ImportResult> {
  const t0 = Date.now()
  const token = figmaToken()

  if (!token)
    throw new Error('Add a Figma personal access token in the import dialog (or set FIGMA_TOKEN).')

  progress('Reading the file', 10)

  const file = await api<GetFileNodesResponse>(
    `/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}&geometry=paths`,
    token,
  )

  // SAFETY: the nodes response holds the requested node's document in the REST node shape.
  const root = file.nodes[ref.nodeId]?.document as Layer | undefined

  if (!root) throw new Error('Figma couldn’t find that frame.')

  if (root.type === 'CANVAS' || root.type === 'DOCUMENT')
    throw new Error('That link points to a page. Link a frame instead.')

  const kinds = new Map<string, Kind>()
  const imageRefs = new Set<string>()
  const warnings = new Set<string>()
  plan(root, kinds, imageRefs, warnings, true)

  const ids = (k: Kind) => [...kinds].flatMap(([id, v]) => (v === k ? [id] : []))

  progress('Exporting vectors', 30)
  const svgs = await exportsOf(ref.fileKey, ids('svg'), 'svg', token)
  const pngs = await exportsOf(ref.fileKey, ids('png'), 'png', token)

  progress('Downloading images', 55)

  const fills = imageRefs.size
    ? (await api<GetImageFillsResponse>(`/files/${ref.fileKey}/images`, token)).meta.images
    : {}

  const media = new Map<string, string>()
  const svgMarkup = new Map<string, string>()

  await pool(
    [
      ...[...imageRefs].map((r) => async () => {
        if (fills[r]) media.set(r, await download(fills[r]))
      }),
      ...[...pngs].map(([id, u]) => async () => {
        if (u) media.set(id, await download(u))
      }),
      ...[...svgs].map(([id, u]) => async () => {
        if (u) svgMarkup.set(id, await (await fetch(u)).text())
      }),
    ],
    8,
  )

  progress('Building layers', 85)
  const ctx: EmitCtx = { kinds, media, svgMarkup, warnings, seq: 0 }
  const html = emit(root, null, ctx)
  const width = boxOf(root).width
  const parsed = await htmlToNodes(f, html, width)
  const nodes = parsed.subtrees[0]

  if (!nodes) throw new Error('The frame produced no layers.')
  nodes[0].name = (ref.name || root.name).slice(0, 50)
  const wanted = imageRefs.size + ids('png').length

  const got =
    [...imageRefs].filter((r) => media.has(r)).length +
    ids('png').filter((i) => media.has(i)).length

  return {
    nodes,
    fontFaces: [],
    title: root.name,
    stats: {
      layers: nodes.length - 1,
      images: got,
      imagesFailed: wanted - got,
      fonts: 0,
      ms: Date.now() - t0,
    },
    warnings: [...warnings, ...parsed.warnings],
  }
}

async function exportsOf(
  fileKey: string,
  ids: string[],
  format: 'svg' | 'png',
  token: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const extra = format === 'png' ? '&scale=2' : ''

    const res = await api<GetImagesResponse>(
      `/images/${fileKey}?ids=${encodeURIComponent(batch.join(','))}&format=${format}&use_absolute_bounds=true${extra}`,
      token,
    )

    for (const id of batch) out.set(id, res.images[id] ?? null)
  }

  return out
}

async function download(url: string): Promise<string> {
  const res = await fetch(url)

  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ext = extFor(res.headers.get('content-type') ?? undefined, url) ?? 'png'

  return storeBuffer(Buffer.from(await res.arrayBuffer()), ext)
}

async function pool(tasks: (() => Promise<void>)[], size: number) {
  let next = 0

  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]

      try {
        await task()
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: size }, worker))
}

function imageFill(n: Layer) {
  const fills = visible(n.fills)

  return fills.length === 1 && fills[0].type === 'IMAGE' ? fills[0] : undefined
}

function fullEllipse(n: Layer) {
  const a = n.arcData

  return (
    !a || (a.innerRadius === 0 && Math.abs(a.endingAngle - a.startingAngle) >= Math.PI * 2 - 1e-3)
  )
}

function isIcon(n: Layer): boolean {
  if (n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL') return false
  let vectors = 0

  const ok = (c: Layer): boolean => {
    if (c.visible === false) return true

    if (visible(c.fills).some((p) => p.type === 'IMAGE')) return false

    if (VECTOR_TYPES.has(c.type) || c.type === 'ELLIPSE') return ++vectors > 0

    if (c.type === 'RECTANGLE') return true

    return (
      (c.type === 'GROUP' || c.type === 'FRAME' || c.type === 'INSTANCE') &&
      (c.children ?? []).every(ok)
    )
  }

  return (n.children ?? []).every(ok) && vectors > 0
}

function plan(
  n: Layer,
  kinds: Map<string, Kind>,
  refs: Set<string>,
  warnings: Set<string>,
  root = false,
) {
  if (n.visible === false || n.type === 'SLICE') return
  let kind: Kind

  if (n.type === 'TEXT') kind = 'text'
  else if (VECTOR_TYPES.has(n.type) || (n.type === 'ELLIPSE' && !fullEllipse(n))) kind = 'svg'
  else if ((n.type === 'RECTANGLE' || n.type === 'ELLIPSE') && imageFill(n)) kind = 'img'
  else if (n.type === 'RECTANGLE' || n.type === 'ELLIPSE') kind = 'box'
  else if (CONTAINERS.has(n.type)) {
    if (!root && (n.children ?? []).some((c) => c.isMask && c.visible !== false)) kind = 'png'
    else if (!root && isIcon(n)) kind = 'svg'
    else kind = 'box'
  } else {
    kind = 'png'
    warnings.add(`${n.type.toLowerCase()} layers were imported as images.`)
  }

  kinds.set(n.id, kind)

  if (kind === 'svg' || kind === 'png') return

  for (const p of visible(n.fills)) if (p.type === 'IMAGE' && p.imageRef) refs.add(p.imageRef)

  if (kind === 'text' && Object.keys(n.styleOverrideTable ?? {}).length)
    warnings.add('Mixed text styles inside one text layer were flattened to its base style.')

  if (kind === 'box') for (const c of n.children ?? []) plan(c, kinds, refs, warnings)
}

interface EmitCtx {
  kinds: Map<string, Kind>
  media: Map<string, string>
  svgMarkup: Map<string, string>
  warnings: Set<string>
  seq: number
}

function emit(n: Layer, parent: Layer | null, ctx: EmitCtx): string {
  const kind = ctx.kinds.get(n.id)

  if (!kind) return ''

  const css = placement(n, parent, kind)

  if (kind !== 'svg' && kind !== 'png') Object.assign(css, look(n, kind))

  if (kind === 'svg') {
    const raw = ctx.svgMarkup.get(n.id)

    if (raw) return tagSvg(raw, n.name, css, `f${ctx.seq++}-`)
    ctx.warnings.add('Some vectors could not be exported and were skipped.')

    return ''
  }

  if (kind === 'png') {
    const src = ctx.media.get(n.id)

    return src ? `<img src="${src}" alt="" layer-name="${attr(n.name)}" style="${style(css)}">` : ''
  }

  const fill = kind === 'img' ? imageFill(n) : undefined
  const src = fill && ctx.media.get(fill.imageRef)

  if (fill && src) {
    const fit = { FILL: 'cover', FIT: 'contain', STRETCH: 'fill', TILE: 'none' }[fill.scaleMode]

    return `<img src="${src}" alt="" layer-name="${attr(n.name)}" style="${style({ ...css, 'object-fit': fit })}">`
  }

  if (kind === 'text' && n.characters?.includes('\n') && !css['white-space'])
    css['white-space'] = 'pre-wrap'

  if (kind === 'text')
    return `<p layer-name="${attr(n.name)}" style="${style(css)}">${text(n.characters ?? '')}</p>`

  const kids = visible(n.children).filter((c) => ctx.kinds.has(c.id))
  const flowAbs = kids.some((c) => !inFlow(c, n))

  if (flowAbs && parent && css.position !== 'absolute') css.position = 'relative'

  if (kind === 'box') {
    const bg = background(n, ctx.media)
    Object.assign(css, bg)
  }

  const inner = kids.map((c) => emit(c, n, ctx)).join('')

  return `<div layer-name="${attr(n.name)}" style="${style(css)}">${inner}</div>`
}

function inFlow(n: Layer, parent: Layer | null) {
  return !!parent && autoLayout(parent) && n.layoutPositioning !== 'ABSOLUTE'
}

function placement(n: Layer, parent: Layer | null, kind: Kind): Css {
  const box = boxOf(n)
  const exported = kind === 'svg' || kind === 'png'
  const w = exported ? box.width : (n.size?.x ?? box.width)
  const h = exported ? box.height : (n.size?.y ?? box.height)
  const css: Css = {}
  const hs = exported ? 'FIXED' : sizing(n, 'h')
  const vs = exported ? 'FIXED' : sizing(n, 'v')

  if (!parent) {
    css.width = px(w)

    if (vs !== 'HUG') css.height = px(h)

    return css
  }

  if (inFlow(n, parent)) {
    const primary = parent.layoutMode === 'HORIZONTAL' ? 'h' : 'v'
    const fixedParent = sizing(parent, primary) !== 'HUG'

    for (const [axis, mode, size] of [
      ['h', hs, w],
      ['v', vs, h],
    ] as const) {
      const dim = axis === 'h' ? 'width' : 'height'

      if (mode === 'FIXED') css[dim] = px(size)

      if (mode === 'FILL' && axis === primary) {
        css.flex = '1 1 0px'
        css[axis === 'h' ? 'min-width' : 'min-height'] = 0
      } else if (mode === 'FILL') css['align-self'] = 'stretch'
      else if (axis === primary && fixedParent) css['flex-shrink'] = 0
    }

    if (n.type === 'TEXT' && hs === 'HUG') css['white-space'] = 'pre'

    for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const)
      if (n[k] != null) css[k.replace(/[A-Z]/, (c) => `-${c.toLowerCase()}`)] = px(n[k])

    return css
  }

  const pb = boxOf(parent)
  const angle = exported ? 0 : rotation(n)
  const x = box.x - pb.x + (box.width - w) / 2
  const y = box.y - pb.y + (box.height - h) / 2
  const ch = (parent.type === 'GROUP' ? undefined : n.constraints?.horizontal) ?? 'LEFT'
  const cv = (parent.type === 'GROUP' ? undefined : n.constraints?.vertical) ?? 'TOP'
  css.position = 'absolute'

  if (ch === 'RIGHT') css.right = px(pb.width - x - w)
  else if (ch === 'SCALE') css.left = pct(x, pb.width)
  else css.left = px(x)

  if (ch === 'LEFT_RIGHT') css.right = px(pb.width - x - w)
  else if (hs !== 'HUG') css.width = ch === 'SCALE' ? pct(w, pb.width) : px(w)

  if (cv === 'BOTTOM') css.bottom = px(pb.height - y - h)
  else if (cv === 'SCALE') css.top = pct(y, pb.height)
  else css.top = px(y)

  if (cv === 'TOP_BOTTOM') css.bottom = px(pb.height - y - h)
  else if (vs !== 'HUG') css.height = cv === 'SCALE' ? pct(h, pb.height) : px(h)

  if (n.type === 'TEXT' && hs === 'HUG') css['white-space'] = 'pre'

  if (angle) css.transform = `rotate(${round(angle)}deg)`

  return css
}

function rotation(n: Layer): number {
  const t = n.relativeTransform

  if (!t) return 0
  const deg = (Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI

  return Math.abs(deg) < 0.01 ? 0 : deg
}

function tagSvg(raw: string, name: string, css: Css, prefix: string): string {
  const svg = raw
    .replace(/<\?xml[^>]*>/, '')
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
    .trim()

  return svg.replace(
    /^<svg\b/,
    `<svg layer-name="${attr(name)}" style="${style({ ...css, overflow: 'visible' })}"`,
  )
}

function style(css: Css): string {
  return attr(
    Object.entries(css)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}:${v}`)
      .join(';'),
  )
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function text(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
