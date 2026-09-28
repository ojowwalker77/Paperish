import { parseDocument } from 'htmlparser2'
import { isTag, isText, type ChildNode, type Element } from 'domhandler'
import { camelToKebab, cssValue, kebabToCamel } from '../shared/styles'
import { exportStyles } from '../shared/html'
import { parseMarkup, type RNode } from '../shared/markup'
import { normColor } from './tailwind'
import type { ComponentInfo, PNode, StyleValue, Styles } from '../shared/types'

type Nodes = Record<string, PNode>

export { toStaticHTML } from '../shared/html'

// ---- JSX ---------------------------------------------------------------------

export function toJSX(
  nodes: Nodes,
  id: string,
  format: 'tailwind' | 'inline-styles' = 'tailwind',
  components: ComponentInfo[] = [],
  colorNames: Map<string, string> = new Map(),
): string {
  const lines: string[] = []
  const used = new Map<string, ComponentInfo>()

  const tailwindAttr = (styles: Styles) => {
    const classes: string[] = []

    for (const [k, v] of Object.entries(styles)) classes.push(...toTailwind(k, v, colorNames))

    return classes.length ? ` className=${JSON.stringify(classes.join(' '))}` : ''
  }

  const emit = (n: PNode, depth: number, isRoot: boolean) => {
    const pad = '  '.repeat(depth)
    const styles = exportStyles(nodes, n, isRoot)
    const styleAttr = format === 'tailwind' ? tailwindAttr(styles) : inlineStyleAttr(styles)

    const extra = Object.entries(n.attrs ?? {})
      .map(([k, v]) => ` ${k === 'for' ? 'htmlFor' : k}=${JSON.stringify(v)}`)
      .join('')

    if (n.type === 'SVG') {
      lines.push(svgToJSX(n.svg ?? '<svg/>', styleAttr, pad))

      return
    }

    if (n.type === 'Component' && n.component) {
      const info = components.find((c) => c.id === n.component!.id)

      if (info) used.set(info.id, info)
      const name = n.component.name

      const attrs = Object.entries(n.props ?? {})
        .map(([k, v]) =>
          jsxProp(k === 'class' && n.component!.framework === 'react' ? 'className' : k, v),
        )
        .join('')

      const wrap = Object.keys(styles).length
      const inner = wrap ? pad + '  ' : pad
      const parsed = parseMarkup(n.content, components)

      for (const ref of parsed.refs) {
        const c = components.find((x) => x.id === ref)

        if (c) used.set(c.id, c)
      }

      const react = n.component.framework === 'react'
      const body = parsed.nodes

      if (wrap) lines.push(`${pad}<div${styleAttr}>`)

      if (!body.length) lines.push(`${inner}<${name}${attrs} />`)
      else if (body.length === 1 && body[0].t === 'text' && body[0].v.trim().length < 50)
        lines.push(`${inner}<${name}${attrs}>${escJsx(body[0].v.trim())}</${name}>`)
      else
        lines.push(
          `${inner}<${name}${attrs}>`,
          ...printMarkup(body, inner + '  ', components, react),
          `${inner}</${name}>`,
        )

      if (wrap) lines.push(`${pad}</div>`)

      return
    }

    if (n.type === 'Image') {
      const alt = n.attrs?.alt ?? ''
      lines.push(
        `${pad}<img src=${JSON.stringify(n.src ?? '')} alt=${JSON.stringify(alt)}${styleAttr} />`,
      )

      return
    }

    const tag = n.tag || 'div'

    if (n.type === 'Text') {
      const text = n.text ?? ''

      if (!text) lines.push(`${pad}<${tag}${extra}${styleAttr} />`)
      else if (!text.includes('\n') && text.length < 60 && !/[{}<>]/.test(text))
        lines.push(`${pad}<${tag}${extra}${styleAttr}>${text}</${tag}>`)
      else {
        lines.push(`${pad}<${tag}${extra}${styleAttr}>`)
        lines.push(`${pad}  {${JSON.stringify(text)}}`)
        lines.push(`${pad}</${tag}>`)
      }

      return
    }

    const kids = n.children.map((c) => nodes[c]).filter((c): c is PNode => !!c && !c.hidden)

    if (!kids.length) {
      lines.push(`${pad}<${tag}${extra}${styleAttr} />`)

      return
    }

    lines.push(`${pad}<${tag}${extra}${styleAttr}>`)

    for (const k of kids) emit(k, depth + 1, false)
    lines.push(`${pad}</${tag}>`)
  }

  const root = nodes[id]

  if (!root) throw new Error(`Node "${id}" does not exist`)

  if (root.type === 'Root') for (const c of root.children) emit(nodes[c], 0, true)
  else emit(root, 0, true)

  if (!used.size) return lines.join('\n')
  const byPath = new Map<string, { def?: string; named: Set<string> }>()

  for (const c of used.values()) {
    const e = byPath.get(c.importPath) ?? { named: new Set<string>() }

    if (c.export === 'default') e.def = c.name
    else e.named.add(c.export === c.name ? c.name : `${c.export} as ${c.name}`)
    byPath.set(c.importPath, e)
  }

  const imports = [...byPath].map(([p, e]) => {
    const parts = [e.def, e.named.size ? `{ ${[...e.named].join(', ')} }` : ''].filter(Boolean)

    return `import ${parts.join(', ')} from ${JSON.stringify(p)}`
  })

  return `${imports.join('\n')}\n\n${lines.join('\n')}`
}

function escJsx(s: string): string {
  return /[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s
}

/** Children markup (already parsed) as indented JSX lines. */
function printMarkup(
  nodes: RNode[],
  pad: string,
  components: ComponentInfo[],
  react: boolean,
): string[] {
  const out: string[] = []

  for (const n of nodes) {
    if (n.t === 'text') {
      if (n.v.trim()) out.push(pad + escJsx(n.v.trim()))
      continue
    }

    const tag = n.t === 'c' ? (components.find((c) => c.id === n.ref)?.name ?? 'div') : n.tag

    const attrs = Object.entries(n.props)
      .map(([k, v]) => jsxProp(react && k === 'class' ? 'className' : k, v))
      .join('')

    if (!n.children.length) out.push(`${pad}<${tag}${attrs} />`)
    else if (
      n.children.length === 1 &&
      n.children[0].t === 'text' &&
      n.children[0].v.trim().length < 60
    )
      out.push(`${pad}<${tag}${attrs}>${escJsx(n.children[0].v.trim())}</${tag}>`)
    else
      out.push(
        `${pad}<${tag}${attrs}>`,
        ...printMarkup(n.children, pad + '  ', components, react),
        `${pad}</${tag}>`,
      )
  }

  return out
}

function jsxProp<T>(k: string, v: T): string {
  if (v === true) return ` ${k}`

  if (Object.prototype.toString.call(v) === '[object String]') return ` ${k}=${JSON.stringify(v)}`

  return ` ${k}={${JSON.stringify(v)}}`
}

function inlineStyleAttr(styles: Styles): string {
  const entries = Object.entries(styles)

  if (!entries.length) return ''

  const body = entries
    .map(
      ([k, v]) =>
        `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${Object.prototype.toString.call(v) === '[object Number]' ? v : JSON.stringify(v)}`,
    )
    .join(', ')

  return ` style={{ ${body} }}`
}

// ---- Tailwind mapping (v4 syntax, arbitrary-value fallback) -------------------

interface SpacingMap {
  [prop: string]: string
}

const SPACING_PROPS: SpacingMap = {
  gap: 'gap',
  rowGap: 'gap-y',
  columnGap: 'gap-x',
  padding: 'p',
  paddingTop: 'pt',
  paddingRight: 'pr',
  paddingBottom: 'pb',
  paddingLeft: 'pl',
  paddingInline: 'px',
  paddingBlock: 'py',
  margin: 'm',
  marginTop: 'mt',
  marginRight: 'mr',
  marginBottom: 'mb',
  marginLeft: 'ml',
  width: 'w',
  height: 'h',
  minWidth: 'min-w',
  minHeight: 'min-h',
  maxWidth: 'max-w',
  maxHeight: 'max-h',
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
  inset: 'inset',
}

interface KeywordMap {
  [prop: string]: Record<string, string>
}

const KEYWORDS: KeywordMap = {
  display: {
    flex: 'flex',
    block: 'block',
    'inline-flex': 'inline-flex',
    grid: 'grid',
    none: 'hidden',
    inline: 'inline',
    'inline-block': 'inline-block',
    contents: 'contents',
  },
  flexDirection: {
    row: 'flex-row',
    column: 'flex-col',
    'row-reverse': 'flex-row-reverse',
    'column-reverse': 'flex-col-reverse',
  },
  flexWrap: { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  alignItems: {
    center: 'items-center',
    'flex-start': 'items-start',
    start: 'items-start',
    'flex-end': 'items-end',
    end: 'items-end',
    stretch: 'items-stretch',
    baseline: 'items-baseline',
  },
  alignSelf: {
    center: 'self-center',
    'flex-start': 'self-start',
    start: 'self-start',
    'flex-end': 'self-end',
    end: 'self-end',
    stretch: 'self-stretch',
    auto: 'self-auto',
  },
  justifyContent: {
    center: 'justify-center',
    'flex-start': 'justify-start',
    start: 'justify-start',
    'flex-end': 'justify-end',
    end: 'justify-end',
    'space-between': 'justify-between',
    'space-around': 'justify-around',
    'space-evenly': 'justify-evenly',
  },
  position: {
    absolute: 'absolute',
    relative: 'relative',
    fixed: 'fixed',
    sticky: 'sticky',
    static: 'static',
  },
  overflow: {
    hidden: 'overflow-hidden',
    auto: 'overflow-auto',
    scroll: 'overflow-scroll',
    visible: 'overflow-visible',
    clip: 'overflow-clip',
  },
  textAlign: {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
    justify: 'text-justify',
    start: 'text-start',
    end: 'text-end',
  },
  fontStyle: { italic: 'italic', normal: 'not-italic' },
  textTransform: {
    uppercase: 'uppercase',
    lowercase: 'lowercase',
    capitalize: 'capitalize',
    none: 'normal-case',
  },
  whiteSpace: {
    nowrap: 'whitespace-nowrap',
    pre: 'whitespace-pre',
    'pre-wrap': 'whitespace-pre-wrap',
    'pre-line': 'whitespace-pre-line',
    normal: 'whitespace-normal',
  },
  boxSizing: { 'border-box': 'box-border', 'content-box': 'box-content' },
  objectFit: {
    cover: 'object-cover',
    contain: 'object-contain',
    fill: 'object-fill',
    none: 'object-none',
  },
  textDecoration: { underline: 'underline', 'line-through': 'line-through', none: 'no-underline' },
  flexShrink: { '0': 'shrink-0', '1': 'shrink' },
  flexGrow: { '0': 'grow-0', '1': 'grow' },
  flex: { '1': 'flex-1', '1 1 0%': 'flex-1', none: 'flex-none', auto: 'flex-auto' },
  cursor: { pointer: 'cursor-pointer' },
}

interface FontWeightMap {
  [weight: string]: string
}

const FONT_WEIGHTS: FontWeightMap = {
  '100': 'font-thin',
  '200': 'font-extralight',
  '300': 'font-light',
  '400': 'font-normal',
  '500': 'font-medium',
  '600': 'font-semibold',
  '700': 'font-bold',
  '800': 'font-extrabold',
  '900': 'font-black',
}

const NAMED_COLORS = new Set(['white', 'black', 'transparent', 'current', 'inherit'])

function colorClass(v: string): string {
  if (v === 'currentColor') return 'current'

  return NAMED_COLORS.has(v) ? v : arb(v)
}

function arb(v: string): string {
  const m = v.match(/^var\((--[\w-]+)\)$/)

  if (m) return `(${m[1]})`

  return `[${v.replace(/ /g, '_')}]`
}

/** Tailwind spacing-scale suffix for a length, or an arbitrary value. */
function spacing(v: string, maxScalePx = 96): string {
  if (v === '0' || v === '0px') return '0'

  if (v === '100%') return 'full'

  if (v === 'auto') return 'auto'

  if (v === 'fit-content') return 'fit'

  if (v === 'min-content') return 'min'

  if (v === 'max-content') return 'max'

  if (v === '1px') return 'px'
  const m = v.match(/^(\d+(?:\.\d+)?)px$/)

  if (m && Number.isInteger(Number(m[1]) * 4) && Number(m[1]) <= maxScalePx)
    return String(Number(m[1]) / 4)

  return arb(v)
}

const SIZE_PROPS = new Set([
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
])

function toTailwind(
  prop: string,
  value: StyleValue,
  colorNames: Map<string, string> = new Map(),
): string[] {
  const color = (v: string) => colorNames.get(normColor(v)) ?? colorClass(v)
  const v = cssValue(prop, value).trim()
  const kw = KEYWORDS[prop]?.[v]

  if (kw) return [kw]

  if (prop in SPACING_PROPS) {
    const base = SPACING_PROPS[prop]
    const parts = v.split(/\s+/)

    if ((prop === 'padding' || prop === 'margin') && parts.length > 1) {
      const [t, r = t, b = t, l = r] = parts
      const p = prop === 'padding' ? 'p' : 'm'

      if (t === b && r === l) return [`${p}y-${spacing(t)}`, `${p}x-${spacing(r)}`]

      if (r === l) return [`${p}t-${spacing(t)}`, `${p}x-${spacing(r)}`, `${p}b-${spacing(b)}`]

      return [
        `${p}t-${spacing(t)}`,
        `${p}r-${spacing(r)}`,
        `${p}b-${spacing(b)}`,
        `${p}l-${spacing(l)}`,
      ]
    }

    if (parts.length === 1) return [`${base}-${spacing(v, SIZE_PROPS.has(prop) ? 96 : 384)}`]
  }

  switch (prop) {
    case 'backgroundColor':
    case 'background':
      return [`bg-${color(v)}`]
    case 'color':
      return [`text-${color(v)}`]
    case 'borderColor':
      return [`border-${color(v)}`]
    case 'fontSize':
      return [`text-${arb(v)}`]
    case 'fontWeight':
      return [FONT_WEIGHTS[v] ?? `font-${arb(v)}`]
    case 'fontFamily':
      return [`font-${arb(v.replace(/"/g, "'"))}`]
    case 'lineHeight':
      return [`leading-${arb(v)}`]
    case 'letterSpacing':
      return [`tracking-${arb(v)}`]
    case 'borderRadius':
      return v === '9999px' || v === '999px' ? ['rounded-full'] : [`rounded-${arb(v)}`]
    case 'opacity':
      return [`opacity-${arb(v)}`]
    case 'boxShadow':
      return [`shadow-${arb(v)}`]
    case 'zIndex':
      return [`z-${arb(v)}`]
    case 'flexGrow':
      return [`grow-${arb(v)}`]
    case 'flexShrink':
      return [`shrink-${arb(v)}`]
  }

  return [`[${camelToKebab(prop)}:${v.replace(/ /g, '_')}]`]
}

// ---- SVG -> JSX ----------------------------------------------------------------

const SVG_ATTR_KEEP = new Set([
  'viewBox',
  'xmlns',
  'd',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fill',
  'stroke',
  'points',
  'transform',
  'width',
  'height',
  'id',
  'offset',
  'opacity',
  'x1',
  'x2',
  'y1',
  'y2',
  'gradientUnits',
  'preserveAspectRatio',
])

function svgAttrName(k: string): string {
  if (k === 'class') return 'className'

  if (k.startsWith('data-') || k.startsWith('aria-') || SVG_ATTR_KEEP.has(k)) return k

  if (k === 'xlink:href') return 'xlinkHref'

  if (k.includes(':')) return k.replace(/:([a-z])/g, (_, c: string) => c.toUpperCase())

  return kebabToCamel(k)
}

function svgToJSX(svg: string, styleAttr: string, pad: string): string {
  const dom = parseDocument(svg, {
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
    xmlMode: true,
  })

  const out: string[] = []

  const walk = (node: ChildNode, depth: number, isRoot: boolean) => {
    const p = pad + '  '.repeat(depth)

    if (isText(node)) {
      if (node.data.trim()) out.push(p + node.data.trim())

      return
    }

    if (!isTag(node)) return
    // SAFETY: the isTag guard above keeps only Element nodes.
    const el = node as Element

    const attrs = Object.entries(el.attribs)
      .filter(([k]) => k !== 'style')
      .map(([k, v]) => ` ${svgAttrName(k)}=${JSON.stringify(v)}`)
      .join('')

    const style = isRoot
      ? styleAttr
      : el.attribs.style
        ? inlineStyleAttr(
            Object.fromEntries(
              el.attribs.style
                .split(';')
                .filter(Boolean)
                .map((d) => {
                  const [a, ...b] = d.split(':')

                  return [kebabToCamel(a), b.join(':').trim()]
                }),
            ),
          )
        : ''

    const kids = el.children.filter((c) => isTag(c) || (isText(c) && c.data.trim()))

    if (!kids.length) out.push(`${p}<${el.name}${attrs}${style} />`)
    else {
      out.push(`${p}<${el.name}${attrs}${style}>`)

      for (const k of kids) walk(k, depth + 1, false)
      out.push(`${p}</${el.name}>`)
    }
  }

  const root = dom.children.find(isTag)

  if (root) walk(root, 0, true)

  return out.join('\n')
}
