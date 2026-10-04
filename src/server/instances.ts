import { applyOps, subtreeIds } from '../shared/ops'
import type { NodePatch, Op, PatchKey, PNode, StyleValue } from '../shared/types'
import { cloneSubtree } from './html'
import type { OpenFile } from './workspace'

type Snapshot = Map<string, PNode>

const FIELDS: PatchKey[] = [
  'name',
  'tag',
  'text',
  'src',
  'svg',
  'attrs',
  'hidden',
  'component',
  'props',
  'content',
]

const PLACEMENT = new Set(['position', 'left', 'top', 'right', 'bottom', 'inset'])

export interface LinkedResult {
  ops: Op[]
  inverse: Op[]
}

export function applyLinked(f: OpenFile, ops: Op[]): LinkedResult {
  let touched = new Map<string, Snapshot>()

  const track = (op: Op) => {
    const nodes = f.doc.nodes

    for (const id of targets(op))
      for (const m of mainsAbove(nodes, id))
        if (!touched.has(m)) touched.set(m, new Map(subtreeIds(nodes, m).map((i) => [i, nodes[i]])))
  }

  ops.forEach(track)
  const first = applyOps(f.doc, ops)
  f.doc = first.doc
  const all = [...ops]
  const inverse = first.inverse

  const emit = (op: Op) => {
    track(op)
    const r = applyOps(f.doc, [op])
    f.doc = r.doc
    all.push(op)
    inverse.unshift(...r.inverse)
  }

  for (let round = 0; touched.size && round < 8; round++) {
    const mains = touched
    touched = new Map()

    for (const [id, before] of mains) syncMain(f, id, before, emit)
  }

  return { ops: all, inverse }
}

export function instanceNodes(f: OpenFile, id: string): PNode[] {
  const ids = subtreeIds(f.doc.nodes, id)

  const copy = cloneSubtree(
    ids.map((i) => f.doc.nodes[i]),
    () => f.mint(),
  )

  copy.forEach((n, i) => (n.mainId = ids[i]))

  return copy
}

function targets(op: Op): string[] {
  switch (op.t) {
    case 'insert':
      return [op.parentId]
    case 'delete':
      return op.ids
    case 'styles':
    case 'patch':
      return [op.id]
    case 'move':
      return [op.id, op.parentId]
    default:
      return []
  }
}

function mainsAbove(nodes: Record<string, PNode>, id: string): string[] {
  const out: string[] = []

  for (let n: PNode | undefined = nodes[id]; n; n = n.parent ? nodes[n.parent] : undefined)
    if (n.main) out.push(n.id)

  return out
}

function syncMain(f: OpenFile, mainId: string, before: Snapshot, emit: (op: Op) => void) {
  const nodes = f.doc.nodes

  if (!nodes[mainId]?.main) return
  const live = new Set(subtreeIds(nodes, mainId))
  const roots = Object.keys(nodes).filter((id) => nodes[id].mainId === mainId)

  for (const root of roots) {
    if (!nodes[root]) continue
    const byMain = new Map<string, string>()

    for (const id of subtreeIds(nodes, root)) {
      const m = nodes[id].mainId

      if (m && !byMain.has(m)) byMain.set(m, id)
    }

    const walk = (mid: string, iid: string) => {
      syncFields(before.get(mid), nodes[mid], nodes[iid], mid === mainId, emit)
      let prev: string | null = null

      for (const c of nodes[mid].children) {
        const cid = byMain.get(c)
        const after = () => (prev ? nodes[iid].children.indexOf(prev) + 1 : 0)

        if (!cid) {
          if (before.has(c)) continue
          const copy = instanceNodes(f, c)
          emit({ t: 'insert', parentId: iid, index: after(), nodes: copy })
          prev = copy[0].id
          continue
        }

        const at = nodes[iid].children.indexOf(cid)

        if (at < after())
          emit({ t: 'move', id: cid, parentId: iid, index: after() - (at < 0 ? 0 : 1) })

        prev = cid
        walk(c, cid)
      }

      const gone = nodes[iid].children.filter((c) => {
        const m = nodes[c].mainId

        return !!m && before.has(m) && !live.has(m)
      })

      if (gone.length) emit({ t: 'delete', ids: gone })
    }

    walk(mainId, root)
  }
}

function syncFields(
  was: PNode | undefined,
  now: PNode,
  inst: PNode,
  root: boolean,
  emit: (op: Op) => void,
) {
  if (!was || was === now) return
  const set: Record<string, StyleValue | null> = {}

  for (const k of new Set([...Object.keys(was.styles), ...Object.keys(now.styles)])) {
    if (root && PLACEMENT.has(k)) continue

    if (now.styles[k] !== was.styles[k] && inst.styles[k] === was.styles[k])
      set[k] = now.styles[k] ?? null
  }

  if (Object.keys(set).length) emit({ t: 'styles', id: inst.id, set })

  const patch: NodePatch = {}

  for (const k of FIELDS)
    if (!same(now[k], was[k]) && same(inst[k], was[k]))
      Object.assign(patch, { [k]: now[k] ?? null })

  if (Object.keys(patch).length) emit({ t: 'patch', id: inst.id, patch })
}

function same(a: PNode[PatchKey], b: PNode[PatchKey]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
