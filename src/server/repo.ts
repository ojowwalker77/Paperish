import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Doc, JsonValue, PNode, RepoState } from '../shared/types'
import { ASSETS_DIR } from './config'
import { fileStatus, showFile } from './git'

// Design files. Every document is a `.paperish` file in its project's
// design/ folder, so designs are versioned next to the code that implements
// them. The file is the source of truth: edits autosave into it, and outside
// changes (git checkout, pull, a teammate's edit) reload the document.
//
// The format is JSON written deterministically so git diffs stay small and
// readable: nodes in tree order, one style per line, no timestamps. Images and
// font files referenced as /media/<hash> are copied into `assets/` beside the
// file; names are content hashes, so files in one folder share them.

export const EXT = '.paperish'

const ASSET_DIR = 'assets'

const FORMAT = 1

// ---- format ----------------------------------------------------------------------

/** Field order inside a node; id is the key and parent is implied by children. */
const NODE_KEYS = [
  'type',
  'name',
  'tag',
  'text',
  'src',
  'svg',
  'component',
  'props',
  'content',
  'attrs',
  'hidden',
  'locked',
  'children',
  'styles',
] as const

type NodeFieldValue = PNode[(typeof NODE_KEYS)[number]]

type RepoDoc = Pick<
  Doc,
  'name' | 'pages' | 'nodes' | 'tokens' | 'comments' | 'fontFaces' | 'project' | 'seq'
>

interface RepoFileData {
  paperish?: unknown
  name?: unknown
  codebase?: unknown
  seq?: unknown
  pages?: unknown
  nodes?: unknown
  tokens?: unknown
  comments?: unknown
  fontFaces?: unknown
}

interface Serialized {
  /** Everything before the node entries. */
  head: string
  nodes: NodeEntry[]
}

interface NodeEntry {
  id: string
  text: string
  assets: string[]
}

function serializeDoc(doc: Doc, file: string): Serialized {
  const head = stringify({
    paperish: FORMAT,
    name: doc.name,
    codebase: doc.project
      ? posix(path.relative(path.dirname(file), doc.project.root)) || '.'
      : undefined,
    seq: doc.seq,
    pages: doc.pages,
    tokens: doc.tokens,
    fontFaces: doc.fontFaces?.length ? doc.fontFaces : undefined,
    comments: doc.comments,
  })

  return {
    head: `${head.slice(0, -2)},\n  "nodes": `,
    nodes: treeOrder(doc).map((id) => nodeEntry(id, doc.nodes[id])),
  }
}

/** The file's text in pieces, so a big design is never built into one huge string. */
function* fileChunks({ head, nodes }: Serialized): Generator<string> {
  if (!nodes.length) {
    yield `${head}{}\n}\n`

    return
  }

  yield `${head}{\n`

  for (let i = 0; i < nodes.length; i += 2000) {
    const part = nodes
      .slice(i, i + 2000)
      .map((e) => e.text)
      .join(',\n')

    yield i + 2000 < nodes.length ? `${part},\n` : `${part}\n  }\n}\n`
  }
}

/** Each node's serialized entry and the assets it uses, kept per node object: a save only re-serializes what changed. */
const serialized = new WeakMap<PNode, NodeEntry>()

function nodeEntry(id: string, n: PNode) {
  let e = serialized.get(n)

  if (e?.id !== id) {
    const text = `    ${JSON.stringify(id)}: ${stringify(nodeFields(n), '    ')}`
    serialized.set(n, (e = { id, text, assets: assetNames(text) }))
  }

  return e
}

function sameFile(a: Serialized, b: Serialized) {
  return (
    a.head === b.head &&
    a.nodes.length === b.nodes.length &&
    a.nodes.every((e, i) => e === b.nodes[i])
  )
}

function assetsOf({ head, nodes }: Serialized) {
  const names = new Set(assetNames(head))

  for (const e of nodes) for (const a of e.assets) names.add(a)

  return [...names]
}

export function parseRepoFile(text: string, file: string): RepoDoc {
  let raw: RepoFileData

  try {
    raw = JSON.parse(text)
  } catch (e) {
    const conflict = /^(<{7}|={7}|>{7})( |$)/m.test(text)
    // SAFETY: JSON.parse throws a SyntaxError (an Error) for invalid JSON.
    throw new Error(
      conflict
        ? `${path.basename(file)} has unresolved merge conflicts`
        : `${path.basename(file)} isn't valid JSON (${(e as Error).message})`,
      { cause: e },
    )
  }

  if (
    !raw ||
    Array.isArray(raw) ||
    Object.prototype.toString.call(raw) !== '[object Object]' ||
    !isNumberValue(raw.paperish)
  ) {
    throw new Error(`${path.basename(file)} is not a Paperish file`)
  }

  if (raw.paperish > FORMAT)
    throw new Error(
      `${path.basename(file)} was saved by a newer Paperish (format ${raw.paperish}); update Paperish to open it`,
    )

  const nodes: Record<string, PNode> = {}

  // SAFETY: node entries are normalized with Array.isArray/?? defaults for children and styles below.
  for (const [id, n] of Object.entries((raw.nodes ?? {}) as Record<string, Partial<PNode>>)) {
    // SAFETY: the spread keeps the entry's known fields; id, parent, children and styles are set explicitly.
    nodes[id] = {
      ...n,
      id,
      parent: null,
      children: Array.isArray(n.children) ? n.children : [],
      styles: n.styles ?? {},
    } as PNode
  }

  for (const n of Object.values(nodes)) {
    n.children = n.children.filter((c) => nodes[c])

    for (const c of n.children) nodes[c].parent = n.id
  }

  // SAFETY: every page is filtered to one whose rootId exists in nodes.
  const pages = ((raw.pages ?? []) as Doc['pages']).filter((p) => nodes[p.rootId])

  if (!pages.length) throw new Error(`${path.basename(file)} has no pages`)

  // Never mint an id that's already taken, even if seq was merged badly.
  let seq = Number(raw.seq) || 0

  for (const id of Object.keys(nodes).concat(pages.map((p) => p.id))) {
    const v = parseInt(id.slice(1), 36)

    if (Number.isFinite(v) && v > seq) seq = v
  }

  let project: Doc['project']

  if (isStringValue(raw.codebase)) {
    const root = path.resolve(path.dirname(file), raw.codebase)

    if (fs.existsSync(path.join(root, 'package.json'))) project = { root }
  }

  return {
    name: isStringValue(raw.name) && raw.name ? raw.name : path.basename(file, EXT),
    pages,
    nodes,
    // SAFETY: Array.isArray narrows to an array; token/comment/font-face entries follow the written file format.
    tokens: Array.isArray(raw.tokens) ? (raw.tokens as Doc['tokens']) : [],
    // SAFETY: Array.isArray narrows to an array; comment entries follow the written file format.
    comments: Array.isArray(raw.comments) ? (raw.comments as Doc['comments']) : [],
    // SAFETY: Array.isArray narrows to an array; font-face entries follow the written file format.
    fontFaces: Array.isArray(raw.fontFaces) ? (raw.fontFaces as Doc['fontFaces']) : undefined,
    project,
    seq,
  }
}

/** Page roots first, then each subtree depth-first, so a node's lines sit next to its siblings'. */
function treeOrder(doc: Doc): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const walk = (id: string) => {
    const n = doc.nodes[id]

    if (!n || seen.has(id)) return
    seen.add(id)
    out.push(id)

    for (const c of n.children) walk(c)
  }

  for (const p of doc.pages) walk(p.rootId)

  const orphans = Object.keys(doc.nodes).filter((id) => !seen.has(id))

  for (const id of orphans.toSorted()) walk(id) // orphans are kept, not lost

  return out
}

function nodeFields(n: PNode) {
  const out: Record<string, NodeFieldValue> = {}

  for (const k of NODE_KEYS) {
    const v = n[k]

    if (v === undefined || v === null || v === false) continue

    if (k === 'children' && !n.children.length) continue

    if (k === 'styles' && !Object.keys(n.styles).length) continue
    out[k] = v
  }

  return out
}

/** A subtree's content without its position on the canvas; equal signatures render the same. */
export function subtreeSignature(doc: Pick<Doc, 'nodes'>, id: string): string {
  const parts: unknown[] = []

  const walk = (nid: string, top: boolean) => {
    const n = doc.nodes[nid]

    if (!n) return
    const fields = nodeFields(n)

    if (top) {
      const { left: _l, top: _t, ...styles } = n.styles
      fields.styles = styles
    }

    parts.push(fields)

    for (const c of n.children) walk(c, false)
  }

  walk(id, true)

  return JSON.stringify(parts)
}

/**
 * JSON with a stable layout: objects one key per line, arrays of primitives
 * inline, and small flat objects inside arrays (pages, tokens) on one line.
 */
function stringify(v: StringifyInput, indent = '', inArray = false): string {
  if (!isJsonContainer(v)) return JSON.stringify(v) ?? 'null'
  const next = indent + '  '

  if (Array.isArray(v)) {
    if (!v.length) return '[]'

    if (v.every(isPrimitive)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`

    return `[\n${v.map((x) => next + stringify(x, next, true)).join(',\n')}\n${indent}]`
  }

  const entries = Object.entries(v).filter(([, x]) => x !== undefined)

  if (!entries.length) return '{}'

  if (inArray && entries.every(([, x]) => isPrimitive(x)))
    return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')} }`

  return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${stringify(x, next)}`).join(',\n')}\n${indent}}`
}

const isPrimitive = (x: JsonValue): boolean =>
  x === null || (Object.prototype.toString.call(x) !== '[object Object]' && !Array.isArray(x))

const posix = (p: string) => p.split(path.sep).join('/')

function isStringValue(v: unknown): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

function isNumberValue(v: unknown): v is number {
  return Object.prototype.toString.call(v) === '[object Number]'
}

type StringifyInput = {} | null | undefined

function isJsonContainer(v: StringifyInput): v is Record<string, JsonValue> | JsonValue[] {
  return v !== null && (Array.isArray(v) || Object.prototype.toString.call(v) === '[object Object]')
}

// ---- assets ----------------------------------------------------------------------

const MEDIA_RE = /\/media\/([a-f0-9]{8,64}\.[a-z0-9]{2,5})/g

function assetNames(text: string): string[] {
  return [...new Set([...text.matchAll(MEDIA_RE)].map((m) => m[1]))]
}

/** Copy the assets a file references from data/assets into <dir>/assets. */
function exportAssets(names: string[], dir: string) {
  if (!names.length) return
  const out = path.join(dir, ASSET_DIR)
  fs.mkdirSync(out, { recursive: true })

  for (const name of names) {
    const src = path.join(ASSETS_DIR, name)
    const dst = path.join(out, name)

    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst)
  }
}

/**
 * Bring a file's assets into data/assets (e.g. after a fresh clone): from
 * <dir>/assets on disk, or from a commit when the file comes out of history.
 */
export async function importAssets(
  text: string,
  dir: string,
  fromGit?: { root: string; sha: string; relDir: string },
) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true })

  for (const name of assetNames(text)) {
    const dst = path.join(ASSETS_DIR, name)

    if (fs.existsSync(dst)) continue
    const local = path.join(dir, ASSET_DIR, name)

    if (fs.existsSync(local)) fs.copyFileSync(local, dst)
    else if (fromGit) {
      const buf = await showFile(
        fromGit.root,
        fromGit.sha,
        path.posix.join(fromGit.relDir, ASSET_DIR, name),
      )

      if (buf) fs.writeFileSync(dst, buf)
    }
  }
}

// ---- paths -----------------------------------------------------------------------

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'design'
  )
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'Pods',
  'DerivedData',
])

/** .paperish files under a folder (bounded, skipping dependencies and build output). */
export function findRepoFiles(
  root: string,
  limit = 200,
): { path: string; rel: string; mtime: string }[] {
  const out: { path: string; rel: string; mtime: string }[] = []

  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= limit) return
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      if (out.length >= limit) return
      const p = path.join(dir, e.name)

      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(p, depth + 1)
      } else if (e.isFile() && e.name.endsWith(EXT)) {
        out.push({
          path: p,
          rel: posix(path.relative(root, p)),
          mtime: fs.statSync(p).mtime.toISOString(),
        })
      }
    }
  }

  walk(root, 0)

  return out.toSorted((a, b) => a.rel.localeCompare(b.rel))
}

// ---- sync ------------------------------------------------------------------------

interface SyncHooks {
  /** The file changed on disk (checkout, pull, another editor). */
  onExternalChange(text: string): void
  onState(state: RepoState): void
  onError(message: string): void
}

/** Keeps one document and its .paperish file in step, and tracks the file's git status. */
export class RepoSync {
  state: RepoState
  /** Text last read from the file, so reading the same text again doesn't reload the document. */
  private last: string | null
  /** What we last wrote, so a save that changes nothing is skipped. */
  private wrote: Serialized | null = null
  /** The file's mtime and size after our last write, so the watcher skips our own writes without reading them. */
  written: { mtimeMs: number; size: number } | null = null
  /** Set while the file on disk can't be read (e.g. merge conflicts): saving would overwrite it. */
  private blocked: string | null = null
  private watchers: fs.FSWatcher[] = []
  private watchingFile = false
  private checkTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    readonly file: string,
    lastText: string | null,
    private hooks: SyncHooks,
  ) {
    this.last = lastText
    this.state = {
      path: file,
      rel: path.basename(file),
      root: null,
      branch: null,
      state: 'unversioned',
    }
    this.watch()
    this.refreshStatus()
  }

  /** Write the document if its serialization changed. */
  write(doc: Doc) {
    if (this.closed || this.blocked) return
    const out = serializeDoc(doc, this.file)

    if (this.wrote && sameFile(out, this.wrote)) return
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    exportAssets(assetsOf(out), dir)
    const tmp = path.join(dir, `.${path.basename(this.file)}.tmp`)
    const fd = fs.openSync(tmp, 'w')

    try {
      for (const chunk of fileChunks(out)) fs.writeSync(fd, chunk)
    } finally {
      fs.closeSync(fd)
    }

    fs.renameSync(tmp, this.file)
    this.wrote = out
    this.written = fs.statSync(this.file)
    this.last = null

    if (!this.watchingFile) this.watch() // the folder may not have existed until now
    this.scheduleStatus()
  }

  get isBlocked() {
    return this.blocked
  }

  /** Stop writing until the file on disk parses again (the watcher lifts it). */
  block(reason: string) {
    this.blocked = reason
    this.scheduleStatus()
  }

  refreshStatus(): Promise<void> {
    return fileStatus(this.file).then(
      (s) => {
        if (this.closed) return
        const next: RepoState = { path: this.file, ...s }

        if (this.blocked) next.problem = this.blocked

        const changed = JSON.stringify(next) !== JSON.stringify(this.state)
        this.state = next

        if (changed) this.hooks.onState(next)

        if (s.root && !this.watchingGit) this.watchGit(s.root)
      },
      () => {},
    )
  }

  private scheduleStatus() {
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => this.refreshStatus(), 250)
  }

  // Watch the folder, not the file: git and editors replace files by rename,
  // which silently ends a watch on the file itself.
  private watch() {
    const dir = path.dirname(this.file)
    const base = path.basename(this.file)

    if (!fs.existsSync(dir)) return
    this.watchingFile = true

    try {
      const w = fs.watch(dir, (_ev, name) => {
        if (name && String(name) !== base) return

        if (this.checkTimer) clearTimeout(this.checkTimer)
        this.checkTimer = setTimeout(() => this.check(), 120)
      })

      w.on('error', () => {})
      this.watchers.push(w)
    } catch {}
  }

  /** Commits, stages and checkouts change the status without touching the file. */
  private watchingGit = false
  private watchGit(root: string) {
    this.watchingGit = true
    execFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: root }, (err, out) => {
      if (err || this.closed) return

      try {
        const w = fs.watch(out.trim(), (_ev, name) => {
          if (name === 'index' || name === 'HEAD') this.scheduleStatus()
        })

        w.on('error', () => {})
        this.watchers.push(w)
      } catch {}
    })
  }

  private check() {
    if (this.closed) return
    let text: string

    try {
      const st = fs.statSync(this.file)

      if (st.mtimeMs === this.written?.mtimeMs && st.size === this.written.size && !this.blocked)
        return this.scheduleStatus()
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return this.scheduleStatus() // deleted or mid-rename; the next save recreates it
    }

    if (text === this.last && !this.blocked) return this.scheduleStatus()

    try {
      parseRepoFile(text, this.file)
    } catch (e) {
      // SAFETY: parseRepoFile throws Error instances for invalid files.
      if (this.blocked !== (e as Error).message) {
        // SAFETY: parseRepoFile throws Error instances for invalid files.
        this.blocked = (e as Error).message
        // SAFETY: parseRepoFile throws Error instances for invalid files.
        this.hooks.onError(
          `${(e as Error).message}. Paperish stopped saving to it until the file is fixed.`,
        )
      }

      return this.scheduleStatus()
    }

    this.blocked = null
    this.last = text
    this.hooks.onExternalChange(text)
    this.scheduleStatus()
  }

  close() {
    this.closed = true

    for (const w of this.watchers) w.close()

    if (this.checkTimer) clearTimeout(this.checkTimer)

    if (this.statusTimer) clearTimeout(this.statusTimer)
  }
}
