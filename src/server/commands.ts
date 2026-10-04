import { canHaveChildren, pageOf, subtreeIds } from '../shared/ops'
import type { Op, ProjectState, Styles } from '../shared/types'
import { nextVersionName, viewsOf } from '../shared/views'
import { cloneSubtree, parseHtml, type ParseResult } from './html'
import { findPlacement } from './placement'
import { instanceNodes } from './instances'
import {
  componentsFor,
  ensureProject,
  projectState,
  tailwindEntryFor,
  validateRoot,
} from './project'
import { classTokens, tailwindResolver } from './tailwind'
import type { OpenFile, Origin } from './workspace'

// Editor commands that need server-minted ids.

export async function insertHtml(
  f: OpenFile,
  parentId: string,
  html: string,
  index?: number,
  styles?: Styles,
): Promise<string[]> {
  const parent = f.node(parentId)

  if (!canHaveChildren(parent)) throw new Error(`"${parent.name}" cannot have children`)
  const { subtrees } = await htmlToNodes(f, html, parseFloat(String(parent.styles.width)) || 1440)

  const at = index ?? parent.children.length

  const ops: Op[] = subtrees.map((sub, i) => {
    if (styles && i === 0) sub[0] = { ...sub[0], styles: { ...sub[0].styles, ...styles } }

    return { t: 'insert', parentId: parent.id, index: at + i, nodes: sub }
  })

  f.transact(ops, 'user', 'insert')

  return subtrees.map((s) => s[0].id)
}

export async function htmlToNodes(f: OpenFile, html: string, width: number): Promise<ParseResult> {
  const tokens = classTokens(html)

  return parseHtml(html, {
    mint: () => f.mint(),
    cloneSource: (id) =>
      f.doc.nodes[id] ? subtreeIds(f.doc.nodes, id).map((i) => f.doc.nodes[i]) : null,
    tailwind: tokens.length ? await tailwindResolver(tokens, tailwindEntryFor(f.doc)) : undefined,
    width,
    components: componentsFor(f.doc),
  })
}

/** Link (or unlink with null) a codebase to a file and start its component host. */
export async function linkProject(
  f: OpenFile,
  input: string | null,
  origin: Origin,
): Promise<ProjectState | null> {
  if (!input) {
    if (f.doc.project) f.transact([{ t: 'project', project: null }], origin, 'unlink codebase')
    f.broadcast({ t: 'project', project: null })

    return null
  }

  const root = validateRoot(input)

  if (f.doc.project?.root !== root)
    f.transact([{ t: 'project', project: { root } }], origin, 'link codebase')
  const current = projectState(root)

  if (current) f.broadcast({ t: 'project', project: current })

  return ensureProject(root)
}

export function duplicate(f: OpenFile, ids: string[], instance?: boolean): string[] {
  const ops: Op[] = []
  const created: string[] = []

  for (const id of ids) {
    const src = f.doc.nodes[id]

    if (!src?.parent) continue
    const parent = f.doc.nodes[src.parent]

    const copy = instance
      ? instanceNodes(f, id)
      : cloneSubtree(
          subtreeIds(f.doc.nodes, id).map((i) => f.doc.nodes[i]),
          () => f.mint(),
        )

    if (parent.type === 'Root' || src.styles.position === 'absolute') {
      const left = parseFloat(String(src.styles.left ?? 0)) || 0
      const width = parseFloat(String(src.styles.width ?? 0)) || 200
      const offset = parent.type === 'Root' ? width + 80 : 16
      copy[0] = {
        ...copy[0],
        styles: { ...copy[0].styles, left: `${Math.round(left + offset)}px` },
      }

      if (parent.type !== 'Root')
        copy[0].styles.top = `${(parseFloat(String(src.styles.top ?? 0)) || 0) + 16}px`
    }

    ops.push({
      t: 'insert',
      parentId: parent.id,
      index: parent.children.indexOf(id) + 1,
      nodes: copy,
    })
    created.push(copy[0].id)
  }

  f.transact(ops, 'user', instance ? 'create instance' : 'duplicate')

  return created
}

export async function forkVersion(f: OpenFile, id: string, origin: Origin, why?: string) {
  const src = f.node(id)
  const page = pageOf(f.doc, src.id)
  const view = page && viewsOf(f.doc, page).find((v) => v.versions.includes(src.id))

  if (!page || !view) throw new Error(`"${src.name}" is not an artboard.`)
  const idMap: Record<string, string> = {}

  const copy = cloneSubtree(
    subtreeIds(f.doc.nodes, src.id).map((i) => f.doc.nodes[i]),
    () => f.mint(),
    idMap,
  )

  const { left, top } = await findPlacement(f)
  copy[0] = {
    ...copy[0],
    name: nextVersionName(view, f.doc),
    fork: { from: src.id, why },
    styles: { ...copy[0].styles, left: `${left}px`, top: `${top}px` },
  }
  const root = f.doc.nodes[page.rootId]
  f.transact(
    [{ t: 'insert', parentId: root.id, index: root.children.length, nodes: copy }],
    origin,
    'fork',
  )

  const { [src.id]: _, ...descendantIdMap } = idMap

  return { id: copy[0].id, name: copy[0].name, descendantIdMap }
}
