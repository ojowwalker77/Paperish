import { randomBytes } from 'node:crypto'
import { mergeFontFaces } from '../shared/fontfaces'
import type { Op, TaskState, Token } from '../shared/types'
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
): Promise<{ rootId: string; result: ImportResult }> {
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
    const top = result.nodes[0]
    top.parent = root.id
    top.styles = { ...top.styles, left: `${place.left}px`, top: `${place.top}px` }

    const ops: Op[] = [
      { t: 'insert', parentId: root.id, index: root.children.length, nodes: result.nodes },
    ]

    if (result.fontFaces.length)
      ops.push({ t: 'fontFaces', fontFaces: mergeFontFaces(f.doc.fontFaces, result.fontFaces) })

    const tokens = newTokens(f, result.tokens ?? [])

    if (tokens.length) ops.push({ t: 'tokens', tokens: [...f.doc.tokens, ...tokens] })
    f.transact(ops, origin, 'import')
    f.broadcast({ t: 'reveal', ids: [top.id] })
    Object.assign(task, {
      status: 'done',
      pct: 100,
      label: `Imported ${job.label}`,
      ids: [top.id],
      message: [
        `${result.stats.layers} layers`,
        `${result.stats.images} images`,
        `${result.stats.fonts} fonts`,
        ...(tokens.length ? [`${tokens.length} tokens`] : []),
      ].join(' · '),
    })
    push()

    return { rootId: top.id, result }
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

export function hostOf(url: string): string {
  try {
    return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname
  } catch {
    return url
  }
}
