import { randomBytes } from 'node:crypto'
import { mergeFontFaces } from '../shared/fontfaces'
import type { Op, TaskState } from '../shared/types'
import { importUrl, type ImportResult } from './importer'
import { findPlacement } from './placement'
import type { OpenFile, Origin } from './workspace'

// Long-running work (URL import) reported to editors as progress tasks.

export async function runImport(
  f: OpenFile,
  opts: { url: string; width?: number; name?: string },
  origin: Origin,
  token?: string,
): Promise<{ rootId: string; result: ImportResult }> {
  const task: TaskState = { id: randomBytes(4).toString('hex'), label: `Importing ${hostOf(opts.url)}`, pct: 0, status: 'running', origin: token }
  const push = () => f.broadcast({ t: 'task', task: { ...task } })
  push()
  try {
    const result = await importUrl(f, {
      ...opts,
      onProgress: (label, pct) => {
        task.label = `${label} · ${hostOf(opts.url)}`
        task.pct = pct
        push()
      },
    })
    const place = await findPlacement(f)
    const root = f.doc.nodes[f.page.rootId]
    const top = result.nodes[0]
    top.parent = root.id
    top.styles = { ...top.styles, left: `${place.left}px`, top: `${place.top}px` }
    const ops: Op[] = [{ t: 'insert', parentId: root.id, index: root.children.length, nodes: result.nodes }]
    if (result.fontFaces.length) ops.push({ t: 'fontFaces', fontFaces: mergeFontFaces(f.doc.fontFaces, result.fontFaces) })
    f.transact(ops, origin, 'import url')
    f.broadcast({ t: 'reveal', ids: [top.id] })
    Object.assign(task, { status: 'done', pct: 100, label: `Imported ${hostOf(opts.url)}`, ids: [top.id], message: `${result.stats.layers} layers · ${result.stats.images} images · ${result.stats.fonts} fonts` })
    push()
    return { rootId: top.id, result }
  } catch (e) {
    Object.assign(task, { status: 'error', message: (e as Error).message.split('\n')[0] })
    push()
    throw e
  }
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname
  } catch {
    return url
  }
}
