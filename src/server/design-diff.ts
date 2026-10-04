import fs from 'node:fs'
import path from 'node:path'
import { subtreeIds } from '../shared/ops'
import type { Doc, PNode } from '../shared/types'
import { changedFiles, mergeBase, repoRoot, resolveRev, showFile, type FileChange } from './git'
import { compareFiles, type Change } from './history'
import { fileIdFor } from './projects'
import { EXT, importAssets, parseRepoFile, slugify } from './repo'
import type { OpenFile, Workspace } from './workspace'

export interface DiffJob {
  dir: string
  base: string
  head?: string
  out: string
  url?: string
}

interface BoardReport {
  id: string
  name: string
  pageName: string
  status: Change['status']
  moved: boolean
  contentScore?: number
  summary: string
  images: { before?: string; after?: string; heat?: string }
}

interface FileReport {
  path: string
  status: FileChange['status']
  boards: BoardReport[]
  notes: string[]
}

const MAX_SHOWN = 12

const COMMENT_MARKER = '<!-- paperish-design-diff -->'

const FIELDS: [keyof PNode, string][] = [
  ['text', 'text'],
  ['src', 'image'],
  ['svg', 'svg'],
  ['props', 'props'],
  ['component', 'component'],
  ['content', 'content'],
  ['tag', 'tag'],
  ['attrs', 'attributes'],
  ['hidden', 'visibility'],
  ['name', 'name'],
]

export async function designDiff(ws: Workspace, job: DiffJob) {
  const root = await repoRoot(path.resolve(job.dir))

  if (!root) throw new Error(`${job.dir} isn't inside a git repository.`)
  const head = job.head ? await resolveRev(root, job.head) : null
  const base = await mergeBase(root, await resolveRev(root, job.base), head ?? 'HEAD')
  const files = await changedFiles(root, base, head, `*${EXT}`)

  fs.rmSync(job.out, { recursive: true, force: true })
  fs.mkdirSync(job.out, { recursive: true })
  const reports: FileReport[] = []

  for (const change of files) {
    const report: FileReport = { path: change.path, status: change.status, boards: [], notes: [] }
    reports.push(report)

    try {
      if (change.status === 'deleted') continue

      const before =
        change.status === 'added' ? null : await open(ws, root, base, change.from, 'base')

      const after = await open(ws, root, head, change.path, 'head')

      if (!after) throw new Error(`${change.path} couldn't be read.`)
      const { changes, notes } = await compareFiles(before, after)
      report.notes.push(...notes)
      const dir = slugify(change.path.slice(0, -EXT.length))

      for (const c of changes) {
        if (c.status === 'unchanged' && !c.moved) continue
        const name = `${dir}/${slugify(c.name)}-${c.id.toLowerCase()}`

        report.boards.push({
          id: c.id,
          name: c.name,
          pageName: c.pageName,
          status: c.status,
          moved: !!c.moved,
          contentScore: c.contentScore,
          summary:
            c.status === 'changed' && before ? layerSummary(before.doc, after.doc, c.id) : '',
          images: {
            before: save(job.out, `${name}-before.jpg`, c.before),
            after: save(job.out, `${name}-after.jpg`, c.after),
            heat: save(job.out, `${name}-heat.jpg`, c.heat),
          },
        })
      }
    } catch (e) {
      report.notes.push(e instanceof Error ? e.message : String(e))
    } finally {
      console.log(`[paperish] ${change.path}: ${counts(report) || change.status}`)
    }
  }

  const result = { base, head: head ?? 'working tree', files: reports }
  fs.writeFileSync(path.join(job.out, 'diff.json'), JSON.stringify(result, null, 2) + '\n')
  fs.writeFileSync(path.join(job.out, 'summary.md'), markdown(reports, base, job.url))
  console.log(`[paperish] Wrote ${path.join(job.out, 'summary.md')}`)
}

async function open(
  ws: Workspace,
  root: string,
  sha: string | null,
  rel: string,
  side: string,
): Promise<OpenFile | null> {
  const abs = path.join(root, rel)
  const buf = sha ? await showFile(root, sha, rel) : fs.readFileSync(abs)

  if (!buf) return null
  const text = buf.toString('utf8')
  const parsed = parseRepoFile(text, abs)

  await importAssets(
    text,
    path.dirname(abs),
    sha ? { root, sha, relDir: path.posix.dirname(rel) } : undefined,
  )

  return ws.snapshot(`${fileIdFor(rel)}~${side}`, ws.projects.scratch.id, null, (): Doc => ({
    id: '',
    createdAt: '',
    updatedAt: '',
    ...parsed,
    project: undefined,
    source: abs,
  }))
}

function save(out: string, rel: string, dataUrl?: string): string | undefined {
  if (!dataUrl) return undefined
  const file = path.join(out, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))

  return rel
}

function layerSummary(before: Doc, after: Doc, id: string): string {
  const was = new Set(subtreeIds(before.nodes, id))
  const now = subtreeIds(after.nodes, id)
  const nowSet = new Set(now)

  const added = now.filter((x) => !was.has(x) && was.has(after.nodes[x].parent ?? ''))

  const removed = [...was].filter((x) => !nowSet.has(x) && nowSet.has(before.nodes[x].parent ?? ''))

  const edited = now
    .filter((x) => was.has(x))
    .map((x) => ({ x, props: edits(before.nodes[x], after.nodes[x], x === id) }))
    .filter((e) => e.props.length)

  const parts = [
    edited.length &&
      `Edited ${list(edited.map((e) => `${label(after.nodes[e.x])} (${list(e.props, 3)})`))}`,
    added.length && `Added ${list(added.map((x) => label(after.nodes[x])))}`,
    removed.length && `Removed ${list(removed.map((x) => label(before.nodes[x])))}`,
  ].filter(Boolean)

  return parts.length ? `${parts.join('. ')}.` : ''
}

function edits(a: PNode, b: PNode, top: boolean): string[] {
  const out: string[] = []

  for (const k of new Set([...Object.keys(a.styles), ...Object.keys(b.styles)])) {
    if (top && (k === 'left' || k === 'top')) continue

    if (JSON.stringify(a.styles[k]) !== JSON.stringify(b.styles[k]))
      out.push(k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))
  }

  for (const [k, name] of FIELDS)
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out.push(name)

  if (kept(a, b).join() !== kept(b, a).join()) out.push('order')

  return out
}

const kept = (n: PNode, other: PNode) => n.children.filter((c) => other.children.includes(c))

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`

const label = (n: PNode) => (n.name.length > 32 ? `${n.name.slice(0, 31)}…` : n.name)

function list(items: string[], max = 4): string {
  if (items.length <= max) return items.join(', ')

  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}

function counts(report: FileReport): string {
  return (['changed', 'added', 'removed'] as const)
    .flatMap((st) => {
      const n = report.boards.filter((b) => b.status === st).length

      return n ? [`${n} ${st}`] : []
    })
    .join(' · ')
}

function markdown(reports: FileReport[], base: string, url?: string): string {
  const src = (rel: string) => `${url ? url.replace(/\/$/, '') : '.'}/${rel}`
  const img = (alt: string, rel?: string) => (rel ? `![${alt}](${src(rel)})` : '')
  const lines = [COMMENT_MARKER, '### Design changes', '']
  let budget = MAX_SHOWN

  if (!reports.length) lines.push(`No \`${EXT}\` files changed since \`${base.slice(0, 7)}\`.`, '')

  for (const r of reports) {
    const what = r.status === 'modified' ? counts(r) || 'no visual changes' : `file ${r.status}`
    lines.push(`#### \`${r.path}\``, what, '')
    const rest: string[] = []

    for (const b of r.boards) {
      if (b.status === 'unchanged' || budget <= 0) {
        rest.push(`${b.name} (${b.status === 'unchanged' ? 'moved' : b.status})`)
        continue
      }

      budget--
      const score = b.contentScore === undefined ? '' : ` · ${pct(b.contentScore)} content match`
      lines.push(`**${b.name}** on ${b.pageName} · ${b.status}${score}`, '')

      if (b.summary) lines.push(b.summary, '')

      if (b.status === 'changed' && b.images.after)
        lines.push(
          '| Before | After | Heatmap |',
          '| :-: | :-: | :-: |',
          `| ${img('Before', b.images.before)} | ${img('After', b.images.after)} | ${img('Heatmap', b.images.heat)} |`,
          '',
        )
      else lines.push(img(b.status, b.images.after ?? b.images.before), '')
    }

    if (rest.length) lines.push(`Also: ${list(rest, 20)}.`, '')

    for (const n of r.notes) lines.push(`> ${n}`, '')
  }

  lines.push(`<sub>Compared with \`${base.slice(0, 7)}\` by Paperish.</sub>`, '')

  return lines.join('\n')
}
