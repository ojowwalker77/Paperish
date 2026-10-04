import fs from 'node:fs/promises'
import path from 'node:path'
import { SKIP_DIRS } from './repo'

type Kind = 'fixture' | 'seed' | 'mock' | 'story' | 'sample' | 'test' | 'json'

interface Sample {
  file: string
  kind: Kind
  excerpt: string
}

interface TypeDecl {
  name: string
  file: string
  definition: string
}

interface SampleData {
  samples: Sample[]
  types: TypeDecl[]
  more: string[]
}

const DATA_EXT = /\.(json|ya?ml|csv|sql|[cm]?[jt]sx?)$/

const TS_EXT = /\.[cm]?tsx?$/

const CONFIG_JSON =
  /^(package(-lock)?|[jt]sconfig.*|composer(\.lock)?|components|vercel|netlify|turbo|nx|lerna|renovate|biome|deno|firebase|app|eas|manifest)\.json$/

const KINDS: [Kind, RegExp][] = [
  ['story', /^stories$/],
  ['fixture', /^fixtures?$/],
  ['seed', /^(seeds?|seeders?|seeding)$/],
  ['mock', /^(mocks?|fakes?|stubs?|dummy)$/],
  ['sample', /^(samples?|examples?|demos?|placeholders?|data)$/],
  ['test', /^(tests?|specs?|testdata)$/],
]

const RANK: Record<Kind, number> = {
  fixture: 4,
  seed: 4,
  mock: 3,
  story: 3,
  sample: 2,
  test: 1,
  json: 1,
}

const TYPE_DECL = /(?:interface\s+(\w+)[^{=;]*|type\s+(\w+)(?:<[^>]*>)?\s*=\s*)\{/g

const ARGS = /\bargs\s*:\s*\{/g

const MAX_FILES = 20000

const MAX_DEPTH = 10

const MAX_BYTES = 256 * 1024

const MAX_SAMPLES = 8

const MAX_TYPES = 6

const EXCERPT = 1500

const BUDGET = 12000

export async function findSampleData(root: string, query?: string): Promise<SampleData> {
  const q = query?.trim().toLowerCase() || undefined
  const found: (Sample & { score: number })[] = []
  const types: TypeDecl[] = []

  for (const p of await walk(root)) {
    const file = path.relative(root, p).split(path.sep).join('/')
    const kind = file.endsWith('.d.ts') ? null : kindOf(file)
    const wantTypes = !!q && TS_EXT.test(file) && types.length < MAX_TYPES * 4

    if (!kind && !wantTypes) continue
    const text = await read(p)

    if (text === null) continue
    const lower = text.toLowerCase()
    const inName = !!q && file.toLowerCase().includes(q)

    if (q && !inName && !lower.includes(q)) continue

    if (kind && (q || kind !== 'test'))
      found.push({
        file,
        kind,
        excerpt: excerpt(text, file, kind, q),
        score: RANK[kind] + (inName ? 3 : 0),
      })

    if (wantTypes)
      for (const b of blocks(text, TYPE_DECL))
        if (b.name.toLowerCase().includes(q))
          types.push({ name: b.name, file, definition: clip(b.text) })
  }

  found.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  types.sort((a, b) => a.name.length - b.name.length || a.file.localeCompare(b.file))
  const samples: Sample[] = []
  const more: string[] = []
  let used = 0

  for (const { score: _, ...s } of found) {
    if (samples.length < MAX_SAMPLES && used + s.excerpt.length <= BUDGET) {
      samples.push(s)
      used += s.excerpt.length
    } else if (more.length < 20) more.push(s.file)
  }

  return { samples, types: types.slice(0, MAX_TYPES), more }
}

function kindOf(file: string): Kind | null {
  if (!DATA_EXT.test(file)) return null
  const words = file.split(/[/._-]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase())

  for (const [kind, re] of KINDS) if (words.some((w) => re.test(w))) return kind
  const name = path.posix.basename(file)

  return name.endsWith('.json') && !name.startsWith('.') && !CONFIG_JSON.test(name) ? 'json' : null
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []

  const visit = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const p = path.join(dir, e.name)

      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await visit(p, depth + 1)
      } else if (e.isFile() && DATA_EXT.test(e.name)) out.push(p)
    }
  }

  await visit(root, 0)

  return out
}

async function read(file: string): Promise<string | null> {
  try {
    if ((await fs.stat(file)).size > MAX_BYTES) return null

    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

function excerpt(text: string, file: string, kind: Kind, q?: string): string {
  if (file.endsWith('.json')) {
    try {
      return clip(
        JSON.stringify(
          JSON.parse(text, (_k, v) => (Array.isArray(v) ? v.slice(0, 3) : v)),
          null,
          2,
        ),
      )
    } catch {
      return clip(text)
    }
  }

  if (kind === 'story') {
    const args = blocks(text, ARGS).map((b) => b.text)

    if (args.length) return clip(args.join('\n'))
  }

  const lines = text.split('\n')
  const at = q ? lines.findIndex((l) => l.toLowerCase().includes(q)) : -1
  const from = Math.max(0, at - 5)

  return clip(lines.slice(from, from + 40).join('\n'))
}

function blocks(text: string, re: RegExp): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []

  for (const m of text.matchAll(re)) {
    let depth = 0

    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        out.push({ name: m[1] ?? m[2] ?? '', text: text.slice(m.index, i + 1) })
        break
      }
    }
  }

  return out
}

function clip(s: string): string {
  return s.length > EXCERPT ? `${s.slice(0, EXCERPT)}\n…` : s
}
