import path from 'node:path'
import type { ArtboardChange, Doc, RepoCommit, RepoCompare } from '../shared/types'
import { engine } from './engine'
import { fileLog, repoRoot, resolveRev, showFile, type Commit } from './git'
import { importAssets, parseRepoFile, subtreeSignature } from './repo'
import type { OpenFile, Workspace } from './workspace'

// Version history for repo-backed files: which artboards changed between two
// versions of a .paperish file, with visual diffs rendered by the layout
// engine. Old versions are opened as read-only snapshots so the engine can
// render them next to the live document.

interface Repo {
  file: string
  root: string
  /** The file's path relative to the repo root. */
  rel: string
}

async function repoOf(f: OpenFile): Promise<Repo> {
  const file = f.doc.source
  const root = await repoRoot(path.dirname(file))

  if (!root) throw new Error(`${file} isn’t inside a git repository.`)

  return { file, root, rel: path.relative(root, file).split(path.sep).join('/') }
}

const commitInfo = (c: Commit): RepoCommit => ({
  sha: c.sha,
  short: c.short,
  author: c.author,
  date: c.date,
  subject: c.subject,
})

export async function fileHistory(f: OpenFile, limit = 50): Promise<RepoCommit[]> {
  const repo = await repoOf(f)

  return (await fileLog(repo.file, limit)).map(commitInfo)
}

/** The file at a commit, opened read-only; null if it didn't exist there. */
async function openVersion(
  ws: Workspace,
  f: OpenFile,
  repo: Repo,
  sha: string,
  rel: string,
  date = '',
): Promise<OpenFile | null> {
  const buf = await showFile(repo.root, sha, rel)

  if (!buf) return null
  const text = buf.toString('utf8')
  const abs = path.join(repo.root, rel)
  const relDir = path.posix.dirname(rel)
  const parsed = parseRepoFile(text, abs)
  await importAssets(text, path.dirname(abs), { root: repo.root, sha, relDir })

  return ws.snapshot(`${f.doc.id}~${sha.slice(0, 12)}`, f.projectId, f.checkout, (): Doc => ({
    id: '',
    createdAt: date,
    updatedAt: date,
    ...parsed,
    source: abs,
  }))
}

/** The file as of a revision ("HEAD", "main", a sha), for comparing against. */
export async function openRevision(
  ws: Workspace,
  f: OpenFile,
  rev: string,
): Promise<{ file: OpenFile | null; sha: string }> {
  const repo = await repoOf(f)
  const sha = await resolveRev(repo.root, rev)

  return { file: await openVersion(ws, f, repo, sha, repo.rel), sha }
}

// ---- comparing ---------------------------------------------------------------------

interface Board {
  id: string
  name: string
  pageId: string
  pageName: string
  left: unknown
  top: unknown
}

function boards(doc: Doc): Map<string, Board> {
  const out = new Map<string, Board>()

  for (const p of doc.pages)
    for (const id of doc.nodes[p.rootId]?.children ?? []) {
      const n = doc.nodes[id]

      if (n && !n.hidden)
        out.set(id, {
          id,
          name: n.name,
          pageId: p.id,
          pageName: p.name,
          left: n.styles.left,
          top: n.styles.top,
        })
    }

  return out
}

const UI_WIDTH = 3200

async function thumb(
  f: OpenFile,
  b: Board,
): Promise<Pick<ArtboardChange, 'before' | 'width' | 'height'>> {
  const r = (await engine.layout(f, [b.id], b.pageId))[b.id]

  const shot = await engine.screenshot(
    f,
    b.id,
    {
      scale: Math.min(1, UI_WIDTH / Math.max(1, r?.width ?? UI_WIDTH)),
      format: 'jpeg',
      quality: 85,
    },
    b.pageId,
  )

  return { before: `data:image/jpeg;base64,${shot.data}`, width: r?.width, height: r?.height }
}

interface DiffResult {
  diffPixels: number
  contentScore: number
  score: number
  shift: number
  regions: { x: number; y: number; width: number; height: number; pixels: number }[]
  a?: string
  b?: string
  heat?: string
  composite?: string
}

/** Pixel diff of one artboard between two versions (`after` is the design, `before` the reference). */
async function diffBoard(
  before: OpenFile,
  after: OpenFile,
  id: string,
  pages: { before: string; after: string },
  forAgent = false,
) {
  const width = (await engine.layout(after, [id], pages.after))[id]?.width ?? UI_WIDTH
  const scale = forAgent ? 1 : Math.min(1, UI_WIDTH / Math.max(1, width))

  const [a, b] = await Promise.all([
    engine.screenshot(after, id, { scale, format: 'png' }, pages.after),
    engine.screenshot(before, id, { scale, format: 'png' }, pages.before),
  ])

  const res = await engine.call<DiffResult>(
    after,
    'diff',
    {
      a: `data:image/png;base64,${a.data}`,
      b: `data:image/png;base64,${b.data}`,
      threshold: 0.1,
      tolerance: 1,
      fit: 'width',
      parts: !forAgent,
    },
    pages.after,
  )

  return { ...res, scale }
}

/** A change plus, for agents, one before | after | heatmap image (base64 JPEG). */
export type Change = ArtboardChange & { composite?: string }

/** What changed between two versions of a file, artboard by artboard. */
export async function compareFiles(
  before: OpenFile | null,
  after: OpenFile,
  opts: { agent?: boolean } = {},
): Promise<{ changes: Change[]; notes: string[] }> {
  const notes: string[] = []
  const was = before ? boards(before.doc) : new Map<string, Board>()
  const now = boards(after.doc)

  const styleChanged =
    !!before &&
    (JSON.stringify(before.doc.tokens) !== JSON.stringify(after.doc.tokens) ||
      JSON.stringify(before.doc.fontFaces ?? []) !== JSON.stringify(after.doc.fontFaces ?? []))

  if (styleChanged) notes.push('Design tokens or fonts changed, so every artboard was compared.')

  if (Object.values(after.doc.nodes).some((n) => n.type === 'Component'))
    notes.push(
      'Codebase components render with the code as it is now, so only changes to their props show up.',
    )

  const changes: Change[] = []

  for (const b of now.values()) {
    const old = was.get(b.id)
    const base = { id: b.id, name: b.name, pageName: b.pageName }

    if (!old) {
      // SAFETY: thumb resolves { before, width, height }; the fallback keeps the same keys with undefined values.
      const t = await thumb(after, b).catch(() => ({}) as Awaited<ReturnType<typeof thumb>>)
      changes.push({ ...base, status: 'added', after: t.before, width: t.width, height: t.height })
      continue
    }

    const moved = old.left !== b.left || old.top !== b.top

    if (
      !styleChanged &&
      subtreeSignature(before!.doc, b.id) === subtreeSignature(after.doc, b.id)
    ) {
      changes.push({ ...base, status: 'unchanged', moved })
      continue
    }

    try {
      const d = await diffBoard(
        before!,
        after,
        b.id,
        { before: old.pageId, after: b.pageId },
        opts.agent,
      )

      if (!d.diffPixels) {
        changes.push({ ...base, status: 'unchanged', moved })
        continue
      }

      const s = (v: number) => Math.round(v / d.scale)
      changes.push({
        ...base,
        status: 'changed',
        moved,
        before: d.b,
        after: d.a,
        heat: d.heat,
        composite: d.composite,
        contentScore: d.contentScore,
        diffPixels: d.diffPixels,
        regions: d.regions.map((r) => ({
          x: s(r.x),
          y: s(r.y),
          width: s(r.width),
          height: s(r.height),
        })),
      })
    } catch (e) {
      changes.push({ ...base, status: 'changed', moved })
      // SAFETY: diffBoard, layout and screenshot reject with Error instances.
      notes.push(`${b.name}: ${(e as Error).message}`)
    }
  }

  for (const old of was.values()) {
    if (now.has(old.id)) continue
    // SAFETY: thumb resolves { before, width, height }; the fallback keeps the same keys with undefined values.
    const t = await thumb(before!, old).catch(() => ({}) as Awaited<ReturnType<typeof thumb>>)
    changes.push({
      id: old.id,
      name: old.name,
      pageName: old.pageName,
      status: 'removed',
      before: t.before,
      width: t.width,
      height: t.height,
    })
  }

  return { changes, notes }
}

const cache = new Map<string, Promise<RepoCompare>>()

/**
 * What one entry of the file's history changed: `target` is a commit sha
 * (compared with the file's previous commit) or "working" (uncommitted changes
 * against the last commit).
 */
export function compareCommit(ws: Workspace, f: OpenFile, target: string): Promise<RepoCompare> {
  // Commits never change, so their results are kept. The working copy (and
  // what HEAD is) can change any time, so its result only dedupes concurrent asks.
  const key = `${f.doc.id}:${target}`
  let p = cache.get(key)

  if (!p) {
    p = run(ws, f, target)
    cache.set(key, p)
    p.then(
      () => target === 'working' && cache.delete(key),
      () => cache.delete(key),
    )

    while (cache.size > 24) cache.delete(cache.keys().next().value!)
  }

  return p
}

async function run(ws: Workspace, f: OpenFile, target: string): Promise<RepoCompare> {
  const repo = await repoOf(f)
  const log = await fileLog(repo.file, 200)
  let from: Commit | undefined
  let to: Commit | undefined

  if (target === 'working') from = log[0]
  else {
    const i = log.findIndex((c) => c.sha === target || c.sha.startsWith(target))

    if (i < 0) throw new Error(`Commit ${target} didn't change ${repo.rel}.`)
    to = log[i]
    from = log[i + 1]
  }

  const before = from ? await openVersion(ws, f, repo, from.sha, from.path, from.date) : null
  const after = to ? await openVersion(ws, f, repo, to.sha, to.path, to.date) : f

  if (!after) throw new Error(`${repo.rel} couldn't be read at ${to!.short}.`)
  const { changes, notes } = await compareFiles(before, after)

  if (!before && from) notes.push(`${repo.rel} couldn't be read at ${from.short}.`)

  return { from: from ? commitInfo(from) : null, to: to ? commitInfo(to) : null, changes, notes }
}
