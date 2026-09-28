import { parseDocument } from 'htmlparser2'
import render from 'dom-serializer'
import { Element, isTag, isText, type ChildNode } from 'domhandler'
import { parseStyleAttr } from '../shared/styles'
import { coerceProps } from '../shared/markup'
import type { ComponentInfo, PNode, Styles } from '../shared/types'
import { importAssetUrl, importCssUrls } from './assets'
import type { TailwindResolver } from './tailwind'

// Converts agent-written HTML into design nodes. Every element becomes a
// Frame, Text, Image or SVG node; styles stay as camelCase CSS so the editor
// can render them as real DOM without translation.

const SKIP = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'template', 'noscript'])
const PHRASING = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'label', 'font',
])
const TEXTY = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'a', 'button', 'li', 'blockquote', 'figcaption',
  'pre', 'code', 'small', 'strong', 'em', 'b', 'i', 'dt', 'dd', 'td', 'th', 'caption', 'summary', 'legend',
])
const KEEP_ATTRS = new Set(['href', 'alt', 'title', 'role', 'target', 'rel', 'type', 'placeholder', 'for', 'name'])

export interface ParseContext {
  mint: () => string
  /** Converts Tailwind classes to inline styles when present. */
  tailwind?: TailwindResolver
  /** Width of the artboard being written into, for responsive variants. */
  width?: number
  /** Components of the linked codebase; PascalCase tags matching them become Component nodes. */
  components?: ComponentInfo[]
  /** Look up an existing node subtree for <x-paper-clone>. */
  cloneSource: (id: string) => PNode[] | null
}

export interface ParseResult {
  /** Each entry is a flattened subtree: [root, ...descendants]. */
  subtrees: PNode[][]
  warnings: string[]
}

export function parseHtml(html: string, ctx: ParseContext): ParseResult {
  const dom = parseDocument(html, {
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
    recognizeSelfClosing: true,
  })
  const warnings = new Set<string>()
  const unknownClasses: string[] = []
  const subtrees: PNode[][] = []

  const push = (list: PNode[], n: PNode) => list.push(n)

  const convertChildren = (children: ChildNode[], parent: PNode, out: PNode[], pre: boolean) => {
    for (const child of children) {
      if (isText(child)) {
        const text = pre ? child.data : collapse(child.data)
        if (!text.trim()) continue
        const t = textNode(ctx, text.trim(), 'span', {})
        t.parent = parent.id
        parent.children.push(t.id)
        push(out, t)
      } else if (isTag(child)) {
        const sub = convert(child, pre)
        if (!sub) continue
        sub[0].parent = parent.id
        parent.children.push(sub[0].id)
        out.push(...sub)
      }
    }
  }

  const convert = (el: Element, preCtx: boolean): PNode[] | null => {
    const tag = el.name.toLowerCase()
    if (SKIP.has(tag) || tag === 'br' || tag === 'wbr') return null
    if (/^[A-Z]/.test(el.name) && ctx.components?.length) {
      const info = ctx.components.find((c) => c.name === el.name)
      if (info) {
        const wrapper = cleanStyles(parseStyleAttr(el.attribs.style ?? ''), warnings)
        const content = el.children.length ? render(el.children, { encodeEntities: 'utf8', selfClosingTags: true }).trim() : undefined
        return [
          {
            id: ctx.mint(),
            type: 'Component',
            name: el.attribs['layer-name']?.trim() || info.name,
            tag: 'div',
            styles: wrapper,
            component: { id: info.id, name: info.name, framework: info.framework },
            props: coerceProps(el.attribs, info.props),
            ...(content ? { content } : {}),
            parent: null,
            children: [],
          },
        ]
      }
      warnings.add(`<${el.name}> is not a component in the linked codebase (see list_components); rendered as a plain frame.`)
    }
    if (tag === 'html' || tag === 'body') {
      // Unwrap document-level wrappers into a frame.
      const frame = frameNode(ctx, 'div', parseStyleAttr(el.attribs.style ?? ''), el.attribs['layer-name'])
      const out: PNode[] = [frame]
      convertChildren(el.children, frame, out, false)
      return out
    }

    const classAttr = el.attribs.class ?? el.attribs.className
    let base: Styles = {}
    if (classAttr && ctx.tailwind) {
      const tw = ctx.tailwind.resolve(classAttr, ctx.width ?? 1440)
      base = tw.styles
      if (tw.dropped.length) warnings.add(`Tailwind variants that can't be inlined were skipped: ${tw.dropped.slice(0, 8).join(', ')}.`)
      if (tw.unknown.length) unknownClasses.push(...tw.unknown)
    } else if (classAttr) warnings.add('class attributes are ignored — use inline style="" instead.')
    const styles = cleanStyles({ ...base, ...parseStyleAttr(el.attribs.style ?? '') }, warnings)
    const layerName = el.attribs['layer-name']?.trim()

    if (tag === 'x-paper-clone' || tag === 'x-clone') {
      const sourceId = el.attribs['node-id']
      const source = sourceId ? ctx.cloneSource(sourceId) : null
      if (!source) {
        warnings.add(`x-paper-clone: node "${sourceId}" not found, skipped.`)
        return null
      }
      const cloned = cloneSubtree(source, ctx.mint)
      cloned[0] = { ...cloned[0], styles: { ...cloned[0].styles, ...styles } }
      if (layerName) cloned[0].name = layerName
      return cloned
    }

    if (tag === 'svg') {
      const attribs = { ...el.attribs }
      delete attribs.style
      delete attribs['layer-name']
      const svgStyles: Styles = { ...styles }
      if (!svgStyles.width && attribs.width && /^\d+(\.\d+)?(px)?$/.test(attribs.width)) svgStyles.width = px(attribs.width)
      if (!svgStyles.height && attribs.height && /^\d+(\.\d+)?(px)?$/.test(attribs.height))
        svgStyles.height = px(attribs.height)
      if (!attribs.xmlns) attribs.xmlns = 'http://www.w3.org/2000/svg'
      const clone = new Element(el.name, sanitizeAttrs(attribs), sanitizeSvg(el.children))
      const svg = render(clone, { encodeEntities: 'utf8', selfClosingTags: true })
      return [
        {
          id: ctx.mint(),
          type: 'SVG',
          name: layerName || 'SVG',
          tag: 'svg',
          styles: svgStyles,
          svg,
          parent: null,
          children: [],
        },
      ]
    }

    if (tag === 'img' || tag === 'image') {
      let src = el.attribs.src ?? ''
      try {
        src = importAssetUrl(src)
      } catch (e) {
        warnings.add((e as Error).message)
      }
      const attrs: Record<string, string> = {}
      if (el.attribs.alt) attrs.alt = el.attribs.alt
      const imgStyles: Styles = { ...styles }
      if (!imgStyles.width && el.attribs.width) imgStyles.width = px(el.attribs.width)
      if (!imgStyles.height && el.attribs.height) imgStyles.height = px(el.attribs.height)
      return [
        {
          id: ctx.mint(),
          type: 'Image',
          name: layerName || el.attribs.alt?.slice(0, 40) || 'Image',
          tag: 'img',
          styles: imgStyles,
          src,
          attrs,
          parent: null,
          children: [],
        },
      ]
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      warnings.add(`<${tag}> is drawn as a static frame; interactive form controls are not supported.`)
      const frame = frameNode(ctx, 'div', styles, layerName || cap(tag))
      const label = el.attribs.value || el.attribs.placeholder || textOf(el, false)
      const out: PNode[] = [frame]
      if (label) {
        const t = textNode(ctx, label, 'span', {})
        t.parent = frame.id
        frame.children.push(t.id)
        out.push(t)
      }
      return out
    }

    if (tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'tbody' || tag === 'thead') {
      warnings.add('HTML tables render but are hard to edit — prefer flex rows and columns.')
    }

    const pre = preCtx || tag === 'pre' || /^pre/.test(String(styles.whiteSpace ?? ''))
    const hasText = el.children.some((c) => isText(c) && c.data.trim())
    const elements = el.children.filter(isTag) as Element[]
    const display = String(styles.display ?? '')
    const layoutContainer = /flex|grid/.test(display)
    const onlyPhrasing = elements.every((c) => isPhrasingDeep(c))

    if ((hasText && onlyPhrasing && !(layoutContainer && elements.length)) || (elements.length && onlyPhrasing && !layoutContainer && elements.every((c) => c.name.toLowerCase() === 'br'))) {
      const text = textOf(el, pre)
      const n = textNode(ctx, text, tag, styles, layerName)
      n.attrs = keepAttrs(el)
      if (elements.some((c) => c.name.toLowerCase() !== 'br' && c.attribs.style))
        warnings.add('Rich text is flattened: inline styles on nested <span>/<b> inside text were dropped.')
      return [n]
    }

    if (!hasText && !elements.length && TEXTY.has(tag) && tag !== 'button') {
      const n = textNode(ctx, '', tag, styles, layerName)
      n.attrs = keepAttrs(el)
      return [n]
    }

    const frame = frameNode(ctx, tag, styles, layerName)
    frame.attrs = keepAttrs(el)
    const out: PNode[] = [frame]
    convertChildren(el.children, frame, out, pre)
    return out
  }

  for (const child of dom.children) {
    if (isTag(child)) {
      const sub = convert(child, false)
      if (sub) subtrees.push(sub)
    } else if (isText(child) && child.data.trim()) {
      subtrees.push([textNode(ctx, collapse(child.data).trim(), 'span', {})])
    }
  }

  if (unknownClasses.length) warnings.add(`Unknown classes (not Tailwind utilities) were ignored: ${[...new Set(unknownClasses)].slice(0, 12).join(', ')}.`)
  return { subtrees, warnings: [...warnings] }
}

/** Sanitize standalone SVG markup (e.g. from a URL import). */
export function sanitizeSvgMarkup(svg: string): string {
  const dom = parseDocument(svg, { lowerCaseTags: false, lowerCaseAttributeNames: false, recognizeSelfClosing: true })
  const root = dom.children.find(isTag)
  if (!root || root.name.toLowerCase() !== 'svg') return '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const clean = new Element(root.name, sanitizeAttrs(root.attribs), sanitizeSvg(root.children))
  return render(clean, { encodeEntities: 'utf8', selfClosingTags: true })
}

/** Strip scripts, event handlers and javascript: URLs from inline SVG. */
function sanitizeSvg(children: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = []
  for (const c of children) {
    if (isTag(c)) {
      const tag = c.name.toLowerCase()
      if (tag === 'script' || tag === 'foreignobject' || tag === 'iframe') continue
      c.attribs = sanitizeAttrs(c.attribs)
      c.children = sanitizeSvg(c.children)
      for (const k of c.children) k.parent = c
    }
    out.push(c)
  }
  return out
}

function sanitizeAttrs(attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(attribs)) {
    if (/^on/i.test(k)) continue
    if (/href$/i.test(k) && /^\s*javascript:/i.test(v)) continue
    out[k] = v
  }
  return out
}

function isPhrasingDeep(el: Element): boolean {
  const tag = el.name.toLowerCase()
  if (!PHRASING.has(tag)) return false
  return el.children.every((c) => !isTag(c) || isPhrasingDeep(c))
}

function textOf(el: Element, pre: boolean): string {
  let out = ''
  const walk = (nodes: ChildNode[]) => {
    for (const c of nodes) {
      if (isText(c)) out += pre ? c.data : collapse(c.data)
      else if (isTag(c)) {
        if (c.name.toLowerCase() === 'br') out += '\n'
        else walk(c.children)
      }
    }
  }
  walk(el.children)
  if (pre) return out.replace(/^\n/, '').replace(/\n$/, '')
  return out
    .split('\n')
    .map((l) => l.replace(/ +/g, ' ').trim())
    .join('\n')
    .trim()
}

function collapse(s: string): string {
  return s.replace(/[ \t\n\r\f]+/g, ' ')
}

function px(v: string): string {
  return /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim()
}

function cap(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}

const FRAME_NAMES: Record<string, string> = {
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

function frameNode(ctx: ParseContext, tag: string, styles: Styles, name?: string): PNode {
  return {
    id: ctx.mint(),
    type: 'Frame',
    name: name || FRAME_NAMES[tag] || cap(tag),
    tag: tag === 'html' || tag === 'body' ? 'div' : tag,
    styles,
    parent: null,
    children: [],
  }
}

function textNode(ctx: ParseContext, text: string, tag: string, styles: Styles, name?: string): PNode {
  return {
    id: ctx.mint(),
    type: 'Text',
    name: name || text.replace(/\s+/g, ' ').slice(0, 40) || 'Text',
    tag,
    styles,
    text,
    parent: null,
    children: [],
  }
}

function keepAttrs(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(el.attribs)) {
    if (KEEP_ATTRS.has(k) || k.startsWith('aria-') || k.startsWith('data-')) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function cleanStyles(styles: Styles, warnings: Set<string>): Styles {
  for (const [k, v] of Object.entries(styles)) {
    if (typeof v === 'string' && /url\(/i.test(v)) {
      try {
        styles[k] = importCssUrls(v)
      } catch (e) {
        warnings.add((e as Error).message)
      }
    }
    if (/^margin/.test(k) && v !== '0' && v !== '0px' && v !== 'auto')
      warnings.add('margin works but is discouraged — prefer padding and gap on the parent.')
  }
  return styles
}

/** Deep-clone a flattened subtree with fresh ids. Returns [root, ...rest] and fills idMap. */
export function cloneSubtree(nodes: PNode[], mint: () => string, idMap: Record<string, string> = {}): PNode[] {
  for (const n of nodes) idMap[n.id] = mint()
  return nodes.map((n) => ({
    ...structuredClone(n),
    id: idMap[n.id],
    parent: n.parent && idMap[n.parent] ? idMap[n.parent] : null,
    children: n.children.map((c) => idMap[c]),
  }))
}
