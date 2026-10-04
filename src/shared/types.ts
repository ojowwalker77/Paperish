// Core document model shared by server, editor and layout engine.
// A document is a flat map of nodes; every page has a Root node whose
// children are artboards (or free-floating nodes) positioned by left/top.

export type NodeType = 'Root' | 'Frame' | 'Text' | 'Image' | 'SVG' | 'Component'

export type Framework = 'react' | 'vue'

/** Points at a component exported from the linked codebase. */
interface ComponentRef {
  /** `<relative file>#<export name>` */
  id: string
  name: string
  framework: Framework
}

export type StyleValue = string | number

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue }

export type Styles = Record<string, StyleValue>

export interface PNode {
  id: string
  type: NodeType
  name: string
  /** Semantic HTML tag used when rendering/exporting (div, h1, button...). */
  tag: string
  styles: Styles
  /** Extra HTML attributes kept for export (href, alt, aria-label...). */
  attrs?: Record<string, string>
  text?: string
  src?: string
  /** Full <svg> outer markup for SVG nodes. */
  svg?: string
  /** Component nodes: which component, its props, and children markup. */
  component?: ComponentRef
  props?: Record<string, JsonValue>
  content?: string
  parent: string | null
  children: string[]
  hidden?: boolean
  locked?: boolean
  fork?: { from: string; why?: string }
  /** A main component: its instances follow it. */
  main?: boolean
  /** In an instance: the node of the main component this one follows. */
  mainId?: string
}

export interface Page {
  id: string
  name: string
  rootId: string
}

export type TokenType =
  | 'breakpoint'
  | 'color'
  | 'container'
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'letterSpacing'
  | 'lineHeight'
  | 'opacity'
  | 'radius'
  | 'spacing'

export const TOKEN_TYPES: TokenType[] = [
  'breakpoint',
  'color',
  'container',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'opacity',
  'radius',
  'spacing',
]

export interface Token {
  name: string
  type: TokenType
  value: StyleValue
  description?: string
}

/** A web font bundled with the document (e.g. from a URL import). */
export interface FontFaceDef {
  family: string
  /** /media/... URL of the font file */
  src: string
  weight?: string
  style?: string
  unicodeRange?: string
}

export interface CommentMessage {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: string
}

export interface CommentThread {
  id: string
  pageId: string
  nodeId: string | null
  /** Where the pin sits: px from the node's top-left, or canvas coordinates without a node. */
  x?: number
  y?: number
  status: 'open' | 'resolved'
  createdAt: string
  messages: CommentMessage[]
}

export interface Doc {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  pages: Page[]
  nodes: Record<string, PNode>
  tokens: Token[]
  comments: CommentThread[]
  fontFaces?: FontFaceDef[]
  /** Linked codebase whose components can be placed on the canvas. */
  project?: { root: string }
  /** Absolute path of the .paperish file this document saves to (see server/repo.ts). */
  source: string
  /** Monotonic counter used to mint short node ids. */
  seq: number
}

export interface FileSummary {
  id: string
  name: string
  updatedAt: string
  pageCount: number
  nodeCount: number
  /** Absolute path of the .paperish file. */
  source: string
  projectId: string
  /** The checkout (main or a git worktree) the file lives in; unset for a branch viewed as committed. */
  checkout?: string
  /** Set for files of a branch viewed as committed (read-only): the branch and the path in it. */
  ref?: { branch: string; rel: string }
}

/** A checkout of a project: its main one, or a git worktree. */
export interface CheckoutInfo {
  path: string
  branch: string | null
  main: boolean
  fileCount: number
}

/** What the editor is looking at within a project. */
export type ProjectView =
  | { kind: 'checkout'; path: string; branch: string | null; main: boolean }
  | { kind: 'branch'; branch: string }

/** A folder whose design/ holds .paperish files: a repo, or the built-in Scratch. */
export interface ProjectInfo {
  id: string
  name: string
  root: string
  scratch: boolean
  fileCount: number
  updatedAt: string
  /** This project's MCP endpoint (also written to the repo's .mcp.json). */
  mcp: string
}

export type PatchKey =
  | 'name'
  | 'text'
  | 'src'
  | 'svg'
  | 'hidden'
  | 'locked'
  | 'tag'
  | 'attrs'
  | 'props'
  | 'content'
  | 'component'
  | 'main'
  | 'mainId'

/** null removes the field. */
export type NodePatch = { [K in PatchKey]?: PNode[K] | null }

// ---- Ops -------------------------------------------------------------------

export type Op =
  | { t: 'insert'; parentId: string; index: number; nodes: PNode[] }
  | { t: 'delete'; ids: string[] }
  | { t: 'styles'; id: string; set: Record<string, StyleValue | null> }
  | { t: 'patch'; id: string; patch: NodePatch }
  | { t: 'move'; id: string; parentId: string; index: number }
  | { t: 'tokens'; tokens: Token[] }
  | { t: 'page:add'; page: Page; root: PNode; nodes?: PNode[]; index?: number }
  | { t: 'page:remove'; pageId: string }
  | { t: 'page:rename'; pageId: string; name: string }
  | { t: 'doc:rename'; name: string }
  | { t: 'comments'; comments: CommentThread[] }
  | { t: 'fontFaces'; fontFaces: FontFaceDef[] }
  | { t: 'project'; project: { root: string } | null }
  | { t: 'seq'; seq: number }

// ---- Linked codebases -------------------------------------------------------------

export interface ComponentProp {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'node' | 'object' | 'unknown'
  options?: string[]
  required?: boolean
  default?: string
}

export interface ComponentInfo {
  id: string
  name: string
  /** Path relative to the project root. */
  file: string
  export: string
  framework: Framework
  /** Import specifier for generated code, e.g. '@/components/ui/button'. */
  importPath: string
  props: ComponentProp[]
  /** Renders children / a default slot. */
  slot: boolean
}

export interface ProjectState {
  root: string
  name: string
  frameworks: Framework[]
  tailwind: string | null
  cssEntries: string[]
  /** Stylesheets the app's entry files import (e.g. `import './index.css'` in main.tsx), as import specifiers. */
  globalCss: string[]
  status: 'starting' | 'ready' | 'error'
  error?: string
  hostOrigin?: string
  components: ComponentInfo[]
  icons?: IconSet
}

export interface IconSet {
  module: string
  framework: Framework
  names: string[]
}

// ---- Repo-backed files -------------------------------------------------------------

export interface RepoState {
  /** Absolute path of the .paperish file. */
  path: string
  /** Path relative to the git root (or the file name outside git). */
  rel: string
  /** Git toplevel, null when the file isn't inside a work tree. */
  root: string | null
  branch: string | null
  state: 'clean' | 'modified' | 'untracked' | 'unversioned'
  /** Why saving is paused (the file on disk can't be read, e.g. merge conflicts). */
  problem?: string
}

export interface RepoCommit {
  sha: string
  short: string
  author: string
  date: string
  subject: string
}

export interface ArtboardChange {
  id: string
  name: string
  pageName: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  /** Only the artboard's canvas position changed. */
  moved?: boolean
  /** JPEG data URLs: the artboard before and after, and the diff heatmap (in `after` pixels). */
  before?: string
  after?: string
  heat?: string
  width?: number
  height?: number
  /** Share of non-background pixels that agree (changed artboards). */
  contentScore?: number
  diffPixels?: number
  regions?: { x: number; y: number; width: number; height: number }[]
}

export interface RepoCompare {
  from: RepoCommit | null
  /** null = the working copy. */
  to: RepoCommit | null
  changes: ArtboardChange[]
  notes: string[]
}

export interface TaskState {
  id: string
  label: string
  pct: number
  status: 'running' | 'done' | 'error'
  message?: string
  /** Nodes created by the task (for selecting them when done). */
  ids?: string[]
  /** Client that started it, so only that editor jumps to the result. */
  origin?: string
}

/** App-wide settings as the editor sees them (the OpenRouter key itself stays on the server). */
export interface SettingsState {
  openRouter: boolean
  figma: boolean
  theme: ThemeSetting
}

export type ThemeSetting = 'system' | 'light' | 'dark'

/** A new version downloading in the background, then ready to install by restarting. */
export interface UpdateState {
  version: string
  percent: number
  ready: boolean
}

/** What the layout engine measures of one rendered node for design checks. */
export type AuditFact = {
  id: string
  type: NodeType
  name: string
  tag: string
  depth: number
  text?: string
  fontSize?: number
  fontWeight?: number
  fontFamily?: string
  color?: string
  /** The opaque color behind the text, and the contrast ratio against it. */
  backdrop?: string
  contrast?: number
  background?: string
  border?: string
  /** top, right, bottom, left */
  padding: number[]
  /** row, column */
  gap?: number[]
  /** top-left, top-right, bottom-right, bottom-left */
  radius: number[]
  x: number
  y: number
  width: number
  height: number
  reorder?: string
}

export interface LintIssue {
  /** Stable across runs: rule and artboard. */
  id: string
  rule: string
  title: string
  detail: string
  severity: 'error' | 'warning'
  artboard: string
  nodeIds: string[]
  /** Ops that resolve it, when there's an unambiguous fix. */
  fix?: Op[]
}

export interface LintState {
  /** Path of the DESIGN.md checked against, if the repo has one. */
  designMd: string | null
  issues: LintIssue[]
  /** Do's and Don'ts: checked by Jev, skipped (none written, or no OpenRouter key), or failed. */
  rules: { count: number; status: 'checked' | 'none' | 'no-key' | 'error'; error?: string }
  error?: string
}

/** An agent's alternatives for one decision, for the user to choose between. */
export interface Proposal {
  id: string
  question: string
  options: ProposalOption[]
}

export interface ProposalOption {
  /** A top-level artboard. */
  nodeId: string
  letter: string
  label: string
  /** One line on the trade-off. */
  note?: string
}

export interface AgentStep {
  id: number
  why: string | null
  tools: string[]
  at: string
  reverted: boolean
}

export interface PickResult {
  proposalId: string
  question: string
  /** null: none of them. */
  picked: ProposalOption | null
  note?: string
  /** The options removed once one was picked. */
  removed: string[]
}

export interface KnobSet {
  id: string
  nodeId: string
  knobs: Knob[]
}

export interface Knob {
  name: string
  label: string
  type: 'slider' | 'number' | 'color'
  min?: number
  max?: number
  step?: number
  unit?: string
}

// ---- Wire protocol (editor/engine <-> server) --------------------------------

export type ClientMsg =
  /** Without fileId an editor starts on the home screen. */
  | { t: 'hello'; fileId?: string; role: 'editor' | 'engine' }
  | { t: 'home' }
  /** Pick a folder with the system dialog and add it as a project. */
  | { t: 'addProject' }
  /** Ask for every project, e.g. to switch to another from the editor. */
  | { t: 'projects' }
  | { t: 'openProject'; projectId: string }
  /** Switch to another checkout of the current project (the same file there, if it exists). */
  | { t: 'openCheckout'; checkout: string }
  /** View a branch as committed, read-only (a file in it by path, or its newest). */
  | { t: 'openBranch'; branch: string; rel?: string }
  /** Take a project off the list; its files stay in the repo. */
  | { t: 'removeProject'; projectId: string }
  /** Rename a project; an empty name goes back to the repo's. */
  | { t: 'renameProject'; projectId: string; name: string }
  | { t: 'open'; fileId: string }
  | { t: 'tx'; ops: Op[]; label?: string }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'selection'; pageId: string; ids: string[] }
  | { t: 'page'; pageId: string }
  | { t: 'createFile'; name?: string }
  | { t: 'deleteFile'; fileId: string }
  | { t: 'insertHtml'; parentId: string; index?: number; html: string; styles?: Styles }
  | { t: 'duplicate'; ids: string[]; instance?: boolean }
  | { t: 'fork'; id: string }
  | { t: 'importUrl'; url: string; width?: number; token?: string }
  | { t: 'importFigma'; urls: string[]; token?: string }
  | { t: 'createPage'; name?: string }
  /** Set the OpenRouter key or Figma token; empty removes it. */
  | { t: 'settings'; openRouterKey?: string; figmaToken?: string; theme?: ThemeSetting }
  /** Restart into the downloaded update. */
  | { t: 'installUpdate' }
  /** Check the open file's current page against its DESIGN.md. */
  | { t: 'lint' }
  /** Pick the project's DESIGN.md with the system dialog, then check again. */
  | { t: 'pickDesignMd' }
  /** Start a comment thread pinned to a node (or a canvas point when nodeId is null). */
  | {
      t: 'comment:create'
      pageId: string
      nodeId: string | null
      x: number
      y: number
      text: string
    }
  | { t: 'comment:reply'; threadId: string; text: string }
  | { t: 'comment:status'; threadId: string; status: 'open' | 'resolved' }
  | { t: 'comment:delete'; threadId: string }
  /** Answer the open proposal: an option's artboard, or null for none. */
  | { t: 'pick'; proposalId: string; nodeId: string | null; note?: string }
  | { t: 'revertStep'; step: number }
  | { t: 'knob'; knobsId: string; name: string; value: string }
  | { t: 'knobsDone'; knobsId: string }

export type ServerMsg =
  | { t: 'doc'; doc: Doc; version: number; pageId: string }
  | { t: 'ops'; ops: Op[]; version: number; origin: 'user' | 'agent' | 'system' }
  | { t: 'working'; ids: string[] }
  /** The files the editor can switch to: those of the current checkout, or of the branch being viewed. */
  | {
      t: 'files'
      files: FileSummary[]
      project: ProjectInfo
      view: ProjectView
      checkouts: CheckoutInfo[]
      /** Local branches without a checkout, which can be viewed as committed. */
      branches: string[]
    }
  /** An agent is working in another checkout of this project than the one the editor shows. */
  | { t: 'agentElsewhere'; checkout: string; branch: string | null; fileId: string }
  | { t: 'projects'; projects: ProjectInfo[] }
  /** Back to the home screen (e.g. the open file was deleted with nothing to fall back to). */
  | { t: 'closed' }
  | { t: 'page'; pageId: string }
  | { t: 'reveal'; ids: string[] }
  | { t: 'agent'; active: boolean; label?: string }
  | { t: 'created'; ids: string[] }
  | { t: 'task'; task: TaskState }
  | { t: 'project'; project: ProjectState | null }
  | { t: 'repo'; repo: RepoState | null }
  | { t: 'error'; message: string }
  | { t: 'settings'; settings: SettingsState }
  | { t: 'update'; update: UpdateState }
  | { t: 'lint'; fileId: string; lint: LintState }
  | { t: 'proposal'; proposal: Proposal | null }
  | { t: 'knobs'; knobs: KnobSet | null }
  /** The thread this connection just created, so its editor can open it. */
  | { t: 'comment:created'; threadId: string }
  | { t: 'steps'; steps: AgentStep[] }
