import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { JsonValue } from '../shared/types'
import { designMdPath, tokensPath } from './projects'

// A repo's DESIGN.md (https://github.com/google-labs-code/design.md): YAML
// front matter with tokens, and prose whose "Do's and Don'ts" become rules.
// Tokens can also come from a Tailwind v4 stylesheet's @theme; the front
// matter wins where both name a token.

interface Typography {
  fontFamily?: string
  fontSize?: string
  fontWeight?: number | string
}

export interface DesignSystem {
  path: string
  colors: Record<string, string>
  typography: Record<string, Typography>
  rounded: Record<string, string>
  spacing: Record<string, string | number>
  /** Items of the "Do's and Don'ts" section. */
  rules: string[]
}

type Tokens = Omit<DesignSystem, 'path' | 'rules'>

const cache = new Map<string, { stamp: string; ds: DesignSystem }>()

/** The checkout's DESIGN.md and theme tokens, or null when it has neither. Throws on front matter that isn't YAML. */
export function readDesignMd(checkout: string): DesignSystem | null {
  const file = path.join(checkout, designMdPath(checkout))
  const rel = tokensPath(checkout)
  const css = rel ? path.join(checkout, rel) : null
  const mdTime = mtimeOf(file)
  const cssTime = css ? mtimeOf(css) : null

  if (mdTime === null && cssTime === null) return null
  const key = `${file}\n${css}`
  const stamp = `${mdTime}\n${cssTime}`
  const hit = cache.get(key)

  if (hit?.stamp === stamp) return hit.ds
  const md = mdTime === null ? null : parseDesignMd(fs.readFileSync(file, 'utf8'), file)
  const theme = css && cssTime !== null ? themeTokens(fs.readFileSync(css, 'utf8')) : null

  const ds: DesignSystem = {
    path: md?.path ?? css ?? file,
    colors: { ...theme?.colors, ...md?.colors },
    typography: { ...theme?.typography, ...md?.typography },
    rounded: { ...theme?.rounded, ...md?.rounded },
    spacing: { ...theme?.spacing, ...md?.spacing },
    rules: md?.rules ?? [],
  }

  cache.set(key, { stamp, ds })

  return ds
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

function themeTokens(text: string): Tokens {
  const theme = new Map<string, string>()
  const root = new Map<string, string>()

  for (const { head, body } of topLevelBlocks(text.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    const into = /^@theme\b/.test(head) ? theme : head === ':root' ? root : null

    if (into)
      for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) into.set(d[1], d[2].trim())
  }

  const resolve = (v: string, depth = 0): string => {
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/)

    if (!ref || depth > 8) return v
    const next = theme.get(ref[1]) ?? root.get(ref[1]) ?? ref[2]

    return next === undefined ? v : resolve(next.trim(), depth + 1)
  }

  const out: Tokens = { colors: {}, typography: {}, rounded: {}, spacing: {} }

  for (const [name, raw] of theme) {
    const value = resolve(raw)
    const [, group, key] = name.match(/^--(color|radius|spacing|text|font)-(.+)$/) ?? []

    if (!group || !key || key.includes('--') || value === 'initial' || value.startsWith('var('))
      continue

    if (group === 'color') out.colors[key] = value
    else if (group === 'radius') out.rounded[key] = value
    else if (group === 'spacing') out.spacing[key] = value
    else if (group === 'text') out.typography[`text-${key}`] = { fontSize: value }
    else if (!key.startsWith('weight-'))
      out.typography[`font-${key}`] = {
        fontFamily: value.split(',')[0].replace(/['"]/g, '').trim(),
      }
  }

  return out
}

function topLevelBlocks(css: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = []
  let depth = 0
  let start = 0
  let open = 0

  for (let i = 0; i < css.length; i++) {
    const c = css[i]

    if (c === '{') {
      if (depth === 0) open = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--

      if (depth === 0) {
        out.push({ head: css.slice(start, open).trim(), body: css.slice(open + 1, i) })
        start = i + 1
      }
    } else if (c === ';' && depth === 0) start = i + 1
  }

  return out
}

function parseDesignMd(text: string, file: string): DesignSystem {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  let front: Record<string, JsonValue> = {}

  if (m) {
    let raw: unknown

    try {
      raw = parse(m[1])
    } catch (e) {
      // SAFETY: yaml parse throws Error instances for invalid YAML.
      throw new Error(
        `DESIGN.md front matter isn't valid YAML: ${(e as Error).message.split('\n')[0]}`,
        { cause: e },
      )
    }

    const parsed = z.record(z.string(), z.json()).safeParse(raw ?? {})

    if (!parsed.success)
      throw new Error(`DESIGN.md front matter must be a mapping of token groups`, {
        cause: parsed.error,
      })

    front = parsed.data
  }

  const resolve = (v: JsonValue, depth = 0): JsonValue => {
    const ref = isStringValue(v) ? v.match(/^\{([\w.-]+)\}$/) : null

    if (!ref || depth > 8) return v
    let cur: JsonValue = front

    for (const key of ref[1].split('.')) cur = isRecord(cur) ? cur[key] : undefined

    return resolve(cur, depth + 1)
  }

  const group = <T>(name: string) => {
    const g = front[name]

    if (!isRecord(g)) return {}
    const out: Record<string, T> = {}

    for (const [k, v] of Object.entries(g)) {
      if (isRecord(v)) {
        const nested: Record<string, JsonValue> = {}

        for (const [a, b] of Object.entries(v)) nested[a] = resolve(b)

        // SAFETY: group callers request the section's documented shape; nested token maps resolve to JSON values of that shape.
        out[k] = nested as T
      } else {
        // SAFETY: group callers request the section's documented shape; leaf token values resolve to JSON scalars of that shape.
        out[k] = resolve(v) as T
      }
    }

    return out
  }

  return {
    path: file,
    colors: group<string>('colors'),
    typography: group<Typography>('typography'),
    rounded: group<string>('rounded'),
    spacing: group<string | number>('spacing'),
    rules: rulesOf(m ? text.slice(m[0].length) : text),
  }
}

function rulesOf(body: string): string[] {
  const out: string[] = []
  let inRules = false

  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/)

    if (h) {
      inRules = /^do'?s\s*(and|&)\s*don'?ts$/i.test(h[1].replace(/[’‘]/g, "'").trim())
      continue
    }

    const item = inRules && line.match(/^\s*[-*+]\s+(.+)$/)

    if (item) out.push(item[1].replace(/\*\*|__|`/g, '').trim())
  }

  return out
}

/** A dimension in px ("16px", "1rem", 16), or null for anything else. */
export function px(v: JsonValue): number | null {
  if (isNumberValue(v)) return v

  const m = String(v ?? '')
    .trim()
    .match(/^(-?\d*\.?\d+)(px|rem|em)?$/)

  if (!m) return null

  return parseFloat(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1)
}

function isStringValue(v: JsonValue): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

function isNumberValue(v: JsonValue): v is number {
  return Object.prototype.toString.call(v) === '[object Number]'
}

function isRecord(v: JsonValue): v is { [key: string]: JsonValue } {
  return Object.prototype.toString.call(v) === '[object Object]'
}
