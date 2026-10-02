import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { applyOps, artboardOf } from '../shared/ops'
import type { Doc, FileSummary, Op, PNode, Page, ProjectInfo, ServerMsg } from '../shared/types'
import { engine } from './engine'
import { call } from './host'
import { branches, commitDate, listTree, resolveRev, showFile } from './git'
import { ensureProject, projectState } from './project'
import { DESIGN_DIR, designDir, fileIdFor, Projects, type Project } from './projects'
import { EXT, importAssets, parseRepoFile, RepoSync, slugify } from './repo'

export type Origin = 'user' | 'agent' | 'system'

interface FileSelection {
  pageId: string
  ids: string[]
}

interface Tx {
  ops: Op[]
  inverse: Op[]
  origin: Origin
  label?: string
}

export interface Client {
  ws: WebSocket
  role: 'editor' | 'engine'
  fileId: string | null
  /** Switch this connection to another file (sends it the new snapshot). */
  open?: (fileId: string) => void
  /** Send this connection to the home screen. */
  home?: () => void
}

const UNDO_LIMIT = 200

export class OpenFile {
  version = 0
  undoStack: Tx[] = []
  redoStack: Tx[] = []
  working = new Set<string>()
  selection: FileSelection = { pageId: '', ids: [] }
  pageId: string
  /** Keeps the document and its .paperish file (doc.source) in step. */
  repo: RepoSync | null = null
  /** An old version opened for comparison or viewing: never saved, never listed. */
  ephemeral = false
  /** Set for a branch viewed as committed: edits are refused. */
  ref: { branch: string; rel: string } | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private savedName: string
  private dirty = false
  private deleted = false

  constructor(
    public doc: Doc,
    private ws: Workspace,
    readonly projectId: string,
    /** The checkout (main or a git worktree) the file lives in; null for a branch viewed as committed. */
    readonly checkout: string | null,
  ) {
    this.pageId = doc.pages[0]?.id ?? ''
    this.savedName = doc.name
  }

  /** Start syncing with doc.source; `lastText` is what the file holds now, if it was just read. */
  attachRepo(lastText: string | null) {
    this.repo?.close()
    this.repo = new RepoSync(this.doc.source, lastText, {
      onExternalChange: (text) => this.reloadFrom(text),
      onState: (repo) => this.broadcast({ t: 'repo', repo }),
      onError: (message) => this.broadcast({ t: 'error', message }),
    })
  }

  /** Replace the document with the file's new contents (a checkout, pull or outside edit). */
  private reloadFrom(text: string) {
    const file = this.doc.source
    let parsed: ReturnType<typeof parseRepoFile>

    try {
      parsed = parseRepoFile(text, file)
    } catch (e) {
      // SAFETY: parseRepoFile throws Error instances for unreadable files.
      return this.broadcast({ t: 'error', message: (e as Error).message })
    }

    const prevRoot = this.doc.project?.root
    this.doc = { ...this.doc, ...parsed, updatedAt: new Date().toISOString() }

    if (!this.doc.pages.some((p) => p.id === this.pageId)) this.pageId = this.doc.pages[0].id
    this.version += 1
    this.undoStack = []
    this.redoStack = []
    this.working.clear()
    this.broadcast(this.snapshot())
    this.broadcastWorking()
    void importAssets(text, path.dirname(file)).catch(() => {})
    const root = this.doc.project?.root

    if (root !== prevRoot) {
      this.broadcast({ t: 'project', project: root ? (projectState(root) ?? null) : null })

      if (root) ensureProject(root).catch(() => {})
    }

    this.ws.filesChanged(this.projectId)
  }

  get page(): Page {
    return this.doc.pages.find((p) => p.id === this.pageId) ?? this.doc.pages[0]
  }

  mint(prefix = 'N'): string {
    this.doc.seq += 1

    return prefix + this.doc.seq.toString(36).toUpperCase()
  }

  node(id: string): PNode {
    if (id === 'root') return this.doc.nodes[this.page.rootId]
    const n = this.doc.nodes[id]

    if (!n) throw new Error(`Node "${id}" does not exist`)

    return n
  }

  resolveId(id: string): string {
    return id === 'root' ? this.page.rootId : id
  }

  /** Apply ops as one undoable transaction and broadcast them. */
  transact(ops: Op[], origin: Origin, label?: string): number {
    if (this.ref)
      throw new Error(
        `Read-only: this is ${this.ref.branch} as committed. Switch to a checkout to edit.`,
      )

    if (!ops.length) return this.version
    const { doc, inverse } = applyOps(this.doc, ops)
    this.doc = { ...doc, updatedAt: new Date().toISOString() }
    this.version += 1
    this.undoStack.push({ ops, inverse, origin, label })

    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()
    this.redoStack = []

    if (origin === 'agent') {
      this.markWorking(ops)
      this.ws.agentWorked(this)
    }

    this.broadcast({ t: 'ops', ops, version: this.version, origin })
    this.scheduleSave()

    return this.version
  }

  /** Comments are conversation, not design: they bypass undo so undoing an edit never drops one. */
  setComments(comments: Doc['comments'], origin: Origin) {
    if (this.ref)
      throw new Error(
        `Read-only: this is ${this.ref.branch} as committed. Switch to a checkout to comment.`,
      )

    const ops: Op[] = [{ t: 'comments', comments }]
    this.doc = { ...applyOps(this.doc, ops).doc, updatedAt: new Date().toISOString() }
    this.version += 1
    this.broadcast({ t: 'ops', ops, version: this.version, origin })
    this.scheduleSave()
  }

  undo() {
    const tx = this.undoStack.pop()

    if (!tx) return
    const { doc, inverse } = applyOps(this.doc, tx.inverse)
    this.doc = doc
    this.version += 1
    this.redoStack.push({ ops: tx.inverse, inverse, origin: tx.origin, label: tx.label })
    this.broadcast({ t: 'ops', ops: tx.inverse, version: this.version, origin: 'user' })
    this.scheduleSave()
  }

  redo() {
    const tx = this.redoStack.pop()

    if (!tx) return
    const { doc, inverse } = applyOps(this.doc, tx.inverse)
    this.doc = doc
    this.version += 1
    this.undoStack.push({ ops: tx.inverse, inverse, origin: tx.origin, label: tx.label })
    this.broadcast({ t: 'ops', ops: tx.inverse, version: this.version, origin: 'user' })
    this.scheduleSave()
  }

  private markWorking(ops: Op[]) {
    const before = this.working.size

    const touch = (id: string) => {
      const ab = artboardOf(this.doc.nodes, id)

      if (ab) this.working.add(ab.id)
    }

    for (const op of ops) {
      if (op.t === 'insert') touch(op.nodes[0]?.id ?? op.parentId)
      else if (op.t === 'styles' || op.t === 'patch' || op.t === 'move') touch(op.id)
    }

    for (const id of this.working) if (!this.doc.nodes[id]) this.working.delete(id)

    if (this.working.size !== before) this.broadcastWorking()
  }

  finishWorking(ids?: string[]) {
    if (!ids || !ids.length) this.working.clear()
    else for (const id of ids) this.working.delete(id)
    this.broadcastWorking()
  }

  broadcastWorking() {
    this.broadcast({ t: 'working', ids: [...this.working] })
  }

  setPage(pageId: string) {
    if (!this.doc.pages.some((p) => p.id === pageId))
      throw new Error(`Page "${pageId}" does not exist`)
    this.pageId = pageId
    this.broadcast({ t: 'page', pageId })
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg)

    for (const c of this.ws.clients)
      if (c.fileId === this.doc.id && c.ws.readyState === 1) c.ws.send(data)
  }

  snapshot(): ServerMsg {
    return { t: 'doc', doc: this.doc, version: this.version, pageId: this.pageId }
  }

  scheduleSave() {
    if (this.ephemeral) return
    this.dirty = true

    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 400)
  }

  /** Write pending changes (no-op when nothing changed since the last save). */
  flush() {
    if (this.dirty) this.saveNow()
  }

  /** Stop saving: the file was deleted. */
  discard() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.deleted = true
    this.repo?.close()
    this.repo = null
  }

  /** Write pending changes into the .paperish file. */
  saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null

    if (this.deleted || this.ephemeral || !this.repo) return
    this.dirty = false
    const prevName = this.savedName

    try {
      this.repo.write(this.doc)
      this.savedName = this.doc.name

      if (this.repo.written)
        this.ws.projects.saved(this.repo.file, this.repo.written.mtimeMs, this.doc)
    } catch (e) {
      // SAFETY: RepoSync.write throws Error instances for filesystem failures.
      this.broadcast({
        t: 'error',
        message: `Couldn’t save ${path.basename(this.repo.file)}: ${(e as Error).message}`,
      })
    }

    if (prevName !== this.doc.name) this.ws.filesChanged(this.projectId)
    else this.ws.broadcastProjects()
  }
}

export class Workspace {
  clients = new Set<Client>()
  readonly projects = new Projects()
  private open = new Map<string, OpenFile>()
  /** File id → its .paperish path and checkout, filled as checkouts are listed. */
  private paths = new Map<string, { file: string; projectId: string; checkout: string }>()
  /** Keys of open snapshots (old versions, branches), least recently used first. */
  private snapshots: string[] = []
  /** Last file used in each checkout: the target of MCP calls that omit fileId. */
  private lastFile = new Map<string, string>()
  /** Where agents last worked in each project, and when (the editor opens a project there). */
  private agentAt = new Map<string, { checkout: string; at: number }>()
  private agentNotified = new Map<string, number>()

  project(id: string): Project {
    return this.projects.get(id)
  }

  projectInfos(): ProjectInfo[] {
    return this.projects.all().map((p) => this.projects.info(p))
  }

  listFiles(projectId: string, checkout = this.project(projectId).root): FileSummary[] {
    const files = this.projects.files(this.project(projectId), checkout)

    for (const f of files) this.paths.set(f.id, { file: f.source, projectId, checkout })

    return files
  }

  /** The editor's view of a file's project: the checkout (or branch) it's in, its files, the other checkouts and branches. */
  async filesMsg(f: OpenFile): Promise<ServerMsg> {
    const p = this.project(f.projectId)
    const checkouts = await this.projects.checkoutInfos(p)
    const taken = new Set(checkouts.map((c) => c.branch))

    const others = p.scratch
      ? []
      : (await branches(p.root)).map((b) => b.name).filter((b) => !taken.has(b))

    if (f.ref) {
      return {
        t: 'files',
        files: await this.branchFiles(p, f.ref.branch),
        project: this.projects.info(p),
        view: { kind: 'branch', branch: f.ref.branch },
        checkouts,
        branches: others,
      }
    }

    const here = checkouts.find((c) => c.path === f.checkout) ?? {
      path: f.checkout!,
      branch: null,
      main: true,
    }

    return {
      t: 'files',
      files: this.listFiles(p.id, here.path),
      project: this.projects.info(p),
      view: { kind: 'checkout', path: here.path, branch: here.branch, main: here.main },
      checkouts,
      branches: others,
    }
  }

  /** Tell editors in a project that its files changed. */
  filesChanged(projectId: string) {
    for (const c of this.clients) {
      if (c.role !== 'editor' || c.ws.readyState !== 1 || !c.fileId) continue
      const f = this.open.get(c.fileId)

      if (f?.projectId !== projectId) continue
      void this.filesMsg(f).then((m) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(m)))
    }

    this.broadcastProjects()
  }

  broadcastProjects() {
    const home = [...this.clients].filter(
      (c) => c.role === 'editor' && !c.fileId && c.ws.readyState === 1,
    )

    if (!home.length) return

    const data = JSON.stringify({
      t: 'projects',
      projects: this.projectInfos(),
    } satisfies ServerMsg)

    for (const c of home) c.ws.send(data)
  }

  /** An agent changed a file: remember the checkout (the editor opens there next), and tell editors looking at another one. */
  agentWorked(f: OpenFile) {
    if (!f.checkout) return
    this.agentAt.set(f.projectId, { checkout: f.checkout, at: Date.now() })
    const last = this.agentNotified.get(f.doc.id) ?? 0

    if (Date.now() - last < 5000) return
    this.agentNotified.set(f.doc.id, Date.now())

    const branch =
      this.projects.knownCheckouts(this.project(f.projectId)).find((c) => c.path === f.checkout)
        ?.branch ?? null

    const data = JSON.stringify({
      t: 'agentElsewhere',
      checkout: f.checkout,
      branch,
      fileId: f.doc.id,
    } satisfies ServerMsg)

    for (const c of this.clients) {
      if (c.role !== 'editor' || c.ws.readyState !== 1 || !c.fileId) continue
      const other = this.open.get(c.fileId)

      if (other?.projectId === f.projectId && other.checkout !== f.checkout) c.ws.send(data)
    }
  }

  private pathOf(id: string) {
    if (!this.paths.has(id))
      for (const p of this.projects.all())
        for (const c of this.projects.knownCheckouts(p)) this.listFiles(p.id, c.path)

    return this.paths.get(id)
  }

  has(id: string) {
    id = parseFileId(id)

    return this.open.has(id) || !!this.pathOf(id)
  }

  get(id: string): OpenFile {
    id = parseFileId(id)
    const open = this.open.get(id)

    if (open) return open
    const where = this.pathOf(id)

    if (!where || !fs.existsSync(where.file))
      throw new Error(`File "${id}" not found. Use list_files to see available files.`)

    return this.load(where.file, this.project(where.projectId), where.checkout)
  }

  /** Open a .paperish file by path (it must be in a project's checkout; a new worktree is picked up). */
  async openPath(file: string): Promise<OpenFile> {
    file = path.resolve(file)
    const id = fileIdFor(file)

    if (this.open.has(id)) return this.open.get(id)!
    const at = await this.projects.locate(file)

    if (!at || !file.startsWith(designDir(at.checkout.path) + path.sep))
      throw new Error(
        `${file} isn't in the design/ folder of a project. Add its repo in Paperish first.`,
      )

    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
    this.paths.set(id, { file, projectId: at.project.id, checkout: at.checkout.path })

    return this.load(file, at.project, at.checkout.path)
  }

  private load(file: string, p: Project, checkout: string): OpenFile {
    const id = fileIdFor(file)
    const text = fs.readFileSync(file, 'utf8')
    const parsed = parseRepoFile(text, file)
    const mtime = fs.statSync(file).mtime.toISOString()
    const doc: Doc = { id, createdAt: mtime, updatedAt: mtime, ...parsed, source: file }

    // The checkout's own code is the codebase unless the file names another one.
    if (!doc.project && !p.scratch && fs.existsSync(path.join(checkout, 'package.json')))
      doc.project = { root: checkout }
    void importAssets(text, path.dirname(file)).catch(() => {})
    const f = new OpenFile(doc, this, p.id, checkout)
    this.open.set(id, f)
    f.attachRepo(text)

    return f
  }

  /** Make a file its checkout's current one (what calls in that checkout without a fileId act on). */
  setActive(f: OpenFile) {
    if (!f.checkout) return
    this.lastFile.set(f.checkout, f.doc.id)
    this.projects.touch(this.project(f.projectId))
  }

  /**
   * The checkout a call without a fileId acts on: the one containing `dir`
   * (where the agent works), or the only one. With several checkouts and no
   * directory it refuses rather than guess: two agents in different
   * worktrees must never land in each other's files.
   */
  checkoutFor(projectId: string, dir?: string): string {
    const p = this.project(projectId)

    if (dir) {
      const hit = this.projects.locateSync(path.resolve(dir))

      if (hit?.project.id !== projectId)
        throw new Error(`${dir} isn't inside a checkout of ${p.name}.`)

      return hit.checkout.path
    }

    const known = this.projects.knownCheckouts(p)

    if (known.length === 1) return known[0].path
    throw new Error(
      `${p.name} has ${known.length} checkouts (${known.map((c) => c.branch ?? c.path).join(', ')}), so say which: pass the fileId of a file in yours (open_file with the .paperish path under your working directory returns it), or cwd.`,
    )
  }

  /** The checkout the editor opens a project on: where an agent worked last, else the one with the newest design. */
  async defaultCheckout(projectId: string): Promise<string> {
    const p = this.project(projectId)
    const list = await this.projects.checkouts(p)
    const agent = this.agentAt.get(projectId)?.checkout

    if (agent && list.some((c) => c.path === agent)) return agent
    let best = p.root
    let newest = ''

    for (const c of list) {
      const t = this.listFiles(p.id, c.path)[0]?.updatedAt ?? ''

      if (t > newest) {
        newest = t
        best = c.path
      }
    }

    return best
  }

  /** A checkout's last-used file, else its newest, else a new one. */
  fileIn(projectId: string, checkout: string, rel?: string): OpenFile {
    if (rel) {
      const file = path.join(checkout, rel)
      const hit = this.listFiles(projectId, checkout).find((x) => x.source === file)

      if (hit) return this.get(hit.id)
    }

    const last = this.lastFile.get(checkout)

    if (last && this.has(last)) return this.get(last)
    const recent = this.listFiles(projectId, checkout)[0]
    const f = recent ? this.get(recent.id) : this.create(projectId, undefined, undefined, checkout)
    this.lastFile.set(checkout, f.doc.id)

    return f
  }

  /** A new file in a checkout's design/ folder (optionally a copy of another document). */
  create(projectId: string, name?: string, clone?: Doc, checkout?: string): OpenFile {
    const p = this.project(projectId)
    const dir = checkout ?? p.root
    name = name?.trim() || (clone ? `${clone.name} copy` : p.scratch ? 'Untitled' : p.name)
    const file = freePath(designDir(dir), slugify(name))
    const now = new Date().toISOString()
    const id = fileIdFor(file)

    const doc: Doc = clone
      ? { ...structuredClone(clone), id, name, createdAt: now, updatedAt: now, source: file }
      : {
          id,
          name,
          createdAt: now,
          updatedAt: now,
          pages: [],
          nodes: {},
          tokens: [],
          comments: [],
          seq: 0,
          source: file,
        }

    if (!clone && !p.scratch && fs.existsSync(path.join(dir, 'package.json')))
      doc.project = { root: dir }
    const f = new OpenFile(doc, this, p.id, dir)

    if (!clone) {
      const { page, root } = newPage(f, 'Page 1')
      f.doc.pages.push(page)
      f.doc.nodes[root.id] = root
      f.pageId = page.id
    }

    this.open.set(id, f)
    this.paths.set(id, { file, projectId: p.id, checkout: dir })
    f.attachRepo(null)
    f.saveNow()
    this.filesChanged(p.id)

    return f
  }

  /** A branch's design files as committed. */
  private async branchFiles(p: Project, branch: string): Promise<FileSummary[]> {
    const date = await commitDate(p.root, branch)
    const rels = (await listTree(p.root, branch, DESIGN_DIR)).filter((r) => r.endsWith(EXT))

    return rels.map((rel) => ({
      id: branchKey(p.id, branch, rel),
      name: path.basename(rel, EXT),
      updatedAt: date,
      pageCount: 0,
      nodeCount: 0,
      source: path.join(p.root, rel),
      projectId: p.id,
      ref: { branch, rel },
    }))
  }

  /** Open a file of a branch as committed, read-only (by path in the branch, else its first design file). */
  async openBranch(projectId: string, branch: string, rel?: string): Promise<OpenFile> {
    const p = this.project(projectId)
    const sha = await resolveRev(p.root, branch)
    const files = await this.branchFiles(p, branch)
    const pick = files.find((f) => f.ref!.rel === rel) ?? files[0]

    if (!pick) throw new Error(`${branch} has no design files committed.`)
    const r = pick.ref!
    const buf = await showFile(p.root, sha, r.rel)

    if (!buf) throw new Error(`${r.rel} isn't in ${branch}.`)
    const text = buf.toString('utf8')
    const abs = path.join(p.root, r.rel)
    const parsed = parseRepoFile(text, abs)
    await importAssets(text, path.dirname(abs), {
      root: p.root,
      sha,
      relDir: path.posix.dirname(r.rel),
    })
    const key = branchKey(p.id, branch, r.rel)
    this.open.delete(key) // the branch may have moved on

    const f = this.snapshot(key, p.id, null, () => ({
      id: key,
      createdAt: '',
      updatedAt: '',
      ...parsed,
      source: abs,
    }))

    f.ref = { branch, rel: r.rel }

    return f
  }

  /**
   * Open a document read-only under `key` (an old version out of git history,
   * or a branch) so the layout engine can render it. The few most recent stay open.
   */
  snapshot(key: string, projectId: string, checkout: string | null, make: () => Doc): OpenFile {
    const existing = this.open.get(key)
    this.snapshots = this.snapshots.filter((k) => k !== key)
    this.snapshots.push(key)

    if (existing) return existing
    const f = new OpenFile({ ...make(), id: key }, this, projectId, checkout)
    f.ephemeral = true
    this.open.set(key, f)

    while (this.snapshots.length > 8) {
      const old = this.snapshots.shift()!
      this.open.delete(old)
      void engine.forget(old)
    }

    return f
  }

  flushAll() {
    for (const f of this.open.values()) f.flush()
  }

  /** Delete a file: its .paperish goes to the system trash. */
  async remove(id: string) {
    id = parseFileId(id)
    const where = this.pathOf(id)

    if (!where) throw new Error(`File "${id}" not found.`)
    const f = this.open.get(id)

    if (f) {
      f.discard()
      this.open.delete(id)
    }

    for (const key of this.snapshots.filter((k) => k.startsWith(`${id}~`))) {
      this.open.delete(key)
      void engine.forget(key)
    }

    this.snapshots = this.snapshots.filter((k) => !k.startsWith(`${id}~`))

    if (fs.existsSync(where.file)) await call('trash', where.file)
    this.paths.delete(id)

    if (this.lastFile.get(where.checkout) === id) this.lastFile.delete(where.checkout)
    this.filesChanged(where.projectId)
  }
}

/** Id of a branch's file viewed as committed. */
const branchKey = (projectId: string, branch: string, rel: string) =>
  `b${fileIdFor(`${projectId}\0${branch}\0${rel}`)}`

/** <dir>/<base>.paperish, or <base>-2.paperish and so on if that's taken. */
function freePath(dir: string, base: string): string {
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${base}${i > 1 ? `-${i}` : ''}${EXT}`)

    if (!fs.existsSync(file)) return file
  }
}

export interface NewPageResult {
  page: Page
  root: PNode
}

export function newPage(f: OpenFile, name: string): NewPageResult {
  const root: PNode = {
    id: f.mint('R'),
    type: 'Root',
    name,
    tag: 'div',
    styles: {},
    parent: null,
    children: [],
  }

  return { page: { id: f.mint('P'), name, rootId: root.id }, root }
}

/** A file id, also accepted as an editor URL containing ?file=<id>. */
function parseFileId(input: string): string {
  return input.match(/[?&]file=([A-Za-z0-9_~-]+)/)?.[1] ?? input.trim()
}
