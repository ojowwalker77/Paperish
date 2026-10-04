import { toStaticHTML } from '../../shared/html'
import { artboardOf } from '../../shared/ops'
import type { Op, PNode, StyleValue } from '../../shared/types'
import { store, type Camera } from '../store'

// Editor-side actions shared by the canvas, keyboard shortcuts and panels.

let viewport: HTMLElement | null = null

export function setViewport(el: HTMLElement | null) {
  viewport = el
}

// Element lookups are cached: an attribute selector over a large design costs
// real time, and the overlay asks for the same few elements over and over.
const elCache = new Map<string, HTMLElement>()

export function nodeEl(id: string): HTMLElement | null {
  const hit = elCache.get(id)

  if (hit?.isConnected && hit.getAttribute('data-pid') === id) return hit

  const el = document.querySelector<HTMLElement>(
    `.pw-canvas .pw-world [data-pid="${CSS.escape(id)}"]`,
  )

  if (elCache.size > 4000) elCache.clear() // drop detached leftovers

  if (el) elCache.set(id, el)
  else elCache.delete(id)

  return el
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** World-space rect of a canvas element. The camera is applied to the DOM synchronously, so this is exact. */
export function worldRectOf(el: Element): Box | null {
  if (!viewport) return null
  const r = el.getBoundingClientRect()
  const vp = viewport.getBoundingClientRect()
  const c = store.camera

  return {
    x: (r.left - vp.left - c.x) / c.zoom,
    y: (r.top - vp.top - c.y) / c.zoom,
    width: r.width / c.zoom,
    height: r.height / c.zoom,
  }
}

/** Artboards come from the document (they may not be rendered); other nodes from the DOM, else their artboard's. */
export function worldRect(id: string): Box | null {
  const board = store.doc && artboardOf(store.doc.nodes, id)
  const known = board?.id === id ? boardRect(id) : null

  if (known) return known
  const el = nodeEl(id)

  if (el) return worldRectOf(el)

  return board ? boardRect(board.id) : null
}

/** Where an artboard sits without rendering it: its left/top, and its size when last rendered or its own px size. */
export function boardRect(id: string): Box | null {
  const n = store.node(id)
  const size = store.boardSizes.get(id) ?? fixedSize(n)

  return n && size ? { x: px(n.styles.left), y: px(n.styles.top), ...size } : null
}

/** Where an artboard could be: its rect, or for one not measured yet whose size isn't fixed, all right of and below its corner. */
export function boardReach(id: string): Box | null {
  const n = store.node(id)

  if (!n) return null
  const w = String(n.styles.width)
  const h = String(n.styles.height)

  return (
    boardRect(id) ?? {
      x: px(n.styles.left),
      y: px(n.styles.top),
      width: PX.test(w) ? px(w) : Infinity,
      height: PX.test(h) ? px(h) : Infinity,
    }
  )
}

function fixedSize(n: PNode | undefined) {
  const w = String(n?.styles.width)
  const h = String(n?.styles.height)

  return PX.test(w) && PX.test(h) ? { width: px(w), height: px(h) } : undefined
}

const PX = /^\d+(\.\d+)?(px)?$/

export function toWorld(clientX: number, clientY: number) {
  const vp = viewport!.getBoundingClientRect()
  const c = store.camera

  return { x: (clientX - vp.left - c.x) / c.zoom, y: (clientY - vp.top - c.y) / c.zoom }
}

export function viewportSize() {
  const r = viewport?.getBoundingClientRect()

  return { width: r?.width ?? 1000, height: r?.height ?? 800 }
}

/** The part of the viewport to fit content into (panels are docked beside it, so all of it, less a margin). */
/** The canvas minus what floats over it: the navigator on the left, the version dock below. */
function visibleArea() {
  const vp = viewportSize()
  const m = 16
  const left = store.navOpen ? NAV_WIDTH : 0
  const bottom = store.focus ? DOCK_HEIGHT : 0

  return {
    x: m + left,
    y: m,
    width: Math.max(200, vp.width - 2 * m - left),
    height: Math.max(200, vp.height - 2 * m - bottom),
  }
}

const NAV_WIDTH = 270

const DOCK_HEIGHT = 120

// ---- tree helpers ------------------------------------------------------------

function isTopLevel(id: string): boolean {
  const n = store.node(id)

  return !!n?.parent && store.node(n.parent)?.type === 'Root'
}

export function isMovable(id: string): boolean {
  const n = store.node(id)

  if (!n || n.locked) return false

  return isTopLevel(id) || n.styles.position === 'absolute'
}

/** Ancestors from the top-level node down to id (inclusive). */
export function pathTo(id: string): string[] {
  const out: string[] = []
  let cur = store.node(id)

  while (cur && cur.type !== 'Root') {
    out.unshift(cur.id)
    cur = store.node(cur.parent)
  }

  return out
}

/**
 * Which node a click on `hitId` selects. Top-level artboards are "transparent":
 * clicks go to their direct children unless the user is already working
 * deeper (a selected node or one of its siblings is on the path).
 */
export function pickTarget(hitId: string, deep: boolean): string {
  const path = pathTo(hitId).filter((id) => !store.node(id)?.locked || id === hitId)

  if (!path.length) return hitId

  if (deep) return path[path.length - 1]
  const sel = store.selection
  let depth = -1

  for (let i = path.length > 1 ? 1 : 0; i < path.length; i++) {
    const n = store.node(path[i])

    if (sel.some((s) => s === path[i] || store.node(s)?.parent === n?.parent)) depth = i
  }

  if (depth >= 0) return path[depth]

  return path.length > 1 ? path[1] : path[0]
}

// ---- camera ------------------------------------------------------------------

let anim = 0

function animateCamera(target: Camera, ms = 260) {
  cancelAnimationFrame(anim)
  const from = { ...store.camera }
  const t0 = performance.now()

  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms)
    const e = 1 - Math.pow(1 - k, 3)
    store.setCamera({
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      zoom: from.zoom + (target.zoom - from.zoom) * e,
    })

    if (k < 1) anim = requestAnimationFrame(step)
  }

  anim = requestAnimationFrame(step)
}

function bounds(ids: string[]): Box | null {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity

  for (const id of ids) {
    const r = worldRect(id)

    if (!r) continue
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.width)
    y2 = Math.max(y2, r.y + r.height)
  }

  return isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null
}

function fitCamera(ids: string[], opts: { maxZoom?: number; pad?: number } = {}): Camera | null {
  const b = bounds(ids)

  if (!b) return null
  const area = visibleArea()
  const pad = opts.pad ?? 64

  const zoom = Math.max(
    0.02,
    Math.min(
      opts.maxZoom ?? 1,
      (area.width - pad * 2) / b.width,
      (area.height - pad * 2) / b.height,
    ),
  )

  return {
    zoom,
    x: area.x + area.width / 2 - (b.x + b.width / 2) * zoom,
    y: area.y + area.height / 2 - (b.y + b.height / 2) * zoom,
  }
}

export function zoomToFit(ids?: string[], animate = true) {
  const target = fitCamera(ids?.length ? ids : store.boards)

  if (!target) return

  if (animate) animateCamera(target)
  else store.setCamera(target)
}

/** Bring nodes into view without zooming in; used when the agent creates things. */
export function reveal(ids: string[]) {
  const b = bounds(ids)

  if (!b) return
  const c = store.camera
  const area = visibleArea()
  const sx = b.x * c.zoom + c.x
  const sy = b.y * c.zoom + c.y

  const visible =
    sx >= area.x &&
    sy >= area.y &&
    sx + b.width * c.zoom <= area.x + area.width &&
    sy + b.height * c.zoom <= area.y + area.height

  if (visible) return
  const target = fitCamera(ids, { maxZoom: c.zoom })

  if (target) animateCamera(target, 420)
}

export function zoomBy(factor: number) {
  const c = store.camera
  const vp = viewportSize()
  const zoom = Math.max(0.02, Math.min(32, c.zoom * factor))
  const cx = vp.width / 2
  const cy = vp.height / 2
  store.setCamera({
    zoom,
    x: cx - ((cx - c.x) / c.zoom) * zoom,
    y: cy - ((cy - c.y) / c.zoom) * zoom,
  })
}

export function zoomTo(zoom: number) {
  zoomBy(zoom / store.camera.zoom)
}

// ---- edits -------------------------------------------------------------------

export function deleteSelection() {
  const ids = store.selection.filter((id) => !store.node(id)?.locked)

  if (!ids.length) return
  const parent = store.node(ids[0])?.parent
  store.tx([{ t: 'delete', ids }], 'delete')
  const p = store.node(parent)
  store.select(p && p.type !== 'Root' ? [p.id] : [])
}

export async function duplicateSelection() {
  if (!store.selection.length) return
  const ids = await store.command({ t: 'duplicate', ids: store.selection })
  store.select(ids)
}

export function nudge(dx: number, dy: number) {
  const ops: Op[] = []

  for (const id of store.selection) {
    if (!isMovable(id)) continue
    const n = store.node(id)!
    ops.push({
      t: 'styles',
      id,
      set: { left: `${px(n.styles.left) + dx}px`, top: `${px(n.styles.top) + dy}px` },
    })
  }

  store.tx(ops, 'nudge')
}

export function px(v: StyleValue | null | undefined): number {
  const n = parseFloat(String(v ?? 0))

  return isFinite(n) ? n : 0
}

export function selectParent() {
  const n = store.node(store.selection[0])
  const p = store.node(n?.parent)
  store.select(p && p.type !== 'Root' ? [p.id] : [])
}

export function selectChildren() {
  const ids = store.selection.flatMap((id) => store.node(id)?.children ?? [])

  if (ids.length) store.select(ids)
  else if (store.selection.length === 1 && store.node(store.selection[0])?.type === 'Text')
    startEditingText(store.selection[0])
}

export function startEditingText(id: string) {
  const n = store.node(id)

  if (n?.type !== 'Text' || n.locked) return
  store.selection = [id]
  store.setEditingText(id)
  store.emit()
}

export function commitText() {
  const id = store.editingText

  if (!id) return
  const el = nodeEl(id)
  const n = store.node(id)
  store.setEditingText(null)

  if (el && n) {
    const text = el.innerText.replace(/\n$/, '')

    if (text !== n.text)
      store.tx(
        [
          {
            t: 'patch',
            id,
            patch: {
              text,
              name: n.name === n.text || n.name === 'Text' ? text.slice(0, 40) || 'Text' : n.name,
            },
          },
        ],
        'edit text',
      )
  }

  store.emit()
}

export function setHidden(id: string, hidden: boolean) {
  store.tx([{ t: 'patch', id, patch: { hidden: hidden || null } }], hidden ? 'hide' : 'show')
}

export function setLocked(id: string, locked: boolean) {
  store.tx([{ t: 'patch', id, patch: { locked: locked || null } }], locked ? 'lock' : 'unlock')
}

export function rename(id: string, name: string) {
  const n = store.node(id)

  if (n && name.trim() && name !== n.name)
    store.tx([{ t: 'patch', id, patch: { name: name.trim().slice(0, 50) } }], 'rename')
}

// ---- preview -----------------------------------------------------------------

/** Open the artboard containing the selection (or the first one) as a full page. */
export function openPreview() {
  const doc = store.doc

  if (!doc) return
  commitText()
  const from = store.selection[0] ?? store.hover
  let target = from ? artboardOf(doc.nodes, from) : undefined

  if (!target) {
    const first = store.node(store.page?.rootId)?.children.find((c) => !store.node(c)?.hidden)
    target = store.node(first)
  }

  if (target) store.setPreview(target.id)
}

// ---- clipboard ---------------------------------------------------------------

const CLIP_MARK = 'paperish-nodes'

export function copySelection(e: ClipboardEvent) {
  const doc = store.doc

  if (!doc || !store.selection.length) return

  const html = store.selection
    .map((id) => toStaticHTML(doc.nodes, id, undefined, { componentMarkup: true }))
    .join('\n')

  e.clipboardData?.setData('text/html', `<!--${CLIP_MARK}-->${html}`)
  e.clipboardData?.setData('text/plain', html)
  e.preventDefault()
}

export async function paste(e: ClipboardEvent) {
  const html = e.clipboardData?.getData('text/html') || ''
  const plain = e.clipboardData?.getData('text/plain') || ''
  const source = html || (/^\s*<[a-z!]/i.test(plain) ? plain : '')

  if (!source && !plain) return
  e.preventDefault()

  const markup = source
    ? source.replace(/<!--[\s\S]*?-->/g, '').replace(/<meta[^>]*>/gi, '')
    : `<p>${escapeHtml(plain)}</p>`

  const target = pasteTarget()
  const styles: Record<string, string> = {}

  if (target.type === 'Root') {
    const vp = viewportSize()
    const c = store.camera
    styles.left = `${Math.round((vp.width / 2 - c.x) / c.zoom - 200)}px`
    styles.top = `${Math.round((vp.height / 2 - c.y) / c.zoom - 150)}px`
  }

  const ids = await store.command({ t: 'insertHtml', parentId: target.id, html: markup, styles })
  store.select(ids)
}

function pasteTarget(): PNode {
  const sel = store.node(store.selection[0])

  if (sel?.type === 'Frame') return sel
  const parent = store.node(sel?.parent)

  if (parent) return parent

  return store.node(store.page!.rootId)!
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function isTyping(e: KeyboardEvent | Event) {
  // SAFETY: typing check only reads tagName/isContentEditable; target is the focused element.
  const t = e.target as HTMLElement | null

  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
}
