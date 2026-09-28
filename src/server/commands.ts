import { canHaveChildren, subtreeIds } from '../shared/ops'
import type { Op, ProjectState, Styles } from '../shared/types'
import { cloneSubtree, parseHtml } from './html'
import { componentsFor, ensureProject, projectState, tailwindEntryFor, validateRoot } from './project'
import { classTokens, tailwindResolver } from './tailwind'
import type { OpenFile, Origin } from './workspace'

// Editor commands that need server-minted ids.

export async function insertHtml(f: OpenFile, parentId: string, html: string, index?: number, styles?: Styles): Promise<string[]> {
  const parent = f.node(parentId)
  if (!canHaveChildren(parent)) throw new Error(`"${parent.name}" cannot have children`)
  const tokens = classTokens(html)
  const { subtrees } = parseHtml(html, {
    mint: () => f.mint(),
    cloneSource: (id) => (f.doc.nodes[id] ? subtreeIds(f.doc.nodes, id).map((i) => f.doc.nodes[i]) : null),
    tailwind: tokens.length ? await tailwindResolver(tokens, tailwindEntryFor(f.doc)) : undefined,
    width: parseFloat(String(parent.styles.width)) || 1440,
    components: componentsFor(f.doc),
  })
  const at = index ?? parent.children.length
  const ops: Op[] = subtrees.map((sub, i) => {
    if (styles && i === 0) sub[0] = { ...sub[0], styles: { ...sub[0].styles, ...styles } }
    return { t: 'insert', parentId: parent.id, index: at + i, nodes: sub }
  })
  f.transact(ops, 'user', 'insert')
  return subtrees.map((s) => s[0].id)
}

/** Link (or unlink with null) a codebase to a file and start its component host. */
export async function linkProject(f: OpenFile, input: string | null, origin: Origin): Promise<ProjectState | null> {
  if (!input) {
    if (f.doc.project) f.transact([{ t: 'project', project: null }], origin, 'unlink codebase')
    f.broadcast({ t: 'project', project: null })
    return null
  }
  const root = validateRoot(input)
  if (f.doc.project?.root !== root) f.transact([{ t: 'project', project: { root } }], origin, 'link codebase')
  const current = projectState(root)
  if (current) f.broadcast({ t: 'project', project: current })
  return ensureProject(root)
}

export function duplicate(f: OpenFile, ids: string[]): string[] {
  const ops: Op[] = []
  const created: string[] = []
  for (const id of ids) {
    const src = f.doc.nodes[id]
    if (!src?.parent) continue
    const parent = f.doc.nodes[src.parent]
    const copy = cloneSubtree(subtreeIds(f.doc.nodes, id).map((i) => f.doc.nodes[i]), () => f.mint())
    if (parent.type === 'Root' || src.styles.position === 'absolute') {
      const left = parseFloat(String(src.styles.left ?? 0)) || 0
      const width = parseFloat(String(src.styles.width ?? 0)) || 200
      const offset = parent.type === 'Root' ? width + 80 : 16
      copy[0] = { ...copy[0], styles: { ...copy[0].styles, left: `${Math.round(left + offset)}px` } }
      if (parent.type !== 'Root') copy[0].styles.top = `${(parseFloat(String(src.styles.top ?? 0)) || 0) + 16}px`
    }
    ops.push({ t: 'insert', parentId: parent.id, index: parent.children.indexOf(id) + 1, nodes: copy })
    created.push(copy[0].id)
  }
  f.transact(ops, 'user', 'duplicate')
  return created
}
