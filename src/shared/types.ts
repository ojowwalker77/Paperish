// Core document model shared by server, editor and layout engine.
// A document is a flat map of nodes; every page has a Root node whose
// children are artboards (or free-floating nodes) positioned by left/top.

export type NodeType = 'Root' | 'Frame' | 'Text' | 'Image' | 'SVG' | 'Component'

export type Framework = 'react' | 'vue'

/** Points at a component exported from the linked codebase. */
export interface ComponentRef {
  /** `<relative file>#<export name>` */
  id: string
  name: string
  framework: Framework
}

export type StyleValue = string | number
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
  props?: Record<string, unknown>
  content?: string
  parent: string | null
  children: string[]
  hidden?: boolean
  locked?: boolean
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
export type ProjectView = { kind: 'checkout'; path: string; branch: string | null; main: boolean } | { kind: 'branch'; branch: string }

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

type PatchKey = 'name' | 'text' | 'src' | 'svg' | 'hidden' | 'locked' | 'tag' | 'attrs' | 'props' | 'content' | 'component'
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

// ---- Wire protocol (editor/engine <-> server) --------------------------------

export type ClientMsg =
  /** Without fileId an editor starts on the home screen. */
  | { t: 'hello'; fileId?: string; role: 'editor' | 'engine' }
  | { t: 'home' }
  /** Pick a folder with the system dialog and add it as a project. */
  | { t: 'addProject' }
  | { t: 'openProject'; projectId: string }
  /** Switch to another checkout of the current project (the same file there, if it exists). */
  | { t: 'openCheckout'; checkout: string }
  /** View a branch as committed, read-only (a file in it by path, or its newest). */
  | { t: 'openBranch'; branch: string; rel?: string }
  /** Take a project off the list; its files stay in the repo. */
  | { t: 'removeProject'; projectId: string }
  | { t: 'open'; fileId: string }
  | { t: 'tx'; ops: Op[]; label?: string }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'selection'; pageId: string; ids: string[] }
  | { t: 'page'; pageId: string }
  | { t: 'createFile'; name?: string }
  | { t: 'deleteFile'; fileId: string }
  | { t: 'insertHtml'; parentId: string; index?: number; html: string; styles?: Styles }
  | { t: 'duplicate'; ids: string[] }
  | { t: 'importUrl'; url: string; width?: number; token?: string }
  | { t: 'createPage'; name?: string }

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
