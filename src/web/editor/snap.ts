import { store } from '../store'
import { worldRect, type Box } from './actions'

export interface Guide {
  x1: number
  y1: number
  x2: number
  y2: number
}

const THRESHOLD = 6

export function snapTargets(parentId: string | null, exclude: readonly string[]): Box[] {
  const parent = parentId ? store.node(parentId) : null
  const ids = parent ? parent.children : store.boards
  const out: Box[] = []

  for (const id of ids) {
    if (exclude.includes(id) || store.node(id)?.hidden) continue
    const r = worldRect(id)

    if (r) out.push(r)
  }

  const own = parentId && worldRect(parentId)

  if (own) out.push(own)

  return out
}

interface Snap {
  dx: number
  dy: number
  guides: Guide[]
}

export function snap(box: Box, targets: readonly Box[]): Snap {
  const limit = THRESHOLD / store.camera.zoom
  const x = nearest([box.x, box.x + box.width / 2, box.x + box.width], targets, 'x', limit)
  const y = nearest([box.y, box.y + box.height / 2, box.y + box.height], targets, 'y', limit)
  const at = { ...box, x: box.x + x.delta, y: box.y + y.delta }
  const guides: Guide[] = []

  for (const v of x.lines) {
    const span = [at, ...targets.filter((t) => touches(t, 'x', v))]
    guides.push({
      x1: v,
      x2: v,
      y1: Math.min(...span.map((r) => r.y)),
      y2: Math.max(...span.map((r) => r.y + r.height)),
    })
  }

  for (const v of y.lines) {
    const span = [at, ...targets.filter((t) => touches(t, 'y', v))]
    guides.push({
      y1: v,
      y2: v,
      x1: Math.min(...span.map((r) => r.x)),
      x2: Math.max(...span.map((r) => r.x + r.width)),
    })
  }

  return { dx: x.delta, dy: y.delta, guides }
}

function nearest(edges: number[], targets: readonly Box[], axis: 'x' | 'y', limit: number) {
  let delta = Infinity

  for (const t of targets) {
    for (const v of lines(t, axis)) {
      for (const e of edges) {
        if (Math.abs(v - e) <= limit && Math.abs(v - e) < Math.abs(delta)) delta = v - e
      }
    }
  }

  if (!isFinite(delta)) return { delta: 0, lines: [] }
  const hits = new Set<number>()

  for (const e of edges) {
    if (targets.some((t) => touches(t, axis, e + delta))) hits.add(e + delta)
  }

  return { delta, lines: [...hits] }
}

function lines(r: Box, axis: 'x' | 'y') {
  const start = axis === 'x' ? r.x : r.y
  const size = axis === 'x' ? r.width : r.height

  return [start, start + size / 2, start + size]
}

function touches(r: Box, axis: 'x' | 'y', v: number) {
  return lines(r, axis).some((l) => Math.abs(l - v) < 0.5)
}
