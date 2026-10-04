import type { GetLocalVariablesResponse, LocalVariable, RGBA } from '@figma/rest-api-spec'
import { z } from 'zod'
import type { StyleValue, Token, TokenType } from '../../shared/types'

const dtcgValue = z.union([
  z.string().transform((text) => ({ kind: 'text' as const, text })),
  z.number().transform((num) => ({ kind: 'number' as const, num })),
  z.array(z.string()).transform((list) => ({ kind: 'list' as const, list })),
  z.object({ value: z.number(), unit: z.string() }).transform((d) => ({
    kind: 'dimension' as const,
    ...d,
  })),
  z
    .object({
      components: z.array(z.number()).length(3).optional(),
      alpha: z.number().optional(),
      hex: z.string().optional(),
    })
    .transform((c) => ({ kind: 'color' as const, ...c })),
])

type DtcgValue = z.infer<typeof dtcgValue>

const dtcgToken = z
  .object({
    $type: z.string().optional(),
    $value: dtcgValue,
    $description: z.string().optional(),
    $extensions: z.object({ 'com.figma.scopes': z.array(z.string()).optional() }).optional(),
  })
  .transform((t) => ({ kind: 'token' as const, ...t }))

export type DtcgEntry =
  | z.infer<typeof dtcgToken>
  | { kind: 'group'; type?: string; children: [string, DtcgEntry][] }
  | { kind: 'skip' }

export const dtcgDocument: z.ZodType<DtcgEntry> = z.lazy(() =>
  z.union([
    dtcgToken,
    z
      .object({ $type: z.string().optional() })
      .catchall(dtcgDocument)
      .transform(({ $type, ...rest }) => ({
        kind: 'group' as const,
        type: $type,
        children: Object.entries(rest),
      })),
    z.unknown().transform(() => ({ kind: 'skip' as const })),
  ]),
)

interface ScopeTypes {
  [scope: string]: TokenType
}

const SCOPE_TYPES: ScopeTypes = {
  CORNER_RADIUS: 'radius',
  GAP: 'spacing',
  WIDTH_HEIGHT: 'spacing',
  FONT_SIZE: 'fontSize',
  LINE_HEIGHT: 'lineHeight',
  LETTER_SPACING: 'letterSpacing',
  OPACITY: 'opacity',
  FONT_WEIGHT: 'fontWeight',
  FONT_FAMILY: 'fontFamily',
}

const NAME_TYPES: [RegExp, TokenType][] = [
  [/radius|rounded|corner/, 'radius'],
  [/font-?size|text-?size/, 'fontSize'],
  [/line-?height|leading/, 'lineHeight'],
  [/letter|tracking/, 'letterSpacing'],
  [/opacity|alpha/, 'opacity'],
  [/weight/, 'fontWeight'],
  [/breakpoint|screen/, 'breakpoint'],
  [/container/, 'container'],
]

function cssName(path: string[]): string {
  const slug = path
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return `--${slug}`
}

export function tokensFromDtcg(doc: DtcgEntry): Token[] {
  const out = new Map<string, Token>()

  const walk = (entry: DtcgEntry, path: string[], inherited?: string) => {
    if (entry.kind === 'group') {
      for (const [k, child] of entry.children) walk(child, [...path, k], entry.type ?? inherited)

      return
    }

    if (entry.kind === 'skip') return
    const scopes = entry.$extensions?.['com.figma.scopes'] ?? []
    const type = tokenType(path, entry.$type ?? inherited, scopes)
    const value = type && tokenValue(type, entry.$value)
    const name = cssName(path)

    if (!type || value === null || value === undefined || out.has(name)) return
    const token: Token = { name, type, value }

    if (entry.$description) token.description = entry.$description.slice(0, 1024)
    out.set(name, token)
  }

  walk(doc, [])

  return [...out.values()]
}

function tokenType(
  path: string[],
  dtcgType: string | undefined,
  scopes: string[],
): TokenType | null {
  if (dtcgType === 'color' || dtcgType === 'fontFamily' || dtcgType === 'fontWeight')
    return dtcgType

  if (dtcgType !== 'dimension' && dtcgType !== 'number') return null

  for (const s of scopes) if (SCOPE_TYPES[s]) return SCOPE_TYPES[s]
  const name = path.join('-').toLowerCase()

  return NAME_TYPES.find(([re]) => re.test(name))?.[1] ?? 'spacing'
}

function tokenValue(type: TokenType, v: DtcgValue): StyleValue | null {
  switch (v.kind) {
    case 'text': {
      const alias = v.text.match(/^\{([^}]+)\}$/)

      return alias ? `var(${cssName(alias[1].split('.'))})` : v.text
    }

    case 'list':
      return type === 'fontFamily' ? v.list.join(', ') : null

    case 'dimension':
      return `${v.value}${v.unit}`

    case 'number':
      if (type === 'fontWeight') return v.num

      if (type === 'opacity') return v.num > 1 ? v.num / 100 : v.num

      return type === 'lineHeight' && v.num <= 4 ? v.num : `${v.num}px`

    case 'color': {
      if (type !== 'color') return null
      const [r, g, b] = v.components ?? hexToRgb(v.hex ?? '')

      return r === undefined ? null : hexColor({ r, g, b, a: v.alpha ?? 1 })
    }
  }
}

function hexToRgb(hex: string): number[] {
  const h = hex.replace('#', '')

  return h.length >= 6 ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) : []
}

function hex2(v: number) {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
}

function hexColor(c: RGBA): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 0.999 ? hex2(c.a) : ''}`.toUpperCase()
}

const variableAlias = z.object({ type: z.literal('VARIABLE_ALIAS'), id: z.string() })

const variableColor = z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() })

function pathOf(v: LocalVariable) {
  return v.name.split('/').map((p) => p.trim())
}

interface DtcgOutGroup {
  [key: string]: DtcgOutGroup | DtcgOutToken
}

interface DtcgOutToken {
  $type: string
  $value: string | number | { colorSpace: string; components: number[]; alpha: number; hex: string }
  $description?: string
  $extensions: { 'com.figma.variableId': string; 'com.figma.scopes': string[] }
}

export function variablesToDtcg(res: GetLocalVariablesResponse) {
  const { variables, variableCollections } = res.meta
  const doc: DtcgOutGroup = {}
  const names = new Map<string, string>()

  for (const v of Object.values(variables)) {
    const mode = variableCollections[v.variableCollectionId]?.defaultModeId
    const raw = mode ? v.valuesByMode[mode] : Object.values(v.valuesByMode)[0]
    const alias = variableAlias.safeParse(raw)
    const rgba = variableColor.safeParse(raw)
    const num = z.number().safeParse(raw)
    const text = z.string().safeParse(raw)
    const path = pathOf(v)
    let token: DtcgOutToken | null = null
    const $extensions = { 'com.figma.variableId': v.id, 'com.figma.scopes': [...v.scopes] }

    const $type =
      v.resolvedType === 'COLOR'
        ? 'color'
        : v.resolvedType === 'FLOAT'
          ? 'number'
          : v.scopes.includes('FONT_FAMILY')
            ? 'fontFamily'
            : null

    if (!$type) continue

    if (alias.success && variables[alias.data.id])
      token = { $type, $value: `{${pathOf(variables[alias.data.id]).join('.')}}`, $extensions }
    else if (rgba.success) {
      const c = rgba.data

      token = {
        $type,
        $value: {
          colorSpace: 'srgb',
          components: [c.r, c.g, c.b],
          alpha: c.a,
          hex: hexColor({ ...c, a: 1 }),
        },
        $extensions,
      }
    } else if (num.success) token = { $type, $value: num.data, $extensions }
    else if (text.success) token = { $type, $value: text.data, $extensions }

    if (!token) continue

    if (v.description) token.$description = v.description
    let group = doc

    for (const key of path.slice(0, -1)) {
      const next = group[key]

      if (next && !('$value' in next)) group = next
      else {
        const created: DtcgOutGroup = {}
        group[key] = created
        group = created
      }
    }

    group[path[path.length - 1]] = token
    names.set(v.id, cssName(path))
  }

  return { doc, names }
}
