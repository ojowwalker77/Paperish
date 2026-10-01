import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { CheckoutInfo, FileSummary, JsonValue, ProjectInfo } from '../shared/types'
import { ORIGIN, PROJECTS_FILE, SCRATCH_DIR } from './config'
import { repoRoot, worktrees } from './git'
import { EXT, findRepoFiles, parseRepoFile } from './repo'

// A project is a folder whose design/ holds .paperish files: a repo the user
// added, or the built-in Scratch. The app remembers only the list of project
// folders; everything else lives in the project. design/paperish.json holds
// the project's id, committed with the repo, so the .mcp.json that points an
// agent at /mcp/<id> works for every clone of it.
//
// A repo has checkouts: its main one and any git worktrees (where agents
// mostly work). Each checkout has its own design/ folder, so a file is a
// project, a checkout and a path inside it.

export const DESIGN_DIR = 'design'

const MARKER = 'paperish.json'

const SCRATCH_ID = 'scratch'

export interface Project {
  id: string
  name: string
  root: string
  scratch: boolean
}

export interface Checkout {
  path: string
  branch: string | null
  main: boolean
}

interface Entry {
  root: string
  openedAt: string
}

/** Stable id for a .paperish file: its path, hashed. */
export const fileIdFor = (file: string) =>
  createHash('sha1').update(file).digest('hex').slice(0, 10)

/** A checkout's design folder (a project's root is its main checkout). */
export const designDir = (checkout: string) => path.join(checkout, DESIGN_DIR)

const mcpUrl = (id: string) => `${ORIGIN}/mcp/${id}`

/** Where an agent's MCP client says it's working (a checkout, or a folder inside one). */
const DIR_HEADER = 'X-Paperish-Dir'

export class Projects {
  private entries: Entry[] = []
  private byRoot = new Map<string, Project>()
  private summaries = new Map<string, { mtime: number; summary: FileSummary }>()
  private checkoutCache = new Map<string, { at: number; list: Checkout[] }>()
  readonly scratch: Project

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'))

      if (Array.isArray(raw.projects))
        this.entries = raw.projects.filter((e: Entry) => isStringValue(e?.root))
    } catch {}

    this.scratch = { id: SCRATCH_ID, name: 'Scratch', root: SCRATCH_DIR, scratch: true }
    fs.mkdirSync(designDir(this.scratch.root), { recursive: true })

    for (const e of this.entries) {
      const p = this.load(e.root)

      if (p) this.byRoot.set(p.root, p)
    }
  }

  /** Projects, Scratch first, then most recently opened. */
  all(): Project[] {
    const repos = this.entries.map((e) => this.byRoot.get(e.root)).filter((p): p is Project => !!p)

    return [this.scratch, ...repos]
  }

  get(id: string): Project {
    if (id === SCRATCH_ID) return this.scratch
    // Two clones of one repo share an id; the one opened last wins.
    const p = this.all().find((x) => x.id === id)

    if (!p)
      throw new Error(`Unknown project "${id}". Open its repo in Paperish first (Add project…).`)

    return p
  }

  /** The project's checkouts, main first (git worktree list, briefly cached). */
  async checkouts(p: Project, fresh = false): Promise<Checkout[]> {
    const hit = this.checkoutCache.get(p.id + p.root)

    if (hit && !fresh && Date.now() - hit.at < 3000) return hit.list
    const found = p.scratch ? [] : await worktrees(p.root)

    const list = found.length
      ? found.map(({ path: checkoutPath, branch, main }) => ({ path: checkoutPath, branch, main }))
      : [{ path: p.root, branch: null, main: true }]

    this.checkoutCache.set(p.id + p.root, { at: Date.now(), list })

    return list
  }

  /** Last known checkouts, without asking git. */
  knownCheckouts(p: Project): Checkout[] {
    return (
      this.checkoutCache.get(p.id + p.root)?.list ?? [{ path: p.root, branch: null, main: true }]
    )
  }

  /** The project and checkout a path (a .paperish file, or a working directory) is inside, from what's known. */
  locateSync(file: string): { project: Project; checkout: Checkout } | undefined {
    let best: { project: Project; checkout: Checkout } | undefined

    for (const project of this.all())
      for (const checkout of this.knownCheckouts(project))
        if (
          (file === checkout.path || file.startsWith(checkout.path + path.sep)) &&
          (!best || checkout.path.length > best.checkout.path.length)
        )
          best = { project, checkout }

    return best
  }

  /** Like locateSync, but asks git first, so a worktree made a moment ago is found. */
  async locate(file: string): Promise<{ project: Project; checkout: Checkout } | undefined> {
    await Promise.all(this.all().map((p) => this.checkouts(p, true)))

    return this.locateSync(file)
  }

  async checkoutInfos(p: Project): Promise<CheckoutInfo[]> {
    return (await this.checkouts(p)).map((c) =>
      Object.assign({}, c, { fileCount: this.files(p, c.path).length }),
    )
  }

  /**
   * Add a folder as a project (its git root when it's inside a repo): creates
   * design/ with the id marker and registers the MCP endpoint in .mcp.json.
   */
  async add(input: string): Promise<Project> {
    const dir = path.resolve(input)

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new Error(`Folder not found: ${dir}`)
    // A worktree adds its repo: the project's root is the main checkout.
    const top = await repoRoot(dir)
    const root = top ? ((await worktrees(top))[0]?.path ?? top) : dir

    if (root === SCRATCH_DIR) return this.scratch
    const p = this.load(root, true)!
    this.byRoot.set(root, p)
    this.touch(p)
    writeMcpConfig(p)

    return p
  }

  remove(id: string) {
    const p = this.get(id)

    if (p.scratch) throw new Error('Scratch is always there.')
    this.entries = this.entries.filter((e) => e.root !== p.root)
    this.byRoot.delete(p.root)
    this.save()
  }

  /** Move a project to the top of the list. */
  touch(p: Project) {
    if (p.scratch || this.entries[0]?.root === p.root) return
    this.entries = [
      { root: p.root, openedAt: new Date().toISOString() },
      ...this.entries.filter((e) => e.root !== p.root),
    ]
    this.save()
  }

  /** A checkout's .paperish files, most recently changed first. */
  files(p: Project, checkout = p.root): FileSummary[] {
    const out: FileSummary[] = []

    for (const { path: file } of findRepoFiles(designDir(checkout))) {
      const s = this.summary(file, p, checkout)

      if (s) out.push(s)
    }

    return out.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  info(p: Project): ProjectInfo {
    const files = this.files(p)
    const opened = this.entries.find((e) => e.root === p.root)?.openedAt

    return {
      id: p.id,
      name: p.name,
      root: p.root,
      scratch: p.scratch,
      fileCount: files.length,
      updatedAt: [files[0]?.updatedAt, opened].filter(Boolean).toSorted().pop() ?? '',
      mcp: mcpUrl(p.id),
    }
  }

  private summary(file: string, p: Project, checkout: string): FileSummary | null {
    let mtime: number

    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      return null
    }

    const hit = this.summaries.get(file)

    if (hit && hit.mtime === mtime) return hit.summary
    let name = path.basename(file, EXT)
    let pageCount = 0
    let nodeCount = 0

    try {
      const doc = parseRepoFile(fs.readFileSync(file, 'utf8'), file)
      name = doc.name
      pageCount = doc.pages.length
      nodeCount = Object.keys(doc.nodes).length - doc.pages.length
    } catch {}

    const summary: FileSummary = {
      id: fileIdFor(file),
      name,
      updatedAt: new Date(mtime).toISOString(),
      pageCount,
      nodeCount,
      source: file,
      projectId: p.id,
      checkout,
    }

    this.summaries.set(file, { mtime, summary })

    return summary
  }

  /** Read (or, with `create`, set up) a project folder. Missing folders are skipped, not forgotten. */
  private load(root: string, create = false): Project | null {
    if (!create && !fs.existsSync(root)) return null
    const dir = path.join(root, DESIGN_DIR)
    const marker = path.join(dir, MARKER)
    let id: string | undefined

    try {
      id = JSON.parse(fs.readFileSync(marker, 'utf8')).id
    } catch {}

    if (!isStringValue(id) || !/^[a-z0-9-]{4,40}$/.test(id)) {
      if (!create) return { id: fileIdFor(root), name: path.basename(root), root, scratch: false }
      id = randomBytes(5).toString('hex')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(marker, JSON.stringify({ id }, null, 2) + '\n')
    }

    return { id, name: repoName(root), root, scratch: false }
  }

  private save() {
    fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true })
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects: this.entries }, null, 2) + '\n')
  }
}

function readMarker(checkout: string): Record<string, JsonValue> {
  try {
    return JSON.parse(fs.readFileSync(path.join(designDir(checkout), MARKER), 'utf8'))
  } catch {
    return {}
  }
}

/** The checkout's DESIGN.md, relative to it: the one paperish.json points at, else the root's. */
export function designMdPath(checkout: string): string {
  const rel = readMarker(checkout).designMd

  return isStringValue(rel) && rel ? rel : 'DESIGN.md'
}

/** A Tailwind v4 stylesheet whose @theme supplies the tokens, relative to the checkout (paperish.json "tokens"). */
export function tokensPath(checkout: string): string | null {
  const rel = readMarker(checkout).tokens

  return isStringValue(rel) && rel ? rel : null
}

/** Point the project at a DESIGN.md outside the root (saved in paperish.json, so it's shared). */
export function setDesignMdPath(checkout: string, file: string) {
  const rel = path.relative(checkout, file)

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`Pick a file inside ${checkout}.`)
  const marker = { ...readMarker(checkout), designMd: rel.split(path.sep).join('/') }
  fs.mkdirSync(designDir(checkout), { recursive: true })
  fs.writeFileSync(path.join(designDir(checkout), MARKER), JSON.stringify(marker, null, 2) + '\n')
}

function repoName(root: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name

    if (isStringValue(name) && name) return name.replace(/^@[^/]+\//, '')
  } catch {}

  return path.basename(root)
}

function isStringValue(v: JsonValue | undefined): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

interface McpConfig {
  mcpServers?: Record<string, JsonValue>
}

/** Point the repo's .mcp.json (Claude Code's project config) at this project's endpoint, leaving everything else alone. */
function writeMcpConfig(p: Project) {
  const file = path.join(p.root, '.mcp.json')
  let config: McpConfig = {}

  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return console.warn(`[paperish] ${file} isn't valid JSON; not adding the paperish server`)
    }
  }

  // The header tells Paperish which checkout the agent was started in (Claude Code expands ${PWD}).
  const entry = { type: 'http', url: mcpUrl(p.id), headers: { [DIR_HEADER]: '${PWD:-}' } }

  // SAFETY: paperish entries written by writeMcpConfig always have url and headers objects.
  const current = config.mcpServers?.paperish as
    | { url?: string; headers?: Record<string, string> }
    | undefined

  if (current?.url === entry.url && current.headers?.[DIR_HEADER]) return
  config.mcpServers = { ...config.mcpServers, paperish: { ...current, ...entry } }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}
