import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { compile } from '@tailwindcss/node'
import { kebabToCamel } from '../shared/styles'
import type { Styles } from '../shared/types'

// Tailwind classes -> inline styles. Designs store inline CSS, so utility
// classes are compiled with Tailwind v4 (the project's own CSS entry when a
// codebase is linked, so custom theme tokens work) and resolved to concrete
// declarations. Responsive variants apply by artboard width; interaction and
// dark-mode variants can't be inlined and are reported back.

const ROOT_PX = 16

const require = createRequire(import.meta.url)

type Compiler = Awaited<ReturnType<typeof compile>>

const compilers = new Map<string, { mtime: number; compiler: Promise<Compiler> }>()

const DEFAULT_CSS = `@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);`

function getCompiler(cssEntry?: string): Promise<Compiler> {
  const key = cssEntry ?? '<default>'
  const mtime = cssEntry ? fs.statSync(cssEntry).mtimeMs : 0
  const hit = compilers.get(key)

  if (hit && hit.mtime === mtime) return hit.compiler
  const css = cssEntry ? fs.readFileSync(cssEntry, 'utf8') : DEFAULT_CSS
  const base = cssEntry ? path.dirname(cssEntry) : path.dirname(new URL(import.meta.url).pathname)

  const compiler = compile(css, { base, onDependency: () => {} }).catch((e) => {
    compilers.delete(key)

    if (cssEntry) {
      // SAFETY: compile rejects with Error instances for unreadable CSS entries.
      console.warn(
        `[paperish] Tailwind entry ${cssEntry} failed to compile, using the default theme:`,
        (e as Error).message,
      )

      return getCompiler()
    }

    throw e
  })

  compilers.set(key, { mtime, compiler })

  return compiler
}

// ---- minimal nested CSS parser ---------------------------------------------------

interface CssBlock {
  prelude: string
  decls: [string, string][]
  children: CssBlock[]
}

function parseCss(css: string): CssBlock {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0

  const parseBlock = (prelude: string): CssBlock => {
    const block: CssBlock = { prelude, decls: [], children: [] }
    let buf = ''

    while (i < css.length) {
      const ch = css[i]

      if (ch === '"' || ch === "'") {
        const end = css.indexOf(ch, i + 1)
        buf += css.slice(i, end + 1)
        i = end + 1
        continue
      }

      if (ch === '{') {
        i++
        block.children.push(parseBlock(buf.trim()))
        buf = ''
        continue
      }

      if (ch === '}') {
        i++
        pushDecl(block, buf)

        return block
      }

      if (ch === ';') {
        i++
        pushDecl(block, buf)
        buf = ''
        continue
      }

      buf += ch
      i++
    }

    pushDecl(block, buf)

    return block
  }

  return parseBlock('')
}

function pushDecl(block: CssBlock, raw: string) {
  const s = raw.trim()

  if (!s || s.startsWith('@')) return
  const c = s.indexOf(':')

  if (c < 0) return
  block.decls.push([s.slice(0, c).trim(), s.slice(c + 1).trim()])
}

// ---- rule extraction -------------------------------------------------------------

interface UtilityRule {
  token: string
  decls: [string, string][]
  /** Viewport width predicate from @media, if any. */
  media: ((w: number) => boolean) | null
}

interface Compiled {
  rules: UtilityRule[]
  theme: Map<string, string>
  initial: Map<string, string>
  /** tokens that produced only state/child-selector rules */
  unsupported: Map<string, string>
}

function unescapeSelector(sel: string): string {
  return sel.replace(/\\(.)/g, '$1')
}

function mediaPredicate(params: string): ((w: number) => boolean) | 'skip' {
  const p = params.trim()
  let m = p.match(/^\(\s*width\s*>=\s*([\d.]+)(rem|px|em)\s*\)$/)

  if (m) {
    const px = Number(m[1]) * (m[2] === 'px' ? 1 : ROOT_PX)

    return (w) => w >= px
  }

  m = p.match(/^\(\s*width\s*<\s*([\d.]+)(rem|px|em)\s*\)$/)

  if (m) {
    const px = Number(m[1]) * (m[2] === 'px' ? 1 : ROOT_PX)

    return (w) => w < px
  }

  return 'skip'
}

function extract(css: string): Compiled {
  const root = parseCss(css)
  const out: Compiled = { rules: [], theme: new Map(), initial: new Map(), unsupported: new Map() }

  const walk = (b: CssBlock, media: ((w: number) => boolean) | null, skip: string | null) => {
    const pre = b.prelude

    if (pre.startsWith('@property')) {
      const name = pre.replace('@property', '').trim()
      const init = b.decls.find(([k]) => k === 'initial-value')

      if (init) out.initial.set(name, init[1])

      return
    }

    if (pre.startsWith('@media')) {
      const pred = mediaPredicate(pre.slice(6))

      const reason =
        pred === 'skip'
          ? /prefers-color-scheme/.test(pre)
            ? 'dark mode'
            : /hover/.test(pre)
              ? 'hover'
              : 'media query'
          : null

      for (const c of b.children) walk(c, pred === 'skip' ? media : pred, reason ?? skip)

      return
    }

    if (pre === '' || pre.startsWith('@layer') || pre.startsWith('@supports')) {
      // @supports: we render in modern Chromium, so take the supported branch.
      for (const c of b.children) walk(c, media, skip)

      return
    }

    if (pre.startsWith('@')) return // @keyframes, @font-face, @custom-variant…

    if (/^:root|^:host/.test(pre)) {
      for (const [k, v] of b.decls) if (k.startsWith('--')) out.theme.set(k, v)

      return
    }

    // A style rule. Only plain `.token` selectors can be inlined.
    for (const sel of pre.split(',').map((s) => s.trim())) {
      const m = sel.match(/^\.((?:\\.|[^\s.:#>+~[\]()])+)(.*)$/)
      const rest = m?.[2] ?? ''

      if (!m) {
        const t = sel.match(/\.((?:\\.|[^\s.:#>+~[\]()])+)/)

        if (t) out.unsupported.set(unescapeSelector(t[1]), 'targets child elements')
        continue
      }

      const token = unescapeSelector(m[1])

      if (skip || rest) {
        out.unsupported.set(
          token,
          skip ??
            (/:hover|:focus|:active|:disabled|:checked|:visited|group|peer/.test(rest)
              ? 'interaction state'
              : 'selector variant'),
        )
        continue
      }

      const decls = [...b.decls]

      // Nested @supports / @media inside the rule (e.g. color-mix fallbacks).
      for (const c of b.children) {
        if (c.prelude.startsWith('@supports')) decls.push(...c.decls)
        else if (c.prelude.startsWith('@media')) {
          const pred = mediaPredicate(c.prelude.slice(6))

          if (pred !== 'skip') out.rules.push({ token, decls: c.decls, media: pred })
          else out.unsupported.set(token, 'media query')
        } else if (c.prelude.startsWith('&')) out.unsupported.set(token, 'interaction state')
      }

      out.rules.push({ token, decls, media })
    }
  }

  walk(root, null, null)

  return out
}

// ---- value resolution --------------------------------------------------------------

function resolveVars(
  value: string,
  lookup: (name: string) => string | undefined,
  depth = 0,
): string | null {
  if (depth > 12 || !value.includes('var(')) return value
  let out = ''
  let i = 0

  while (i < value.length) {
    const at = value.indexOf('var(', i)

    if (at < 0) {
      out += value.slice(i)
      break
    }

    out += value.slice(i, at)
    // find matching paren
    let d = 0
    let j = at + 3

    for (; j < value.length; j++) {
      if (value[j] === '(') d++
      else if (value[j] === ')' && --d === 0) break
    }

    const inner = value.slice(at + 4, j)
    const comma = topLevelComma(inner)
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1)
    const v = lookup(name)
    let resolved: string | null

    if (v !== undefined && v !== 'initial') resolved = resolveVars(v, lookup, depth + 1)
    else if (fallback !== undefined) resolved = resolveVars(fallback.trim(), lookup, depth + 1)
    else resolved = null

    if (resolved === null) return null
    out += resolved
    i = j + 1
  }

  return out
}

function topLevelComma(s: string): number {
  let d = 0

  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') d--
    else if (s[i] === ',' && d === 0) return i
  }

  return -1
}

/** Evaluate simple calc() expressions and convert rem to px for readability. */
function simplifyCss(value: string): string {
  let v = value

  for (let n = 0; n < 8; n++) {
    const next = v.replace(/calc\(([^()]*)\)/g, (m, expr: string) => {
      const r = evalExpr(expr)

      return r ?? m
    })

    if (next === v) break
    v = next
  }

  v = v.replace(/(-?\d*\.?\d+)rem\b/g, (_m, n: string) => `${round(Number(n) * ROOT_PX)}px`)

  return v
}

function evalExpr(expr: string): string | null {
  const tokens = expr.match(/-?\d*\.?\d+(?:rem|px|em|%)?|[*/+-]|\S/g)

  if (!tokens) return null
  let unit: string | null = null
  const vals: (number | string)[] = []

  for (const t of tokens) {
    if (/^[*/+-]$/.test(t)) {
      vals.push(t)
      continue
    }

    const m = t.match(/^(-?\d*\.?\d+)(rem|px|em|%)?$/)

    if (!m) return null
    let num = Number(m[1])
    let u = m[2] ?? ''

    if (u === 'rem') {
      num *= ROOT_PX
      u = 'px'
    }

    if (u) {
      if (unit && unit !== u) return null
      unit = u
    }

    vals.push(num)
  }

  // left-to-right with * / precedence
  const stack: (number | string)[] = []

  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]

    if (v === '*' || v === '/') {
      // SAFETY: the operand stack holds numbers and operator strings; non-numbers are rejected by the guard below.
      const a = stack.pop() as number
      // SAFETY: vals entries after an operator are numeric operands; non-numbers are rejected by the guard below.
      const b = vals[++i] as number

      if (
        Object.prototype.toString.call(a) !== '[object Number]' ||
        Object.prototype.toString.call(b) !== '[object Number]'
      )
        return null
      stack.push(v === '*' ? a * b : a / b)
    } else stack.push(v)
  }

  // SAFETY: expression evaluation starts from the first numeric operand; non-numbers are rejected by the guard below.
  let acc = stack[0] as number

  for (let i = 1; i < stack.length; i += 2) {
    const op = stack[i]
    // SAFETY: alternating stack entries after the accumulator are numeric operands; non-numbers are rejected by the guard below.
    const b = stack[i + 1] as number

    if (
      Object.prototype.toString.call(acc) !== '[object Number]' ||
      Object.prototype.toString.call(b) !== '[object Number]'
    )
      return null
    acc = op === '+' ? acc + b : acc - b
  }

  if (Object.prototype.toString.call(acc) !== '[object Number]' || !isFinite(acc)) return null

  return `${round(acc)}${unit ?? ''}`
}

function round(n: number) {
  return Math.round(n * 1000) / 1000
}

/** Drop Tailwind's placeholder shadow layers (`0 0 #0000`). */
function cleanShadow(v: string): string {
  const parts: string[] = []
  let d = 0
  let cur = ''

  for (const ch of v) {
    if (ch === '(') d++
    else if (ch === ')') d--

    if (ch === ',' && d === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }

  parts.push(cur.trim())

  const kept = parts.flatMap((p) => {
    const q = p.replace(/\s+/g, ' ')

    return q && q !== '0 0 #0000' && q !== 'none' ? [q] : []
  })

  return kept.length ? kept.join(', ') : 'none'
}

interface LogicalMap {
  [prop: string]: string[]
}

const LOGICAL: LogicalMap = {
  paddingInline: ['paddingLeft', 'paddingRight'],
  paddingBlock: ['paddingTop', 'paddingBottom'],
  paddingInlineStart: ['paddingLeft'],
  paddingInlineEnd: ['paddingRight'],
  paddingBlockStart: ['paddingTop'],
  paddingBlockEnd: ['paddingBottom'],
  marginInline: ['marginLeft', 'marginRight'],
  marginBlock: ['marginTop', 'marginBottom'],
  marginInlineStart: ['marginLeft'],
  marginInlineEnd: ['marginRight'],
  marginBlockStart: ['marginTop'],
  marginBlockEnd: ['marginBottom'],
  insetInline: ['left', 'right'],
  insetBlock: ['top', 'bottom'],
  borderInlineWidth: ['borderLeftWidth', 'borderRightWidth'],
  borderBlockWidth: ['borderTopWidth', 'borderBottomWidth'],
}

// ---- theme names (for exporting styles back to classes) -----------------------------

const colorNameCache = new Map<string, Map<string, string>>()

/** Normalized color value -> Tailwind color name (e.g. "zinc-900"), incl. the project's @theme. */
export function tailwindColorNames(cssEntry?: string): Map<string, string> {
  const key = cssEntry ?? '<default>'
  const hit = colorNameCache.get(key)

  if (hit) return hit
  const map = new Map<string, string>()

  const read = (file: string) => {
    try {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/g)) {
        const v = normColor(m[2])

        if (!map.has(v)) map.set(v, m[1])
      }
    } catch {}
  }

  try {
    read(path.join(path.dirname(require.resolve('tailwindcss/package.json')), 'theme.css'))
  } catch {
    read(path.join(process.cwd(), 'node_modules/tailwindcss/theme.css'))
  }

  if (cssEntry) read(cssEntry)
  colorNameCache.set(key, map)

  return map
}

export function normColor(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\d)\.0+(?=\D)/g, '$1')
}

// ---- public API ------------------------------------------------------------------

export interface TailwindResolver {
  /** Styles for a class attribute at a given artboard width. */
  resolve(
    classAttr: string,
    width: number,
  ): { styles: Styles; dropped: string[]; unknown: string[] }
}

export function classTokens(html: string): string[] {
  const out = new Set<string>()

  for (const m of html.matchAll(/\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    for (const t of (m[1] ?? m[2]).split(/\s+/)) if (t) out.add(t)

  return [...out]
}

export async function tailwindResolver(
  tokens: string[],
  cssEntry?: string,
): Promise<TailwindResolver> {
  const compiler = await getCompiler(cssEntry)
  const compiled = extract(compiler.build(tokens))
  const known = new Set(compiled.rules.map((r) => r.token))

  return {
    resolve(classAttr, width) {
      const classes = classAttr.split(/\s+/).filter(Boolean)
      const set = new Set(classes)
      const dropped: string[] = []
      const unknown: string[] = []

      for (const c of classes) {
        if (compiled.unsupported.has(c) && !known.has(c))
          dropped.push(`${c} (${compiled.unsupported.get(c)})`)
        else if (!known.has(c)) unknown.push(c)
      }

      const custom = new Map<string, string>()
      const decls: [string, string][] = []

      for (const r of compiled.rules) {
        if (!set.has(r.token) || (r.media && !r.media(width))) continue

        for (const [k, v] of r.decls) {
          if (k.startsWith('--')) custom.set(k, v)
          else decls.push([k, v])
        }
      }

      const lookup = (name: string) =>
        custom.get(name) ?? compiled.initial.get(name) ?? compiled.theme.get(name)

      const styles: Styles = {}

      for (const [k, raw] of decls) {
        const resolved = resolveVars(raw, lookup)

        if (resolved === null) continue
        const camel = kebabToCamel(k)
        let value = simplifyCss(resolved.trim())

        if (camel === 'boxShadow') value = cleanShadow(value)

        for (const p of LOGICAL[camel] ?? [camel]) styles[p] = value
      }

      return { styles, dropped, unknown }
    },
  }
}
