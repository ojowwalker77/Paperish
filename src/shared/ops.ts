import type { Doc, NodePatch, Op, PatchKey, PNode, Page, StyleValue } from './types'

// Applies ops in place on doc.nodes: changed nodes are replaced with new
// objects and the rest keep identity, so an edit costs what it touches rather
// than the document's size. Returns the touched ids, so consumers update just
// those, and the inverse ops (already ordered for application) so the server
// can keep an undo stack. If an op fails, the node map is restored.

export interface ApplyOpsResult {
  doc: Doc
  inverse: Op[]
  /** Nodes added, replaced or removed. */
  touched: string[]
}

export function applyOps(doc: Doc, ops: Op[]): ApplyOpsResult {
  const nodes = doc.nodes
  const prior = new Map<string, PNode | undefined>()
  const cloned = new Set<string>()
  let pages = doc.pages
  let tokens = doc.tokens
  let comments = doc.comments
  let fontFaces = doc.fontFaces
  let project = doc.project
  let name = doc.name
  const inverse: Op[] = []

  const put = (id: string, n: PNode | undefined) => {
    if (!prior.has(id)) prior.set(id, nodes[id])
    cloned.delete(id)

    if (n) nodes[id] = n
    else delete nodes[id]
  }

  const mut = (id: string): PNode => {
    const n = nodes[id]

    if (!n) throw new Error(`Node ${id} not found`)

    if (cloned.has(id)) return n
    const c: PNode = { ...n, children: n.children.slice(), styles: { ...n.styles } }
    put(id, c)
    cloned.add(id)

    return c
  }

  const subtree = (id: string): PNode[] => {
    const out: PNode[] = []

    const walk = (nid: string) => {
      const n = nodes[nid]

      if (!n) return
      out.push(n)
      n.children.forEach(walk)
    }

    walk(id)

    return out
  }

  try {
    for (const op of ops) {
      const inv: Op[] = []

      switch (op.t) {
        case 'insert': {
          const parent = mut(op.parentId)
          const root = op.nodes[0]

          if (!root) break

          for (const n of op.nodes) put(n.id, n)
          put(root.id, { ...root, parent: parent.id })
          const index = clamp(op.index, 0, parent.children.length)
          parent.children.splice(index, 0, root.id)
          inv.push({ t: 'delete', ids: [root.id] })
          break
        }

        case 'delete': {
          for (const id of op.ids) {
            const n = nodes[id]

            if (!n || !n.parent) continue
            const parent = mut(n.parent)
            const index = parent.children.indexOf(id)
            const removed = subtree(id)

            if (index >= 0) parent.children.splice(index, 1)

            for (const r of removed) put(r.id, undefined)

            inv.unshift({
              t: 'insert',
              parentId: parent.id,
              index: Math.max(0, index),
              nodes: removed,
            })
          }

          break
        }

        case 'styles': {
          const n = mut(op.id)
          const prev: Record<string, StyleValue | null> = {}

          for (const [k, v] of Object.entries(op.set)) {
            prev[k] = k in n.styles ? n.styles[k] : null

            if (v === null || v === '') delete n.styles[k]
            else n.styles[k] = v
          }

          inv.push({ t: 'styles', id: op.id, set: prev })
          break
        }

        case 'patch': {
          const n = mut(op.id)
          const prev: NodePatch = {}

          for (const [key, v] of Object.entries(op.patch)) {
            // SAFETY: NodePatch is keyed by PNode field names; entries come from that patch object.
            const k = key as PatchKey
            // SAFETY: prev mirrors op.patch[k]; never satisfies the correlated union assignment for k.
            prev[k] = (k in n ? n[k] : null) as never

            if (v === null || v === undefined) {
              // SAFETY: patch null clears the field; Partial makes delete legal for required keys.
              delete (n as Partial<PNode>)[k]
            } else {
              // SAFETY: v comes from op.patch[k]; never satisfies the correlated union assignment for k.
              n[k] = v as never
            }
          }

          inv.push({ t: 'patch', id: op.id, patch: prev })
          break
        }

        case 'move': {
          const n = mut(op.id)

          if (!n.parent) break
          const from = mut(n.parent)
          const fromIndex = from.children.indexOf(op.id)
          from.children.splice(fromIndex, 1)
          const to = mut(op.parentId)
          const index = clamp(op.index, 0, to.children.length)
          to.children.splice(index, 0, op.id)
          n.parent = to.id
          inv.push({ t: 'move', id: op.id, parentId: from.id, index: fromIndex })
          break
        }

        case 'tokens': {
          inv.push({ t: 'tokens', tokens })
          tokens = op.tokens
          break
        }

        case 'page:add': {
          put(op.root.id, op.root)

          for (const n of op.nodes ?? []) put(n.id, n)
          pages = pages.slice()
          pages.splice(op.index ?? pages.length, 0, op.page)
          inv.push({ t: 'page:remove', pageId: op.page.id })
          break
        }

        case 'page:remove': {
          const index = pages.findIndex((p) => p.id === op.pageId)

          if (index < 0) break
          const page = pages[index]
          const all = subtree(page.rootId)

          for (const n of all) put(n.id, undefined)
          pages = pages.filter((p) => p.id !== op.pageId)
          const [root, ...rest] = all
          inv.push({ t: 'page:add', page, root, index, nodes: rest })
          break
        }

        case 'page:rename': {
          const page = pages.find((p) => p.id === op.pageId)

          if (!page) break
          inv.push({ t: 'page:rename', pageId: op.pageId, name: page.name })
          pages = pages.map((p) => (p.id === op.pageId ? { ...p, name: op.name } : p))
          break
        }

        case 'doc:rename': {
          inv.push({ t: 'doc:rename', name })
          name = op.name
          break
        }

        case 'comments': {
          inv.push({ t: 'comments', comments })
          comments = op.comments
          break
        }

        case 'project': {
          inv.push({ t: 'project', project: project ?? null })
          project = op.project ?? undefined
          break
        }

        case 'fontFaces': {
          inv.push({ t: 'fontFaces', fontFaces: fontFaces ?? [] })
          fontFaces = op.fontFaces
          break
        }
      }

      inverse.unshift(...inv)
    }
  } catch (e) {
    for (const [id, n] of prior) {
      if (n) nodes[id] = n
      else delete nodes[id]
    }

    throw e
  }

  return {
    doc: { ...doc, name, pages, tokens, comments, fontFaces, project },
    inverse,
    touched: [...prior.keys()],
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

// ---- Tree helpers ----------------------------------------------------------

export function subtreeIds(nodes: Record<string, PNode>, id: string): string[] {
  const out: string[] = []

  const walk = (nid: string) => {
    const n = nodes[nid]

    if (!n) return
    out.push(nid)
    n.children.forEach(walk)
  }

  walk(id)

  return out
}

export function pageOf(doc: Doc, id: string): Page | undefined {
  let cur: PNode | undefined = doc.nodes[id]

  while (cur && cur.parent) cur = doc.nodes[cur.parent]

  return cur ? doc.pages.find((p) => p.rootId === cur!.id) : undefined
}

/** The top-level node (direct child of a page root) containing id. */
export function artboardOf(nodes: Record<string, PNode>, id: string): PNode | undefined {
  let cur = nodes[id]

  while (cur && cur.parent) {
    const parent = nodes[cur.parent]

    if (!parent) return undefined

    if (parent.type === 'Root') return cur
    cur = parent
  }

  return undefined
}

export function canHaveChildren(n: PNode): boolean {
  return n.type === 'Frame' || n.type === 'Root'
}
