import type { StyleValue, Styles } from './types'

export function camelToKebab(prop: string): string {
  if (prop.startsWith('--')) return prop
  const k = prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

  // Vendor prefixes: WebkitFoo -> -webkit-foo
  return /^(webkit|moz|ms)-/.test(k) && /^[A-Z]/.test(prop) ? '-' + k : k
}

export function kebabToCamel(prop: string): string {
  prop = prop.trim()

  if (prop.startsWith('--')) return prop

  if (prop.startsWith('-ms-')) prop = prop.slice(1)

  return prop.toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

// Properties where a bare number is not a pixel length (mirrors React's list).
const UNITLESS = new Set([
  'animationIterationCount',
  'aspectRatio',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'fontWeight',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
  'WebkitLineClamp',
])

export function cssValue(prop: string, v: StyleValue): string {
  if (String(v) !== v)
    return UNITLESS.has(prop) || prop.startsWith('--') || v === 0 ? String(v) : `${v}px`

  return v
}

/** Split a declaration list on `;`, respecting quotes and parentheses. */
function splitDeclarations(css: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''

  for (let i = 0; i < css.length; i++) {
    const ch = css[i]

    if (quote) {
      if (ch === '\\') {
        cur += ch + (css[++i] ?? '')
        continue
      }

      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }

    cur += ch
  }

  if (cur.trim()) out.push(cur)

  return out
}

export function parseStyleAttr(css: string): Styles {
  const styles: Styles = {}

  for (const decl of splitDeclarations(css)) {
    const i = decl.indexOf(':')

    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    let value = decl.slice(i + 1).trim()

    if (!prop || !value) continue
    value = value.replace(/\s*!important\s*$/i, '')
    styles[kebabToCamel(prop)] = value
  }

  return styles
}

export function stylesToCss(styles: Styles, sep = '; '): string {
  return Object.entries(styles)
    .map(([k, v]) => `${camelToKebab(k)}: ${cssValue(k, v)}`)
    .join(sep)
}

/** Normalize a style object coming from an agent: camelCase keys, trimmed values. */
export function normalizeStyles(input: Record<string, StyleValue | null | undefined>): Styles {
  const out: Styles = {}

  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue
    const key = k.includes('-') && !k.startsWith('--') ? kebabToCamel(k) : k
    out[key] = String(v) !== v ? v : String(v).trim()
  }

  return out
}

export function fontFamiliesOf(value: StyleValue | undefined): string[] {
  if (!value || String(value) !== value) return []

  return String(value)
    .split(',')
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ''))
    .filter((f) => f && !f.startsWith('var(') && !GENERIC_FAMILIES.has(f.toLowerCase()))
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
])
