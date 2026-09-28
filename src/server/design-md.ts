import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

// A repo's DESIGN.md (https://github.com/google-labs-code/design.md): YAML
// front matter with tokens, and prose whose "Do's and Don'ts" become rules.

export interface Typography {
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

const cache = new Map<string, { mtime: number; ds: DesignSystem }>()

/** The checkout's DESIGN.md, or null when it has none. Throws on front matter that isn't YAML. */
export function readDesignMd(checkout: string): DesignSystem | null {
  const file = path.join(checkout, 'DESIGN.md')
  let mtime: number
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit?.mtime === mtime) return hit.ds
  const ds = parseDesignMd(fs.readFileSync(file, 'utf8'), file)
  cache.set(file, { mtime, ds })
  return ds
}

export function parseDesignMd(text: string, file: string): DesignSystem {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  let front: Record<string, unknown> = {}
  if (m) {
    try {
      front = (parse(m[1]) as Record<string, unknown>) ?? {}
    } catch (e) {
      throw new Error(`DESIGN.md front matter isn't valid YAML: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  const resolve = (v: unknown, depth = 0): unknown => {
    const ref = typeof v === 'string' && v.match(/^\{([\w.-]+)\}$/)
    if (!ref || depth > 8) return v
    let cur: unknown = front
    for (const key of ref[1].split('.')) cur = (cur as Record<string, unknown> | undefined)?.[key]
    return resolve(cur, depth + 1)
  }
  const group = <T>(name: string) => {
    const g = front[name]
    if (!g || typeof g !== 'object') return {} as Record<string, T>
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, (typeof v === 'object' && v ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, resolve(b)])) : resolve(v)) as T]))
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
export function px(v: unknown): number | null {
  if (typeof v === 'number') return v
  const m = String(v ?? '').trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/)
  if (!m) return null
  return parseFloat(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1)
}
