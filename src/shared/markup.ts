import { parseDocument } from 'htmlparser2'
import { isTag, isText, type ChildNode } from 'domhandler'
import { parseStyleAttr } from './styles'
import type { ComponentInfo, ComponentProp } from './types'

// Children markup for component instances (`<Card><CardTitle>Hi</CardTitle></Card>`).
// Parsed into a serializable tree the component host turns into React/Vue
// elements. PascalCase tags resolve to components of the linked codebase.

export type RNode =
  | { t: 'text'; v: string }
  | { t: 'el'; tag: string; props: Record<string, unknown>; children: RNode[] }
  | { t: 'c'; ref: string; props: Record<string, unknown>; children: RNode[] }

export interface ParsedMarkup {
  nodes: RNode[]
  /** Component ids referenced anywhere in the tree. */
  refs: string[]
  unknown: string[]
}

const EVENTS = new Set([
  'click', 'dblclick', 'change', 'input', 'submit', 'reset', 'focus', 'blur', 'keydown', 'keyup', 'keypress', 'load',
  'error', 'abort', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'wheel',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'touchstart',
  'touchend', 'touchmove', 'scroll', 'resize', 'contextmenu', 'drag', 'dragstart', 'dragend', 'drop', 'dragover', 'copy',
  'paste', 'cut', 'animationend', 'transitionend', 'toggle', 'select', 'beforeinput', 'focusin', 'focusout',
])

/** onclick / onClick style event handler attributes (never passed through). */
export function isEventAttr(name: string): boolean {
  const n = name.replace(/^[:@]|^v-on:/, '').toLowerCase()
  return name.startsWith('@') || name.startsWith('v-on:') || (n.startsWith('on') && EVENTS.has(n.slice(2)))
}

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'col', 'wbr'])

export function parseMarkup(markup: string | undefined, components: ComponentInfo[]): ParsedMarkup {
  const refs = new Set<string>()
  const unknown = new Set<string>()
  if (!markup?.trim()) return { nodes: [], refs: [], unknown: [] }
  const byName = new Map(components.map((c) => [c.name, c]))
  const dom = parseDocument(markup, { lowerCaseTags: false, lowerCaseAttributeNames: false, recognizeSelfClosing: true })
  const walk = (nodes: ChildNode[]): RNode[] => {
    const out: RNode[] = []
    for (const n of nodes) {
      if (isText(n)) {
        const v = n.data.replace(/\s+/g, ' ')
        if (v.trim()) out.push({ t: 'text', v })
        continue
      }
      if (!isTag(n)) continue
      const name = n.name
      if (/^[A-Z]/.test(name)) {
        const info = byName.get(name)
        if (!info) {
          unknown.add(name)
          out.push({ t: 'el', tag: 'div', props: {}, children: walk(n.children) })
          continue
        }
        refs.add(info.id)
        out.push({ t: 'c', ref: info.id, props: coerceProps(n.attribs, info.props), children: walk(n.children) })
      } else {
        const tag = name.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'iframe') continue
        const props: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(n.attribs)) {
          if (isEventAttr(k)) continue
          if (k === 'style') props.style = parseStyleAttr(v)
          else if (k === 'className') props.class = v
          else props[k] = v
        }
        out.push({ t: 'el', tag, props, children: VOID.has(tag) ? [] : walk(n.children) })
      }
    }
    return out
  }
  return { nodes: walk(dom.children), refs: [...refs], unknown: [...unknown] }
}

/**
 * Attribute strings -> typed props, guided by the component's prop info.
 * `:prop="json"` and `prop={json}` are parsed as JSON; bare attributes are true.
 */
export function coerceProps(attrs: Record<string, string>, info: ComponentProp[]): Record<string, unknown> {
  const types = new Map(info.map((p) => [p.name, p.type]))
  const out: Record<string, unknown> = {}
  for (const [rawKey, raw] of Object.entries(attrs)) {
    if (rawKey === 'layer-name' || rawKey === 'style' || isEventAttr(rawKey)) continue
    const key = rawKey.replace(/^:/, '').replace(/^v-bind:/, '')
    const type = types.get(key)
    let value: unknown = raw
    const braced = raw.match(/^\{([\s\S]*)\}$/)
    if (rawKey.startsWith(':') || braced) value = parseJsonish(braced ? braced[1] : raw)
    else if (raw === '' && type !== 'string') value = true
    else if (type === 'boolean') value = raw !== 'false'
    else if (type === 'number' && raw.trim() !== '' && !isNaN(Number(raw))) value = Number(raw)
    out[key === 'className' ? 'class' : key] = value
  }
  return out
}

function parseJsonish(s: string): unknown {
  const t = s.trim()
  try {
    return JSON.parse(t)
  } catch {
    try {
      // single-quoted strings / unquoted keys, the common agent slips
      return JSON.parse(t.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'))
    } catch {
      return t.replace(/^['"]|['"]$/g, '')
    }
  }
}
