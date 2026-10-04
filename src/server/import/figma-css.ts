import type {
  Effect,
  FrameNode,
  Paint,
  RGBA,
  SolidPaint,
  TypePropertiesTrait,
} from '@figma/rest-api-spec'

export type Layer = Partial<Omit<FrameNode, 'type' | 'children'> & TypePropertiesTrait> & {
  id: string
  name: string
  type: string
  children?: Layer[]
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number }
}

export interface Css {
  [property: string]: string | number | undefined
}

export type Kind = 'box' | 'text' | 'img' | 'svg' | 'png'

export type Vars = Map<string, string>

const PADDING = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const

const CORNERS = [
  'topLeftRadius',
  'topRightRadius',
  'bottomRightRadius',
  'bottomLeftRadius',
] as const

interface AlignMap {
  [figma: string]: string
}

const ALIGN: AlignMap = {
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
  BASELINE: 'baseline',
  MIN: 'flex-start',
}

export function visible<T extends { visible?: boolean }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((x) => x.visible !== false)
}

export function boxOf(n: Layer) {
  return n.absoluteBoundingBox ?? { x: 0, y: 0, width: n.size?.x ?? 0, height: n.size?.y ?? 0 }
}

export function autoLayout(n: Layer) {
  return n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL'
}

export function sizing(n: Layer, axis: 'h' | 'v'): 'FIXED' | 'HUG' | 'FILL' {
  const auto = n.style?.textAutoResize

  if (n.type === 'TEXT') {
    if (axis === 'h' && auto === 'WIDTH_AND_HEIGHT') return 'HUG'

    if (axis === 'v' && (auto === 'HEIGHT' || auto === 'WIDTH_AND_HEIGHT')) return 'HUG'
  }

  const set = axis === 'h' ? n.layoutSizingHorizontal : n.layoutSizingVertical

  if (set) return set

  if (autoLayout(n)) {
    const primary = n.layoutMode === 'HORIZONTAL' ? 'h' : 'v'
    const mode = axis === primary ? n.primaryAxisSizingMode : n.counterAxisSizingMode

    if (mode === 'AUTO') return 'HUG'
  }

  return 'FIXED'
}

export function look(n: Layer, kind: Kind, vars: Vars): Css {
  const css: Css = {}
  const bound = n.boundVariables

  if (autoLayout(n)) {
    const row = n.layoutMode === 'HORIZONTAL'
    css.display = 'flex'

    if (!row) css['flex-direction'] = 'column'

    if (n.layoutWrap === 'WRAP') css['flex-wrap'] = 'wrap'
    const pad = PADDING.map((k) => ref(vars, bound?.[k]) ?? px(n[k] ?? 0))

    if (pad.some((v) => v !== '0px')) css.padding = pad.join(' ')

    const gap =
      n.primaryAxisAlignItems === 'SPACE_BETWEEN'
        ? undefined
        : (ref(vars, bound?.itemSpacing) ??
          (n.itemSpacing ? px(Math.max(0, n.itemSpacing)) : undefined))

    const cross =
      n.layoutWrap === 'WRAP'
        ? (ref(vars, bound?.counterAxisSpacing) ?? px(n.counterAxisSpacing ?? 0))
        : undefined

    if (cross && cross !== (gap ?? '0px'))
      css.gap = row ? `${cross} ${gap ?? '0px'}` : `${gap ?? '0px'} ${cross}`
    else if (gap) css.gap = gap

    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN')
      css['justify-content'] = ALIGN[n.primaryAxisAlignItems]
    css['align-items'] = ALIGN[n.counterAxisAlignItems ?? 'MIN']

    if (n.counterAxisAlignContent === 'SPACE_BETWEEN') css['align-content'] = 'space-between'
  }

  if (n.opacity !== undefined && n.opacity < 1) css.opacity = round(n.opacity)

  if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL')
    css['mix-blend-mode'] = n.blendMode.toLowerCase().replace(/_/g, '-').replace('linear-', '')

  if (n.clipsContent) css.overflow = 'hidden'

  const radii = n.rectangleCornerRadii
  const radiusVars = CORNERS.map((k) => ref(vars, bound?.[k]))

  if (n.type === 'ELLIPSE') css['border-radius'] = '50%'
  else if (radiusVars[0] && radiusVars.every((v) => v === radiusVars[0]))
    css['border-radius'] = radiusVars[0]
  else if (radii && radii.some((r) => r !== radii[0]))
    css['border-radius'] = radii.map(px).join(' ')
  else if (n.cornerRadius) css['border-radius'] = px(n.cornerRadius)

  Object.assign(css, kind === 'text' ? typography(n, vars) : stroke(n, vars), effects(n, kind))

  return css
}

function typography(n: Layer, vars: Vars): Css {
  const s = n.style ?? {}
  const css: Css = {}

  const tv = (k: 'fontFamily' | 'fontSize' | 'fontWeight' | 'letterSpacing' | 'lineHeight') =>
    ref(vars, s.boundVariables?.[k] ?? n.boundVariables?.[k]?.[0])

  if (s.fontFamily) css['font-family'] = tv('fontFamily') ?? `'${s.fontFamily.replace(/'/g, '')}'`

  if (s.fontSize) css['font-size'] = tv('fontSize') ?? px(s.fontSize)

  if (s.fontWeight && s.fontWeight !== 400) css['font-weight'] = tv('fontWeight') ?? s.fontWeight

  if (s.italic) css['font-style'] = 'italic'

  if (s.lineHeightUnit === 'PIXELS' && s.lineHeightPx)
    css['line-height'] = tv('lineHeight') ?? px(s.lineHeightPx)
  else if (s.lineHeightUnit === 'FONT_SIZE_%' && s.lineHeightPercentFontSize)
    css['line-height'] = tv('lineHeight') ?? round(s.lineHeightPercentFontSize / 100)

  if (s.letterSpacing) css['letter-spacing'] = tv('letterSpacing') ?? px(s.letterSpacing)
  const align = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify', LEFT: undefined }

  if (s.textAlignHorizontal) css['text-align'] = align[s.textAlignHorizontal]

  const tcase: AlignMap = {
    UPPER: 'uppercase',
    LOWER: 'lowercase',
    TITLE: 'capitalize',
  }

  if (s.textCase && tcase[s.textCase]) css['text-transform'] = tcase[s.textCase]
  else if (s.textCase?.startsWith('SMALL_CAPS')) css['font-variant'] = 'small-caps'

  if (s.textDecoration === 'UNDERLINE') css['text-decoration'] = 'underline'
  else if (s.textDecoration === 'STRIKETHROUGH') css['text-decoration'] = 'line-through'

  if (s.textAlignVertical && s.textAlignVertical !== 'TOP' && sizing(n, 'v') === 'FIXED') {
    css.display = 'flex'
    css['flex-direction'] = 'column'
    css['justify-content'] = s.textAlignVertical === 'CENTER' ? 'center' : 'flex-end'
  }

  if (s.textTruncation === 'ENDING') {
    css.overflow = 'hidden'
    css['text-overflow'] = 'ellipsis'

    if ((s.maxLines ?? 1) <= 1) css['white-space'] = 'nowrap'
  }

  const fill = visible(n.fills)[0]

  if (fill?.type === 'SOLID') css.color = paintColor(fill, vars)
  else if (fill && 'gradientStops' in fill) css.color = color(fill.gradientStops[0].color)

  return css
}

function stroke(n: Layer, vars: Vars): Css {
  const p = visible(n.strokes).find((s) => s.type === 'SOLID')

  if (!p || p.type !== 'SOLID') return {}
  const c = paintColor(p, vars)
  const w = n.strokeWeight ?? 1
  const line = n.strokeDashes?.length ? 'dashed' : 'solid'
  const sides = n.individualStrokeWeights

  if (
    sides &&
    !(sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left)
  ) {
    const css: Css = {}

    for (const side of ['top', 'right', 'bottom', 'left'] as const)
      if (sides[side]) css[`border-${side}`] = `${px(sides[side])} ${line} ${c}`

    return css
  }

  const width = sides?.top ?? w

  if (!width) return {}

  if (!n.children?.length && n.strokeAlign !== 'OUTSIDE' && n.strokeAlign !== 'CENTER')
    return { border: `${px(width)} ${line} ${c}` }
  const offset = n.strokeAlign === 'OUTSIDE' ? 0 : n.strokeAlign === 'CENTER' ? -width / 2 : -width

  return { outline: `${px(width)} ${line} ${c}`, 'outline-offset': px(offset) }
}

function effects(n: Layer, kind: Kind): Css {
  const css: Css = {}
  const shadows: string[] = []

  for (const e of visible<Effect>(n.effects).toReversed()) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : ''
      const spread = kind === 'text' ? '' : ` ${px(e.spread ?? 0)}`
      shadows.push(
        `${inset}${px(e.offset.x)} ${px(e.offset.y)} ${px(e.radius)}${spread} ${color(e.color)}`,
      )
    } else if (e.type === 'LAYER_BLUR') css.filter = `blur(${px(e.radius / 2)})`
    else if (e.type === 'BACKGROUND_BLUR') css['backdrop-filter'] = `blur(${px(e.radius / 2)})`
  }

  if (shadows.length) {
    if (kind === 'text')
      css['text-shadow'] = shadows.filter((s) => !s.startsWith('inset')).join(', ') || undefined
    else css['box-shadow'] = shadows.join(', ')
  }

  return css
}

export function background(n: Layer, media: Map<string, string>, vars: Vars): Css {
  const fills = visible(n.fills)
  const box = boxOf(n)
  const w = n.size?.x ?? box.width
  const h = n.size?.y ?? box.height

  if (fills.length === 1 && fills[0].type === 'SOLID')
    return { background: paintColor(fills[0], vars) }

  const layers = fills
    .toReversed()
    .map((p) => paintLayer(p, w, h, media, vars))
    .filter(Boolean)

  return layers.length ? { background: layers.join(', ') } : {}
}

function paintLayer(
  p: Paint,
  w: number,
  h: number,
  media: Map<string, string>,
  vars: Vars,
): string {
  const a = p.opacity ?? 1

  if (p.type === 'SOLID') {
    const c = paintColor(p, vars)

    return `linear-gradient(${c}, ${c})`
  }

  if (p.type === 'IMAGE') {
    const src = media.get(p.imageRef)

    if (!src) return ''

    const size = {
      FILL: 'center / cover no-repeat',
      FIT: 'center / contain no-repeat',
      STRETCH: '0 0 / 100% 100% no-repeat',
      TILE: '0 0 repeat',
    }

    return `url(${src}) ${size[p.scaleMode]}`
  }

  if (p.type === 'PATTERN') return ''
  const [h0, h1, h2] = p.gradientHandlePositions

  const stops = (t: (pos: number) => number) =>
    p.gradientStops.map((s) => `${color(s.color, a)} ${round(t(s.position) * 100)}%`).join(', ')

  if (p.type === 'GRADIENT_LINEAR') {
    const dx = (h1.x - h0.x) * w
    const dy = (h1.y - h0.y) * h
    const rad = Math.atan2(dx, -dy)
    const ux = Math.sin(rad)
    const uy = -Math.cos(rad)
    const len = Math.abs(w * ux) + Math.abs(h * uy)

    const at = (t: number) =>
      ((h0.x * w + dx * t - w / 2) * ux + (h0.y * h + dy * t - h / 2) * uy) / len + 0.5

    return `linear-gradient(${round((rad * 180) / Math.PI)}deg, ${stops(at)})`
  }

  const cx = round(h0.x * 100)
  const cy = round(h0.y * 100)

  if (p.type === 'GRADIENT_ANGULAR') {
    const from = (Math.atan2((h1.x - h0.x) * w, -(h1.y - h0.y) * h) * 180) / Math.PI

    return `conic-gradient(from ${round(from)}deg at ${cx}% ${cy}%, ${stops((t) => t)})`
  }

  const rx = Math.hypot((h1.x - h0.x) * w, (h1.y - h0.y) * h)
  const ry = Math.hypot((h2.x - h0.x) * w, (h2.y - h0.y) * h)

  return `radial-gradient(${px(rx)} ${px(ry)} at ${cx}% ${cy}%, ${stops((t) => t)})`
}

function ref(vars: Vars, alias: { id: string } | undefined) {
  const name = alias && vars.get(alias.id)

  return name ? `var(${name})` : undefined
}

function paintColor(p: SolidPaint, vars: Vars) {
  return ((p.opacity ?? 1) >= 1 && ref(vars, p.boundVariables?.color)) || color(p.color, p.opacity)
}

function hex(v: number) {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
}

function color(c: RGBA, opacity = 1): string {
  const a = (c.a ?? 1) * opacity

  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${a < 0.999 ? hex(a) : ''}`.toUpperCase()
}

export function round(v: number) {
  return Math.round(v * 100) / 100
}

export function px(v: number) {
  return `${round(v)}px`
}

export function pct(v: number, of: number) {
  return `${round((v / of) * 100)}%`
}
