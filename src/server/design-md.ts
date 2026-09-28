import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { JsonValue } from '../shared/types'

// A repo's DESIGN.md (https://github.com/google-labs-code/design.md): YAML
// front matter with tokens, and prose whose "Do's and Don'ts" become rules.

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
