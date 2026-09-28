import { useCallback, useRef, useSyncExternalStore } from 'react'
import { applyOps } from '../shared/ops'
import type {
  CheckoutInfo,
  ClientMsg,
  Doc,
  FileSummary,
  Op,
  PNode,
  Page,
  ProjectInfo,
  ProjectState,
  ProjectView,
  RepoState,
  ServerMsg,
  TaskState,
} from '../shared/types'

export interface Camera {
  x: number
  y: number
  zoom: number
}

type Listener = () => void

export type Tool = 'move' | 'frame' | 'text' | 'hand'

export type PreviewMode = 'fit' | 'actual' | 'responsive'

interface DevicePrefs {
  /** null = full window width. */
  id: string | null
  /** Index into the device's screens (e.g. folded / open). */
  screen: number
  chrome: 'app' | 'safari'
  /** Chosen finish index per device id. */
  finish: Record<string, number>
}

const params = new URLSearchParams(location.search)

export const ENGINE_MODE = params.get('engine') === '1'

/** Standalone preview tab: ?file=<id>&view=<nodeId>. */
export const VIEW_NODE = params.get('view')

class Store {
  doc: Doc | null = null
  version = 0
  pageId = ''
  /** Files of the open file's project. */
  files: FileSummary[] = []
  /** The project the open file belongs to. */
  projectInfo: ProjectInfo | null = null
  /** The checkout (main or a git worktree) or branch the editor shows. */
  view: ProjectView | null = null
  checkouts: CheckoutInfo[] = []
  /** Branches without a checkout, viewable as committed. */
  branches: string[] = []
  /** An agent is working in another checkout than the one shown. */
  agentElsewhere: { checkout: string; branch: string | null } | null = null
  /** All projects, for the home screen (shown while no file is open). */
  projects: ProjectInfo[] = []
  home = false
  working: string[] = []
  connected = false
  lastAgentActivity = 0

  // editor-only UI state
  selection: string[] = []
  hover: string | null = null
  editingText: string | null = null
  tool: Tool = 'move'
  preview: string | null = null
  tasks: TaskState[] = []
  /** The linked codebase (its components and Tailwind theme). */
  project: ProjectState | null = null
  /** The .paperish file this document saves into, and its git status. */
  repo: RepoState | null = null
  changesOpen = false
  importOpen = false
  helpOpen = false
  private myTokens = new Set<string>()
  previewMode: PreviewMode = loadPreviewMode()
  previewDevice: DevicePrefs = loadDevicePrefs()
  camera: Camera = { x: 80, y: 80, zoom: 0.5 }
  expanded = new Set<string>()
  error: string | null = null

  // Three channels so hot paths stay cheap: the camera changes on every wheel
  // event and only a handful of things draw from it; each rendered node only
  // cares about its own object; everything else listens to the general one.
  private listeners = new Set<Listener>()
  private cameraListeners = new Set<Listener>()
  private nodeListeners = new Map<string, Set<Listener>>()
  private versionWaiters: { v: number; resolve: () => void }[] = []
  private ws: WebSocket | null = null
  private queue: ClientMsg[] = []
  private pendingCreated: ((ids: string[]) => void)[] = []
  onReveal: ((ids: string[]) => void) | null = null

  subscribe = (l: Listener) => {
    this.listeners.add(l)

    return () => this.listeners.delete(l)
  }

  emit() {
    for (const l of this.listeners) l()
  }

  subscribeCamera = (l: Listener) => {
    this.cameraListeners.add(l)

    return () => {
      this.cameraListeners.delete(l)
    }
  }

  subscribeNode(id: string, l: Listener) {
    let set = this.nodeListeners.get(id)

    if (!set) this.nodeListeners.set(id, (set = new Set()))
    set.add(l)

    return () => {
      set.delete(l)

      if (!set.size) this.nodeListeners.delete(id)
    }
  }

  private notifyNode(id: string | null | undefined) {
    if (id) for (const l of this.nodeListeners.get(id) ?? []) l()
  }

  /** Tell node views whose object changed (structural sharing makes this an identity check). */
  private notifyNodes(prev: Record<string, PNode> | undefined) {
    const next = this.doc?.nodes

    if (prev === next) return

    for (const [id, ls] of this.nodeListeners)
      if (prev?.[id] !== next?.[id]) for (const l of ls) l()
  }

  setEditingText(id: string | null) {
    if (this.editingText === id) return
    const prev = this.editingText
    this.editingText = id
    this.notifyNode(prev)
    this.notifyNode(id)
  }

  get page(): Page | undefined {
    return this.doc?.pages.find((p) => p.id === this.pageId) ?? this.doc?.pages[0]
  }

  node(id: string | null | undefined): PNode | undefined {
    return id ? this.doc?.nodes[id] : undefined
  }

  // ---- connection -------------------------------------------------------------

  connect(fileId: string | null) {
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    )

    this.ws = ws
    ws.addEventListener('open', () => {
      this.connected = true
      ws.send(
        JSON.stringify({
          t: 'hello',
          fileId: fileId ?? this.doc?.id,
          role: ENGINE_MODE ? 'engine' : 'editor',
        } satisfies ClientMsg),
      )

      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m))
      this.emit()
    })

    ws.addEventListener('message', (e) => {
      // SAFETY: server only sends ServerMsg JSON on this socket; parsed at this message boundary.
      return this.receive(JSON.parse(e.data) as ServerMsg)
    })
    ws.addEventListener('close', () => {
      this.connected = false
      this.emit()
      setTimeout(() => this.connect(this.doc?.id ?? (this.home ? null : fileId)), 800)
    })
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
    else this.queue.push(msg)
  }

  tx(ops: Op[], label?: string) {
    if (ops.length) this.send({ t: 'tx', ops, label })
  }

  /** Send a command whose reply is the ids the server created. */
  command(msg: Extract<ClientMsg, { t: 'insertHtml' | 'duplicate' }>): Promise<string[]> {
    return new Promise((resolve) => {
      this.pendingCreated.push(resolve)
      this.send(msg)
    })
  }

  private receive(msg: ServerMsg) {
    const prevNodes = this.doc?.nodes

    switch (msg.t) {
      case 'doc': {
        const switched = this.doc?.id !== msg.doc.id
        this.home = false
        this.doc = msg.doc
        this.version = msg.version
        this.pageId = msg.pageId

        if (switched) {
          this.selection = []
          this.hover = null
          this.repo = null
          this.changesOpen = false
          this.setEditingText(null)

          if (!ENGINE_MODE && !VIEW_NODE) {
            history.replaceState(null, '', `?file=${msg.doc.id}`)
            this.restoreCamera()
          }
        } else {
          // Reloaded in place (e.g. its .paperish file changed on disk).
          this.selection = this.selection.filter((id) => msg.doc.nodes[id])

          if (this.hover && !msg.doc.nodes[this.hover]) this.hover = null

          if (this.editingText && !msg.doc.nodes[this.editingText]) this.setEditingText(null)
        }

        break
      }

      case 'ops': {
        if (!this.doc) return
        this.doc = applyOps(this.doc, msg.ops).doc
        this.version = msg.version

        if (msg.origin === 'agent') this.lastAgentActivity = Date.now()

        if (!this.doc.pages.some((p) => p.id === this.pageId))
          this.pageId = this.doc.pages[0]?.id ?? ''
        this.selection = this.selection.filter((id) => this.doc!.nodes[id])

        if (!this.doc.project) this.project = null

        if (this.hover && !this.doc.nodes[this.hover]) this.hover = null

        if (this.editingText && !this.doc.nodes[this.editingText]) this.setEditingText(null)
        break
      }

      case 'working':
        this.working = msg.ids
        break
      case 'files':
        this.files = msg.files
        this.projectInfo = msg.project
        this.view = msg.view
        this.checkouts = msg.checkouts
        this.branches = msg.branches

        if (msg.view.kind === 'checkout' && this.agentElsewhere?.checkout === msg.view.path)
          this.agentElsewhere = null
        break
      case 'agentElsewhere':
        this.agentElsewhere = { checkout: msg.checkout, branch: msg.branch }
        break
      case 'projects':
        this.projects = msg.projects
        break
      case 'closed':
        this.doc = null
        this.home = true
        this.selection = []
        this.hover = null
        this.repo = null
        this.project = null
        this.projectInfo = null
        this.view = null
        this.checkouts = []
        this.branches = []
        this.agentElsewhere = null
        this.files = []
        this.preview = null
        this.changesOpen = false
        this.setEditingText(null)

        if (!ENGINE_MODE && !VIEW_NODE) history.replaceState(null, '', location.pathname)
        break
      case 'page':
        if (this.pageId !== msg.pageId) {
          this.pageId = msg.pageId
          this.selection = []
        }

        break
      case 'reveal':
        queueMicrotask(() => this.onReveal?.(msg.ids))
        break
      case 'created':
        this.pendingCreated.shift()?.(msg.ids)
        break
      case 'project':
        this.project = msg.project
        break
      case 'repo':
        this.repo = msg.repo
        break
      case 'task': {
        const t = msg.task
        this.tasks = [...this.tasks.filter((x) => x.id !== t.id), t]

        if (t.status !== 'running') {
          if (t.status === 'done' && t.origin && this.myTokens.has(t.origin) && t.ids?.length)
            queueMicrotask(() => this.select(t.ids!))
          setTimeout(
            () => {
              this.tasks = this.tasks.filter((x) => x.id !== t.id)
              this.emit()
            },
            t.status === 'error' ? 8000 : 5000,
          )
        }

        break
      }

      case 'error':
        this.error = msg.message
        setTimeout(() => {
          this.error = null
          this.emit()
        }, 4000)
        break
    }

    this.notifyNodes(prevNodes)
    this.flushWaiters()
    this.emit()
  }

  waitForVersion(v: number): Promise<void> {
    if (this.version >= v) return Promise.resolve()

    return new Promise((resolve) => this.versionWaiters.push({ v, resolve }))
  }

  private flushWaiters() {
    this.versionWaiters = this.versionWaiters.filter((w) => {
      if (this.version >= w.v) {
        w.resolve()

        return false
      }

      return true
    })
  }

  // ---- UI state ---------------------------------------------------------------

  select(ids: string[]) {
    this.selection = ids
    this.setEditingText(null)

    if (this.doc) this.send({ t: 'selection', pageId: this.pageId, ids })

    // reveal selection in the layer tree
    for (const id of ids) {
      let cur = this.doc?.nodes[id]?.parent

      while (cur) {
        this.expanded.add(cur)
        cur = this.doc?.nodes[cur]?.parent ?? null
      }
    }

    this.emit()
  }

  setHover(id: string | null) {
    if (this.hover === id) return
    this.hover = id
    this.emit()
  }

  /** Applied synchronously (listeners write the DOM), so reads right after see it. */
  setCamera(c: Camera) {
    this.camera = c

    for (const l of this.cameraListeners) l()
    this.saveCamera()
  }

  /** The inspector, shown on demand (I) for the selection. */
  inspectOpen = false
  /** The command palette (⌘K), and what it opens with. */
  palette: { query: string } | null = null

  setPreview(id: string | null) {
    this.preview = id
    this.emit()
  }

  setPreviewDevice(patch: Partial<DevicePrefs>) {
    this.previewDevice = { ...this.previewDevice, ...patch }

    try {
      localStorage.setItem('paperish:previewDevice', JSON.stringify(this.previewDevice))
    } catch {}

    this.emit()
  }

  setPreviewMode(mode: PreviewMode) {
    this.previewMode = mode

    try {
      localStorage.setItem('paperish:previewMode', mode)
    } catch {}

    this.emit()
  }

  importUrl(url: string, width: number) {
    const token = Math.random().toString(36).slice(2)
    this.myTokens.add(token)
    this.send({ t: 'importUrl', url, width, token })
    this.importOpen = false
    this.emit()
  }

  setInspectOpen(open: boolean) {
    this.inspectOpen = open
    this.emit()
  }

  openPalette(query = '') {
    this.palette = { query }
    this.emit()
  }

  closePalette() {
    this.palette = null
    this.emit()
  }

  setChangesOpen(open: boolean) {
    this.changesOpen = open
    this.emit()
  }

  setHelpOpen(open: boolean) {
    this.helpOpen = open
    this.emit()
  }

  setImportOpen(open: boolean) {
    this.importOpen = open
    this.emit()
  }

  setTool(tool: Tool) {
    this.tool = tool
    this.emit()
  }

  setPage(pageId: string) {
    this.pageId = pageId
    this.selection = []
    this.send({ t: 'page', pageId })
    this.emit()
  }

  private cameraTimer = 0
  private saveCamera() {
    clearTimeout(this.cameraTimer)
    this.cameraTimer = window.setTimeout(() => {
      try {
        if (this.doc)
          localStorage.setItem(
            `paperish:camera:${this.doc.id}:${this.pageId}`,
            JSON.stringify(this.camera),
          )
      } catch {}
    }, 300)
  }

  restoreCamera() {
    try {
      const raw = this.doc && localStorage.getItem(`paperish:camera:${this.doc.id}:${this.pageId}`)

      if (raw) this.setCamera(JSON.parse(raw))
      else this.needsFit = true
    } catch {
      this.needsFit = true
    }
  }

  needsFit = false
}

function loadPreviewMode(): PreviewMode {
  const fromUrl = params.get('mode')

  if (fromUrl === 'fit' || fromUrl === 'actual' || fromUrl === 'responsive') return fromUrl

  try {
    const saved = localStorage.getItem('paperish:previewMode')

    if (saved === 'fit' || saved === 'actual' || saved === 'responsive') return saved
  } catch {}

  return 'fit'
}

function loadDevicePrefs(): DevicePrefs {
  let prefs: DevicePrefs = { id: null, screen: 0, chrome: 'app', finish: {} }

  try {
    const saved = localStorage.getItem('paperish:previewDevice')

    if (saved) prefs = { ...prefs, ...JSON.parse(saved) }
  } catch {}

  if (params.has('device')) prefs.id = params.get('device') || null

  if (params.has('screen')) prefs.screen = Number(params.get('screen')) || 0

  if (params.get('chrome') === 'safari' || params.get('chrome') === 'app') {
    // SAFETY: checked just above to be 'safari' or 'app', the only DevicePrefs chrome values.
    prefs.chrome = params.get('chrome') as DevicePrefs['chrome']
  }

  return prefs
}

export const store = new Store()

declare global {
  interface Window {
    __store: Store
  }
}

// Exposed for debugging and scripts/perf.ts.
window.__store = store

/**
 * Subscribe to a slice of the store. Pass `equal` when the selector builds a
 * new object each time (e.g. `shallow`), so unrelated changes don't re-render.
 */
export function useStore<T>(selector: (s: Store) => T, equal?: (a: T, b: T) => boolean): T {
  const last = useRef<{ v: T } | null>(null)

  return useSyncExternalStore(store.subscribe, () => {
    const next = selector(store)

    if (equal && last.current && equal(last.current.v, next)) return last.current.v
    last.current = { v: next }

    return next
  })
}

export function shallow<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Camera-derived value; keep the selector coarse (e.g. rounded zoom) to avoid renders. */
export function useCamera<T>(selector: (c: Camera) => T): T {
  return useSyncExternalStore(store.subscribeCamera, () => selector(store.camera))
}

/** One node, re-rendering only when that node's object changes. */
export function useNode(id: string): PNode | undefined {
  const sub = useCallback((l: Listener) => store.subscribeNode(id, l), [id])

  return useSyncExternalStore(sub, () => store.doc?.nodes[id])
}

/** Whether this node's text is being edited, on the same per-node channel. */
export function useEditingText(id: string): boolean {
  const sub = useCallback((l: Listener) => store.subscribeNode(id, l), [id])

  return useSyncExternalStore(sub, () => store.editingText === id)
}

export type { Store }
