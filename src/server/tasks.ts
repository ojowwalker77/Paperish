import { randomBytes } from 'node:crypto'
import { mergeFontFaces } from '../shared/fontfaces'
import { subtreeIds } from '../shared/ops'
import type { Op, PNode, TaskState, Token } from '../shared/types'
import type { ImportResult, Progress } from './importer'
import { findPlacement } from './placement'
import type { OpenFile, Origin } from './workspace'

// Long-running work (imports) reported to editors as progress tasks.

export interface ImportJob {
  label: string
  run: (progress: Progress) => Promise<ImportResult>
}

export async function runImport(
  f: OpenFile,
  job: ImportJob,
  origin: Origin,
  token?: string,
): Promise<{ rootId: string; rootIds: string[]; result: ImportResult }> {
  const task: TaskState = {
    id: randomBytes(4).toString('hex'),
    label: `Importing ${job.label}`,
    pct: 0,
    status: 'running',
    origin: token,
  }

  const push = () => f.broadcast({ t: 'task', task: { ...task } })
  push()

  try {
    const result = await job.run((label, pct) => {
      task.label = `${label} · ${job.label}`
      task.pct = pct
      push()
    })

    const place = await findPlacement(f)
    const root = f.doc.nodes[f.page.rootId]
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]))
    const tops = result.nodes.filter((n) => !n.parent || !byId[n.parent])
    const dx = place.left - Math.min(...tops.map((n) => at(n, 'left')))
    const dy = place.top - Math.min(...tops.map((n) => at(n, 'top')))

    const ops: Op[] = tops.map((top, i) => {
      const nodes = subtreeIds(byId, top.id).map((id) => byId[id])
      top.parent = root.id
      top.styles = {
        ...top.styles,
        left: `${at(top, 'left') + dx}px`,
        top: `${at(top, 'top') + dy}px`,
      }

      return { t: 'insert', parentId: root.id, index: root.children.length + i, nodes }
    })

    if (result.fontFaces.length)
      ops.push({ t: 'fontFaces', fontFaces: mergeFontFaces(f.doc.fontFaces, result.fontFaces) })

    const tokens = newTokens(f, result.tokens ?? [])

    if (tokens.length) ops.push({ t: 'tokens', tokens: [...f.doc.tokens, ...tokens] })
    f.transact(ops, origin, 'import')
    const rootIds = tops.map((n) => n.id)
    f.broadcast({ t: 'reveal', ids: rootIds })
    Object.assign(task, {
      status: 'done',
      pct: 100,
      label: `Imported ${job.label}`,
      ids: rootIds,
      message: [
        `${result.stats.layers} layers`,
        `${result.stats.images} images`,
        `${result.stats.fonts} fonts`,
        ...(tokens.length ? [`${tokens.length} tokens`] : []),
      ].join(' · '),
    })
    push()

    return { rootId: rootIds[0], rootIds, result }
  } catch (e) {
    // SAFETY: import producers, findPlacement and transact reject with Error instances.
    Object.assign(task, { status: 'error', message: (e as Error).message.split('\n')[0] })
    push()
    throw e
  }
}

export function newTokens(f: OpenFile, tokens: Token[]): Token[] {
  const names = new Set(f.doc.tokens.map((t) => t.name))

  return tokens.filter((t) => !names.has(t.name))
}

function at(n: PNode, k: 'left' | 'top'): number {
  return parseFloat(String(n.styles[k])) || 0
}

export function hostOf(url: string): string {
  try {
    return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname
  } catch {
    return url
  }
}
