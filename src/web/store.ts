import { useCallback, useRef, useSyncExternalStore } from 'react'
import { applyOps, artboardOf } from '../shared/ops'
import { ensureFonts, familiesIn } from './render/fonts'
import type {
  AgentStep,
  CheckoutInfo,
  ClientMsg,
  Doc,
  FileSummary,
  LintState,
  Op,
  PNode,
  Page,
  ProjectInfo,
  Proposal,
  ProjectState,
  ProjectView,
  RepoState,
  ServerMsg,
  SettingsState,
  ThemeSetting,
  TaskState,
  UpdateState,
} from '../shared/types'

export interface Camera {
  x: number
  y: number
  zoom: number
}

type Listener = () => void

export type Tool = 'move' | 'frame' | 'text' | 'hand' | 'comment'

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
  /** Each artboard's size when last rendered, so the canvas can place the ones it doesn't render. */
  boardSizes = new Map<string, { width: number; height: number }>()
  expanded = new Set<string>()
  error: string | null = null
  settings: SettingsState | null = null
  settingsOpen = false
  /** A view's version shown alone on the canvas, picked in the navigator. */
  focus: string | null = null
  /** The navigator (⌘\\): project, files and pages over the canvas. */
  navOpen = loadFlag('paperish:navOpen', true)
  rulers = loadFlag('paperish:rulers', true)
  update: UpdateState | null = null
  /** Design checks of the current page. */
  lint: LintState | null = null
  lintOpen = false
  private lintTimer = 0
  steps: AgentStep[] = []
  stepsOpen = false
  /** An agent's options waiting for the user to pick one, and the note to send with the pick. */
  proposal: Proposal | null = null
  pickNote = ''
  /** Comment mode: the thread open in the panel, and a pin placed but not yet posted. */
  activeThread: string | null = null
  commentDraft: { pageId: string; nodeId: string | null; x: number; y: number } | null = null
  showResolved = false

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

  /** Tell node views whose object changed. */
  private notifyNodes(prev: Record<string, PNode> | undefined) {
    const next = this.doc?.nodes

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
    switch (msg.t) {
      case 'doc': {
        const switched = this.doc?.id !== msg.doc.id
        const prevNodes = this.doc?.nodes
        this.home = false
        this.boardSizes.clear()
        this.doc = msg.doc
        this.notifyNodes(prevNodes)
        void ensureFonts(familiesIn(msg.doc))
        this.version = msg.version
        this.pageId = msg.pageId

        if (switched) {
          this.selection = []
          this.hover = null
          this.repo = null
          this.changesOpen = false
          this.setEditingText(null)

          this.lint = null
          this.proposal = null
          this.activeThread = null
          this.commentDraft = null
          this.focus = null

          if (!ENGINE_MODE && !VIEW_NODE) {
            history.replaceState(null, '', `?file=${msg.doc.id}`)
            this.restoreCamera()
          }
        } else {
          // Reloaded in place (e.g. its .paperish file changed on disk).
          this.selection = this.selection.filter((id) => msg.doc.nodes[id])

          if (this.hover && !msg.doc.nodes[this.hover]) this.hover = null

          if (this.editingText && !msg.doc.nodes[this.editingText]) this.setEditingText(null)

          if (this.focus && !msg.doc.nodes[this.focus]) this.focus = null
        }

        this.scheduleLint(0)
        break
      }

      case 'ops': {
        if (!this.doc) return
        this.forgetBoardSizes(msg.ops)
        const { doc, touched } = applyOps(this.doc, msg.ops)
        this.doc = doc
        this.version = msg.version

        for (const id of touched) this.notifyNode(id)
        void ensureFonts(familiesIn(doc, touched))

        if (msg.origin === 'agent') this.lastAgentActivity = Date.now()

        this.scheduleLint()

        if (!this.doc.pages.some((p) => p.id === this.pageId))
          this.pageId = this.doc.pages[0]?.id ?? ''
        this.selection = this.selection.filter((id) => this.doc!.nodes[id])

        if (!this.doc.project) this.project = null

        if (this.hover && !this.doc.nodes[this.hover]) this.hover = null

        if (this.editingText && !this.doc.nodes[this.editingText]) this.setEditingText(null)

        if (this.focus && !this.doc.nodes[this.focus]) this.focus = null
        break
      }

      case 'working':
        this.working = msg.ids
        break
      case 'steps':
        this.steps = msg.steps
        break
      case 'settings':
        this.settings = msg.settings
        this.scheduleLint(0)
        break
      case 'update':
        this.update = msg.update
        break
      case 'lint':
        if (msg.fileId === this.doc?.id) this.lint = msg.lint
        break
      case 'proposal': {
        if (msg.proposal?.id !== this.proposal?.id) this.pickNote = ''
        this.proposal = msg.proposal
        const first = msg.proposal && this.doc?.nodes[msg.proposal.options[0].nodeId]
        const page = first && this.doc?.pages.find((p) => p.rootId === first.parent)

        if (page && page.id !== this.pageId && !ENGINE_MODE) this.setPage(page.id)
        break
      }

      case 'comment:created':
        this.activeThread = msg.threadId
        this.commentDraft = null
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
      case 'closed': {
        const prevNodes = this.doc?.nodes
        this.doc = null
        this.notifyNodes(prevNodes)
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
        this.lint = null
        this.lintOpen = false
        this.steps = []
        this.stepsOpen = false
        this.proposal = null
        this.activeThread = null
        this.commentDraft = null
        this.focus = null
        this.setEditingText(null)

        if (!ENGINE_MODE && !VIEW_NODE) history.replaceState(null, '', location.pathname)
        break
      }

      case 'page':
        if (this.pageId !== msg.pageId) {
          this.pageId = msg.pageId
          this.selection = []
          this.focus = null
          this.scheduleLint(0)
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

    this.flushWaiters()
    this.emit()
  }

  /** An edit can resize its artboard; forgetting the size makes the canvas render and measure it again. */
  private forgetBoardSizes(ops: Op[]) {
    for (const op of ops) {
      switch (op.t) {
        case 'tokens':
        case 'fontFaces':
          return this.boardSizes.clear()
        case 'styles':
        case 'patch':
          this.forgetBoardOf(op.id)
          break
        case 'insert':
          this.forgetBoardOf(op.parentId)
          break
        case 'move':
          this.forgetBoardOf(op.id)
          this.forgetBoardOf(op.parentId)
          break
        case 'delete':
          for (const id of op.ids) this.forgetBoardOf(id)
          break
      }
    }
  }

  private forgetBoardOf(id: string) {
    const board = this.doc && artboardOf(this.doc.nodes, id)

    if (board) this.boardSizes.delete(board.id)
  }

  setBoardSizes(sizes: Map<string, { width: number; height: number }>) {
    const changed = [...sizes].filter(([id, s]) => {
      const was = this.boardSizes.get(id)

      return !was || Math.abs(was.width - s.width) > 0.5 || Math.abs(was.height - s.height) > 0.5
    })

    if (!changed.length) return
    this.boardSizes = new Map([...this.boardSizes, ...changed])
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

  /**
   * Applied synchronously (listeners write the DOM), so reads right after see it.
   * Offsets snap to device pixels, like native scrolling, so a pan moves the
   * design's raster instead of redrawing it.
   */
  setCamera(c: Camera) {
    const dpr = window.devicePixelRatio
    this.camera = { zoom: c.zoom, x: Math.round(c.x * dpr) / dpr, y: Math.round(c.y * dpr) / dpr }

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

    if (open) {
      this.lintOpen = false
      this.stepsOpen = false
    }

    this.emit()
  }

  saveSettings(patch: { openRouterKey?: string; theme?: ThemeSetting }) {
    this.send({ t: 'settings', ...patch })
  }

  /** Answer the open proposal with an option's artboard, or null for none of them. */
  pick(nodeId: string | null) {
    if (!this.proposal) return
    this.send({ t: 'pick', proposalId: this.proposal.id, nodeId, note: this.pickNote })
    this.setHover(null)
  }

  setPickNote(note: string) {
    this.pickNote = note
    this.emit()
  }

  startComment(draft: Store['commentDraft']) {
    this.commentDraft = draft
    this.activeThread = null
    this.emit()
  }

  postComment(text: string) {
    if (this.commentDraft) this.send({ t: 'comment:create', ...this.commentDraft, text })
  }

  openThread(id: string | null) {
    const t = id ? this.doc?.comments.find((c) => c.id === id) : null
    this.tool = 'comment'
    this.activeThread = t?.id ?? null
    this.commentDraft = null

    if (t && t.pageId !== this.pageId) this.setPage(t.pageId)
    this.emit()
  }

  setShowResolved(show: boolean) {
    this.showResolved = show
    this.emit()
  }

  setSettingsOpen(open: boolean) {
    this.settingsOpen = open
    this.emit()
  }

  setLintOpen(open: boolean) {
    this.lintOpen = open

    if (open) {
      this.inspectOpen = false
      this.stepsOpen = false
    }

    this.emit()
  }

  setStepsOpen(open: boolean) {
    this.stepsOpen = open

    if (open) {
      this.inspectOpen = false
      this.lintOpen = false
    }

    this.emit()
  }

  revertStep(step: number) {
    this.send({ t: 'revertStep', step })
  }

  pickDesignMd() {
    this.send({ t: 'pickDesignMd' })
  }

  /** Re-check the page once edits settle. */
  scheduleLint(delay = 1200) {
    if (!this.doc || ENGINE_MODE || VIEW_NODE) return
    clearTimeout(this.lintTimer)
    this.lintTimer = window.setTimeout(() => this.send({ t: 'lint' }), delay)
  }

  openPalette(query = '') {
    this.palette = { query }
    this.emit()
  }

  closePalette() {
    this.palette = null
    this.emit()
  }

  setNavOpen(open: boolean) {
    this.navOpen = open

    try {
      localStorage.setItem('paperish:navOpen', String(open))
    } catch {}

    this.emit()
  }

  setRulers(on: boolean) {
    this.rulers = on

    try {
      localStorage.setItem('paperish:rulers', String(on))
    } catch {}

    this.emit()
  }

  setFocus(id: string | null) {
    this.focus = id
    this.selection = this.selection.filter((s) => !id || artboardOf(this.doc!.nodes, s)?.id === id)
    this.emit()
  }

  /** The page's top-level nodes on the canvas: all of them, or the focused one alone. */
  get boards(): string[] {
    if (this.focus) return [this.focus]

    return (this.page && this.doc?.nodes[this.page.rootId]?.children) || []
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

    if (tool !== 'comment') {
      this.activeThread = null
      this.commentDraft = null
    }

    this.emit()
  }

  setPage(pageId: string) {
    this.pageId = pageId
    this.selection = []
    this.focus = null
    this.send({ t: 'page', pageId })
    this.scheduleLint(0)
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

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key)

    if (saved !== null) return saved === 'true'
  } catch {}

  return fallback
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
