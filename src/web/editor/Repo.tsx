import { useEffect, useRef, useState } from 'react'
import type { ArtboardChange, RepoCommit, RepoCompare, RepoState } from '../../shared/types'
import { store, useStore } from '../store'
import { zoomToFit } from './actions'
import { Icon } from './icons'
import { useOutside } from './Topbar'

// Git for design files: the chip in the top bar (checkouts, branches), and
// the Changes view that compares versions of the .paperish file visually.

const STATE_LABEL: Record<RepoState['state'], string> = {
  clean: 'Committed',
  modified: 'Uncommitted changes',
  untracked: 'Not committed yet',
  unversioned: 'Not in a git repository',
}

/**
 * The status bar's branch picker: which checkout (main or a git worktree) or
 * branch the editor shows, with a menu to switch between them and open Changes.
 */
export function BranchPicker() {
  const repo = useStore((s) => s.repo)
  const view = useStore((s) => s.view)
  const checkouts = useStore((s) => s.checkouts)
  const branches = useStore((s) => s.branches)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false))
  if (!view) return null
  const readOnly = view.kind === 'branch'
  if (!readOnly && !repo?.root) return null // Scratch, or a project that isn't a git repo
  const branch = view.branch ?? 'detached'
  const title = readOnly ? `${branch} as committed (read-only)` : `${repo!.path}\n${repo!.problem ?? STATE_LABEL[repo!.state]}`
  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="pw-file-menu" ref={ref}>
      <button className={`pw-status-item pw-branch ${readOnly ? 'readonly' : ''}`} title={title} onClick={() => setOpen(!open)}>
        <Icon.Branch size={13} />
        <code>{branch}</code>
        {readOnly ? <span>read-only</span> : <span className={`pw-repo-dot ${repo!.problem ? 'problem' : repo!.state}`} />}
        {view.kind === 'checkout' && !view.main && <span className="pw-branch-kind">worktree</span>}
      </button>
      {open && (
        <div className="pw-menu up pw-checkout-menu">
          {!readOnly && (
            <>
              <button className="pw-menu-item" onClick={pick(() => store.setChangesOpen(true))}>
                <Icon.Branch /> <span className="pw-menu-label">Show changes</span>
              </button>
              <div className="pw-menu-sep" />
            </>
          )}
          <div className="pw-menu-head">Checkouts</div>
          {checkouts.map((c) => {
            const current = view.kind === 'checkout' && view.path === c.path
            return (
              <button key={c.path} className={`pw-menu-item pw-checkout ${current ? 'active' : ''}`} title={c.path} onClick={pick(() => !current && store.send({ t: 'openCheckout', checkout: c.path }))}>
                <span className="pw-checkout-text">
                  <span className="pw-checkout-branch">{c.branch ?? 'detached'}</span>
                  <span className="pw-checkout-path">{c.main ? 'main checkout' : `worktree · ${c.path.split('/').pop()}`}</span>
                </span>
                <span className="pw-menu-meta">{c.fileCount}</span>
              </button>
            )
          })}
          {branches.length > 0 && (
            <>
              <div className="pw-menu-sep" />
              <div className="pw-menu-head">Branches, as committed</div>
              {branches.map((b) => {
                const current = view.kind === 'branch' && view.branch === b
                return (
                  <button key={b} className={`pw-menu-item pw-checkout ${current ? 'active' : ''}`} onClick={pick(() => !current && store.send({ t: 'openBranch', branch: b }))}>
                    <span className="pw-checkout-text">
                      <span className="pw-checkout-branch">{b}</span>
                    </span>
                    <span className="pw-menu-meta">read-only</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---- changes ------------------------------------------------------------------------

type Mode = 'side' | 'swipe' | 'diff'

export function ChangesView() {
  const open = useStore((s) => s.changesOpen)
  return open ? <Changes /> : null
}

function Changes() {
  const fileId = useStore((s) => s.doc?.id)
  const repo = useStore((s) => s.repo)
  const [commits, setCommits] = useState<RepoCommit[] | null>(null)
  const [target, setTarget] = useState('working')
  const [result, setResult] = useState<RepoCompare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return (localStorage.getItem('paperish:changesMode') as Mode) || 'side'
    } catch {
      return 'side'
    }
  })
  const pickMode = (m: Mode) => {
    setMode(m)
    try {
      localStorage.setItem('paperish:changesMode', m)
    } catch {}
  }

  useEffect(() => {
    if (!fileId) return
    fetch(`/api/repo/history?file=${fileId}`)
      .then((r) => r.json())
      .then((res: { commits?: RepoCommit[]; error?: string }) => (res.error ? setError(res.error) : setCommits(res.commits ?? [])))
      .catch(() => setError('Couldn’t read the history.'))
  }, [fileId, repo?.state, nonce])

  useEffect(() => {
    if (!fileId) return
    let live = true
    setResult(null)
    setError(null)
    fetch(`/api/repo/compare?file=${fileId}&commit=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((res: RepoCompare & { error?: string }) => live && (res.error ? setError(res.error) : setResult(res)))
      .catch(() => live && setError('Comparing failed.'))
    return () => {
      live = false
    }
  }, [fileId, target, nonce])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.setChangesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!repo) {
    return (
      <div className="pw-changes">
        <ChangesBar repo={null} onRefresh={() => {}} mode={mode} setMode={pickMode} />
        <div className="pw-empty pw-changes-empty">This file isn’t saved in a repo.</div>
      </div>
    )
  }

  const visible = result?.changes.filter((c) => c.status !== 'unchanged') ?? []
  const unchanged = result?.changes.filter((c) => c.status === 'unchanged') ?? []
  const workingDirty = repo.state === 'modified' || repo.state === 'untracked'

  return (
    <div className="pw-changes" role="dialog" aria-label="Changes">
      <ChangesBar repo={repo} onRefresh={() => setNonce((n) => n + 1)} mode={mode} setMode={pickMode} />
      <div className="pw-changes-body">
        <nav className="pw-changes-list" aria-label="Versions">
          <button className={`pw-version ${target === 'working' ? 'active' : ''}`} onClick={() => setTarget('working')}>
            <span className="pw-version-title">
              <span className={`pw-repo-dot ${repo.state}`} />
              {workingDirty ? 'Uncommitted changes' : 'Working copy'}
            </span>
            <span className="pw-version-meta">{workingDirty ? `vs ${commits?.[0]?.short ?? 'nothing yet'}` : 'same as the last commit'}</span>
          </button>
          {commits?.map((c) => (
            <button key={c.sha} className={`pw-version ${target === c.sha ? 'active' : ''}`} onClick={() => setTarget(c.sha)} title={`${c.sha}\n${c.author}, ${new Date(c.date).toLocaleString()}`}>
              <span className="pw-version-title">{c.subject}</span>
              <span className="pw-version-meta">
                <code>{c.short}</code> · {c.author} · {ago(c.date)}
              </span>
            </button>
          ))}
          {commits && !commits.length && repo.state !== 'unversioned' && <div className="pw-empty pw-pad">No commits of this file yet.</div>}
        </nav>
        <main className="pw-changes-main">
          {error && <div className="pw-error-box">{error}</div>}
          {!result && !error && (
            <div className="pw-empty pw-changes-empty">
              <span className="pw-spinner" /> Rendering both versions…
            </div>
          )}
          {result && (
            <>
              <div className="pw-changes-summary">
                <strong>{result.to ? result.to.subject : 'Working copy'}</strong>
                <span className="pw-muted">
                  {result.from ? (
                    <>
                      compared with <code>{result.from.short}</code>
                    </>
                  ) : (
                    'first version'
                  )}
                  {' · '}
                  {summarize(result.changes)}
                </span>
              </div>
              {result.notes.map((n) => (
                <p key={n} className="pw-changes-note">
                  {n}
                </p>
              ))}
              {!visible.length && <div className="pw-empty pw-changes-empty">No visual changes.</div>}
              {visible.map((c) => (
                <ChangeCard key={c.id} change={c} mode={mode} live={target === 'working'} />
              ))}
              {unchanged.length > 0 && (
                <div className="pw-unchanged">
                  <span className="pw-muted">Unchanged</span> {unchanged.map((c) => c.name + (c.moved ? ' (moved)' : '')).join(', ')}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function ChangesBar({ repo, onRefresh, mode, setMode }: { repo: RepoState | null; onRefresh: () => void; mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <header className="pw-viewer-bar">
      <div className="pw-viewer-left">
        <button className="pw-viewer-btn" title="Close (Esc)" onClick={() => store.setChangesOpen(false)}>
          <Icon.Close />
        </button>
        <span className="pw-changes-title">Changes</span>
        {repo && (
          <span className="pw-changes-path" title={repo.path}>
            {repo.branch && (
              <>
                <Icon.Branch /> {repo.branch} ·{' '}
              </>
            )}
            <code>{repo.rel}</code>
          </span>
        )}
      </div>
      <div className="pw-viewer-center">
        <div className="pw-seg-light" role="group" aria-label="Comparison">
          {(
            [
              ['side', 'Side by side'],
              ['swipe', 'Swipe'],
              ['diff', 'Heatmap'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="pw-viewer-right">
        <button className="pw-btn pw-changes-refresh" onClick={onRefresh} title="Compare again">
          Refresh
        </button>
      </div>
    </header>
  )
}

function ChangeCard({ change: c, mode, live }: { change: ArtboardChange; mode: Mode; live: boolean }) {
  const canJump = live && c.status !== 'removed' && !!store.node(c.id)
  const jump = () => {
    // Artboards sit directly under their page's root.
    const page = store.doc?.pages.find((p) => p.rootId === store.node(c.id)?.parent)
    store.setChangesOpen(false)
    if (page && page.id !== store.pageId) store.setPage(page.id)
    store.select([c.id])
    requestAnimationFrame(() => zoomToFit([c.id]))
  }
  return (
    <article className={`pw-change ${c.status}`}>
      <header className="pw-change-head">
        <span className={`pw-change-status ${c.status}`}>{c.status}</span>
        {canJump ? (
          <button className="pw-change-name" onClick={jump} title="Show on the canvas">
            {c.name}
          </button>
        ) : (
          <span className="pw-change-name">{c.name}</span>
        )}
        <span className="pw-muted">{c.pageName}</span>
        {c.moved && <span className="pw-muted">· moved</span>}
        {c.contentScore !== undefined && (
          <span className="pw-change-score" title="Share of non-background pixels that still match">
            {Math.round(c.contentScore * 1000) / 10}% match
          </span>
        )}
      </header>
      {c.status === 'changed' && c.before && c.after ? (
        mode === 'side' ? (
          <div className="pw-change-pair">
            <figure>
              <figcaption>Before</figcaption>
              <img src={c.before} alt={`${c.name} before`} />
            </figure>
            <figure>
              <figcaption>After</figcaption>
              <img src={c.after} alt={`${c.name} after`} />
            </figure>
          </div>
        ) : mode === 'swipe' ? (
          <Swipe before={c.before} after={c.after} name={c.name} />
        ) : (
          <figure className="pw-change-single">
            <figcaption>Differences in red</figcaption>
            <img src={c.heat} alt={`${c.name} differences`} />
          </figure>
        )
      ) : c.after || c.before ? (
        <figure className="pw-change-single">
          <img src={c.after ?? c.before} alt={c.name} />
        </figure>
      ) : (
        <div className="pw-empty">No preview.</div>
      )}
    </article>
  )
}

/** Before under after; the divider follows the pointer. */
function Swipe({ before, after, name }: { before: string; after: string; name: string }) {
  const [pos, setPos] = useState(50)
  const ref = useRef<HTMLDivElement>(null)
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)))
  }
  return (
    <figure className="pw-change-single">
      <figcaption>
        <span>Before</span>
        <span>After</span>
      </figcaption>
      <div className="pw-swipe" ref={ref} onPointerMove={move} onPointerDown={move}>
        <img src={after} alt={`${name} after`} />
        <img className="pw-swipe-before" src={before} alt={`${name} before`} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
        <span className="pw-swipe-line" style={{ left: `${pos}%` }} />
      </div>
    </figure>
  )
}

function summarize(changes: ArtboardChange[]): string {
  const n = (s: ArtboardChange['status']) => changes.filter((c) => c.status === s).length
  const parts = [
    n('changed') && `${n('changed')} changed`,
    n('added') && `${n('added')} added`,
    n('removed') && `${n('removed')} removed`,
    n('unchanged') && `${n('unchanged')} unchanged`,
  ].filter(Boolean)
  return parts.join(', ') || 'no artboards'
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
