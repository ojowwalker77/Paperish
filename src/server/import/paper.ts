import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { TOKEN_TYPES, type PNode, type TokenType } from '../../shared/types'
import { extFor, storeBuffer } from '../assets'
import { htmlToNodes } from '../commands'
import type { ImportResult, Progress } from '../importer'
import { ARTBOARD_GAP } from '../placement'
import type { ImportJob } from '../tasks'
import type { OpenFile } from '../workspace'

const PAPER_MCP = 'http://127.0.0.1:29979/mcp'

const MAX_ASSETS = 250

const MAX_ASSET_BYTES = 12 * 1024 * 1024

const paperNodeObject = z.object({
  id: z.string(),
  name: z.string().optional(),
  width: z.number().optional(),
  worldX: z.number().optional(),
  worldY: z.number().optional(),
})

const paperNode = z.union([
  z.string().transform((id): z.infer<typeof paperNodeObject> => ({ id })),
  paperNodeObject,
])

const nodeList = (key: string) =>
  z
    .union([z.array(paperNode), z.object({ [key]: z.array(paperNode) }).transform((o) => o[key])])
    .catch([])

const tokenList = z
  .array(
    z
      .object({
        name: z.string().regex(/^--[a-zA-Z0-9_-]+$/),
        type: z.enum(
          // SAFETY: TOKEN_TYPES is a non-empty tuple of token type names.
          TOKEN_TYPES as [TokenType, ...TokenType[]],
        ),
        value: z.union([z.string(), z.number()]),
        description: z.string().optional(),
      })
      .nullable()
      .catch(null),
  )
  .transform((list) => list.filter((t) => t !== null))
  .catch([])

export function paperJob(f: OpenFile, nodeIds?: string[]): ImportJob {
  return { label: 'Paper', run: (progress) => importPaper(f, nodeIds ?? [], progress) }
}

async function importPaper(
  f: OpenFile,
  nodeIds: string[],
  progress: Progress,
): Promise<ImportResult> {
  const t0 = Date.now()
  progress('Connecting', 5)
  const client = new Client({ name: 'paperish', version: '1' })

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(PAPER_MCP)))
  } catch {
    throw new Error(
      'Could not reach Paper. Open the file in Paper Desktop, which serves its MCP on 127.0.0.1:29979.',
    )
  }

  try {
    const artboards = await callJson(client, 'get_basic_info', nodeList('artboards'))
    const selected = await callJson(client, 'get_selection', nodeList('selection'))

    const targets = nodeIds.length
      ? nodeIds.map((id) => artboards.find((a) => a.id === id) ?? { id })
      : selected.length
        ? selected
        : artboards

    if (!targets.length) throw new Error('The open Paper page has no artboards.')

    const nodes: PNode[] = []
    const warnings = new Set<string>()
    let x = 0

    for (const [i, t] of targets.entries()) {
      progress(`Reading ${t.name ?? t.id}`, 10 + Math.round((60 * i) / targets.length))
      const jsx = await callText(client, 'get_jsx', { nodeId: t.id, format: 'inline-styles' })
      const parsed = await htmlToNodes(f, jsxToHtml(jsx), t.width ?? 1440)
      const sub = parsed.subtrees[0]

      for (const w of parsed.warnings) warnings.add(w)

      if (!sub) continue
      const top = sub[0]

      if (t.name) top.name = t.name
      top.styles = {
        ...top.styles,
        left: `${t.worldX ?? x}px`,
        top: `${t.worldY ?? 0}px`,
      }
      x += (t.width ?? (parseFloat(String(top.styles.width)) || 0)) + ARTBOARD_GAP
      nodes.push(...sub)
    }

    if (!nodes.length) throw new Error('Paper returned no layers for the selected nodes.')

    progress('Downloading images', 75)
    const images = await downloadImages(nodes, warnings)

    progress('Reading tokens', 92)

    const tokens = await callJson(client, 'get_tokens', tokenList, { format: 'json' }).catch(
      () => [],
    )

    return {
      nodes,
      fontFaces: [],
      tokens,
      title: 'Paper',
      stats: {
        layers: nodes.length,
        images: images.ok,
        imagesFailed: images.failed,
        fonts: 0,
        ms: Date.now() - t0,
      },
      warnings: [...warnings],
    }
  } finally {
    await client.close()
  }
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, string> = {},
): Promise<string> {
  // SAFETY: MCP tool results carry a content array of typed items.
  const res = (await client.callTool({ name, arguments: args }, { timeout: 60_000 })) as {
    content: { type: string; text?: string }[]
    isError?: boolean
  }

  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')

  if (res.isError) throw new Error(`Paper ${name}: ${text.split('\n')[0]}`)

  return text
}

async function callJson<T>(
  client: Client,
  name: string,
  schema: z.ZodType<T>,
  args: Record<string, string> = {},
): Promise<T> {
  const text = await callText(client, name, args)

  try {
    return schema.parse(JSON.parse(text))
  } catch {
    throw new Error(`Paper ${name} returned something Paperish can't read.`)
  }
}

async function downloadImages(nodes: PNode[], warnings: Set<string>) {
  const urls = new Set<string>()

  for (const n of nodes) {
    if (n.type === 'Image' && n.src && /^https?:/.test(n.src)) urls.add(n.src)

    for (const v of Object.values(n.styles))
      for (const m of String(v).matchAll(/url\(\s*(['"]?)(https?:.*?)\1\s*\)/g)) urls.add(m[2])
  }

  const list = [...urls].slice(0, MAX_ASSETS)

  if (urls.size > MAX_ASSETS)
    warnings.add(`Only the first ${MAX_ASSETS} images were downloaded; the rest stay remote.`)
  const map = new Map<string, string>()
  let next = 0

  const worker = async () => {
    while (next < list.length) {
      const u = list[next++]

      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15_000) })
        const body = res.ok ? Buffer.from(await res.arrayBuffer()) : null
        const ext = extFor(res.headers.get('content-type') ?? undefined, u)

        if (body && ext && body.length <= MAX_ASSET_BYTES) map.set(u, storeBuffer(body, ext))
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: 8 }, worker))

  for (const n of nodes) {
    if (n.type === 'Image' && n.src && map.has(n.src)) n.src = map.get(n.src)

    for (const [k, v] of Object.entries(n.styles))
      if (String(v).includes('url('))
        n.styles[k] = String(v).replace(
          /url\(\s*(['"]?)(https?:.*?)\1\s*\)/g,
          (m, q: string, u: string) => (map.has(u) ? `url(${q}${map.get(u)}${q})` : m),
        )
  }

  return { ok: map.size, failed: urls.size - map.size }
}

const UNITLESS = new Set([
  'aspectRatio',
  'columnCount',
  'fillOpacity',
  'flex',
  'flexGrow',
  'flexShrink',
  'fontWeight',
  'gridColumn',
  'gridRow',
  'lineHeight',
  'opacity',
  'order',
  'scale',
  'strokeOpacity',
  'strokeWidth',
  'zIndex',
  'zoom',
])

const RENAMED = new Map([
  ['className', 'class'],
  ['htmlFor', 'for'],
  ['xlinkHref', 'xlink:href'],
])

function jsxToHtml(jsx: string): string {
  const src = jsx.slice(jsx.indexOf('<'), jsx.lastIndexOf('>') + 1).replace(/<\/?>/g, '')
  let out = ''
  let inTag = false
  let i = 0

  while (i < src.length) {
    const ch = src[i]

    if (ch === '{') {
      const end = closingBrace(src, i)
      const expr = src.slice(i + 1, end).trim()

      if (inTag) {
        const attr = out.match(/([\w:-]+)=$/)?.[1]
        const value = attr === 'style' && expr.startsWith('{') ? styleCss(expr) : literal(expr)
        out = value === null ? out.replace(/\s*[\w:-]+=$/, '') : `${out}"${escapeAttr(value)}"`
      } else out += escapeText(literal(expr) ?? '').replace(/\n/g, '<br>')
      i = end + 1
      continue
    }

    if (inTag && (ch === '"' || ch === "'")) {
      const end = src.indexOf(ch, i + 1)
      out += src.slice(i, end + 1)
      i = end + 1
      continue
    }

    if (ch === '<') inTag = true
    else if (ch === '>') inTag = false
    out += ch
    i++
  }

  return out.replace(/<[^<>]+>/g, (tag) =>
    tag.replace(/(\s)([a-z]+[A-Z][A-Za-z]*)(?==)/g, (_m, sp: string, name: string) => {
      const renamed = RENAMED.get(name)

      if (renamed) return sp + renamed

      return /^(stroke|fill|clip|stop|font|text|dominant|flood|marker|letter|word|color|shape|vector|paint|lighting|alignment)[A-Z]/.test(
        name,
      )
        ? sp + kebab(name)
        : sp + name
    }),
  )
}

function closingBrace(s: string, start: number): number {
  let depth = 0

  for (let i = start; i < s.length; i++) {
    const ch = s[i]

    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === '\\') i++
    } else if (ch === '/' && s[i + 1] === '*') i = s.indexOf('*/', i + 2) + 1 || s.length
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }

  return s.length
}

function literal(expr: string): string | null {
  if (/^-?\d+(\.\d+)?$/.test(expr)) return expr

  if (expr === 'true') return ''
  const q = expr[0]

  if (
    !`"'\``.includes(q) ||
    expr.length < 2 ||
    !expr.endsWith(q) ||
    (q === '`' && expr.includes('${'))
  )
    return null

  return expr
    .slice(1, -1)
    .replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_m, c: string) =>
      c.length > 1
        ? String.fromCharCode(parseInt(c.slice(1), 16))
        : c === 'n'
          ? '\n'
          : c === 't'
            ? '\t'
            : c,
    )
}

function styleCss(expr: string): string {
  const re =
    /\s*(?:([A-Za-z_$][\w$]*)|"([^"]*)"|'([^']*)')\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?[\d.]+)\s*,?/y

  const body = expr.slice(1, -1)
  const decls: string[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(body))) {
    const key = m[1] ?? m[2] ?? m[3]
    const raw = literal(m[4])

    if (raw === null) continue
    const value = /^-?[\d.]+$/.test(m[4]) && !UNITLESS.has(key) && raw !== '0' ? `${raw}px` : raw
    decls.push(`${key.startsWith('--') ? key : kebab(key)}: ${value}`)
  }

  return decls.join('; ')
}

function kebab(name: string): string {
  return name.replace(/^ms(?=[A-Z])/, '-ms').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
