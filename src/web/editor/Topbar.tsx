import { useEffect, useRef, useState } from 'react'
import { store, useStore, type Tool } from '../store'
import { openPreview } from './actions'
import { Icon } from './icons'
import { InlineInput } from './InlineInput'

const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: <Icon.Move /> },
  { id: 'frame', label: 'Frame', key: 'F', icon: <Icon.Frame size={16} /> },
  { id: 'text', label: 'Text', key: 'T', icon: <Icon.Text size={16} /> },
  { id: 'hand', label: 'Hand', key: 'H', icon: <Icon.Hand /> },
]

export function Topbar() {
  const tool = useStore((s) => s.tool)
  const hasFrames = useStore((s) => !!(s.page && s.doc?.nodes[s.page.rootId]?.children.length))
  const project = useStore((s) => s.projectInfo?.name)

  return (
    <header className="pw-topbar">
      <div className="pw-topbar-left">
        <FileMenu />
        <PageMenu />
      </div>

      <button className="pw-command" title="Find anything, run anything (⌘K)" onClick={() => store.openPalette()}>
        <Icon.Search size={13} />
        <span>{project ? `Search ${project}` : 'Search'}</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="pw-topbar-right">
        <div className="pw-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`pw-tool ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key})`} aria-pressed={tool === t.id} onClick={() => store.setTool(t.id)}>
              {t.icon}
            </button>
          ))}
        </div>
        <button className="pw-preview-btn" title="Preview frame as a full page (P)" disabled={!hasFrames} onClick={openPreview}>
          Preview
        </button>
      </div>
    </header>
  )
}

/** The page part of the breadcrumb: switch, add or rename (double-click) pages. */
function PageMenu() {
  const pages = useStore((s) => s.doc?.pages) ?? []
  const pageId = useStore((s) => s.pageId)
  const page = pages.find((p) => p.id === pageId)
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false))
  if (!page) return null
  return (
    <div className="pw-file-menu" ref={ref}>
      {renaming ? (
        <InlineInput
          value={page.name}
          onDone={(v) => {
            setRenaming(false)
            if (v && v !== page.name) store.tx([{ t: 'page:rename', pageId: page.id, name: v }], 'rename page')
          }}
        />
      ) : (
        <button className="pw-crumb-btn" onClick={() => setOpen(!open)} onDoubleClick={() => setRenaming(true)} title="Pages (double-click to rename)">
          <span className="pw-crumb-sep">/</span>
          {page.name}
        </button>
      )}
      {open && (
        <div className="pw-menu">
          {pages.map((p) => (
            <button
              key={p.id}
              className={`pw-menu-item ${p.id === pageId ? 'active' : ''}`}
              onClick={() => {
                setOpen(false)
                if (p.id !== pageId) store.setPage(p.id)
              }}
            >
              <span className="pw-menu-label">{p.name}</span>
            </button>
          ))}
          <div className="pw-menu-sep" />
          <button
            className="pw-menu-item"
            onClick={() => {
              setOpen(false)
              store.send({ t: 'createPage' })
            }}
          >
            <Icon.Plus /> <span className="pw-menu-label">New page</span>
          </button>
        </div>
      )}
    </div>
  )
}

function FileMenu() {
  const doc = useStore((s) => (s.doc ? { id: s.doc.id, name: s.doc.name } : null), (a, b) => a?.id === b?.id && a?.name === b?.name)
  const files = useStore((s) => s.files)
  const projectName = useStore((s) => s.projectInfo?.name)
  const inGit = useStore((s) => !!s.repo?.root)
  const readOnly = useStore((s) => s.view?.kind === 'branch')
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => {
    setOpen(false)
    setConfirming(null)
  })
  if (!doc) return <span className="pw-file-name">Loading…</span>
  return (
    <div className="pw-file-menu" ref={ref}>
      {renaming ? (
        <InlineInput
          value={doc.name}
          onDone={(v) => {
            setRenaming(false)
            if (v && v !== doc.name) store.tx([{ t: 'doc:rename', name: v }], 'rename file')
          }}
        />
      ) : (
        <button className="pw-file-name" onClick={() => setOpen(!open)} onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
          {projectName && (
            <>
              <span className="pw-file-project">{projectName}</span>
              <span className="pw-crumb-sep">/</span>
            </>
          )}
          <span className="pw-file-title">{doc.name}</span>
        </button>
      )}
      {open && (
        <div className="pw-menu">
          {!readOnly && (
            <button
              className="pw-menu-item strong"
              onClick={() => {
                setOpen(false)
                store.send({ t: 'createFile' })
              }}
            >
              <Icon.Plus /> New file
            </button>
          )}
          {inGit && (
            <button
              className="pw-menu-item"
              onClick={() => {
                setOpen(false)
                store.setChangesOpen(true)
              }}
            >
              <Icon.Branch /> <span className="pw-menu-label">Show changes</span>
            </button>
          )}
          <div className="pw-menu-sep" />
          {files.map((f) =>
            confirming === f.id ? (
              <div key={f.id} className="pw-menu-item pw-file-confirm">
                <span className="pw-menu-label">Delete “{f.name}”?</span>
                <button className="pw-file-cancel" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
                <button
                  className="pw-file-delete"
                  autoFocus
                  onClick={() => {
                    setConfirming(null)
                    store.send({ t: 'deleteFile', fileId: f.id })
                  }}
                >
                  Delete
                </button>
              </div>
            ) : (
              <div key={f.id} className={`pw-menu-item pw-file-row ${f.id === doc.id ? 'active' : ''}`}>
                <button
                  className="pw-file-open"
                  onClick={() => {
                    setOpen(false)
                    if (f.id === doc.id) return
                    if (f.ref) store.send({ t: 'openBranch', branch: f.ref.branch, rel: f.ref.rel })
                    else store.send({ t: 'open', fileId: f.id })
                  }}
                >
                  <span className="pw-file-icon" title={f.source}>
                    <Icon.File />
                  </span>
                  <span className="pw-menu-label">{f.name}</span>
                  <span className="pw-menu-meta">{f.updatedAt ? timeAgo(f.updatedAt) : ''}</span>
                </button>
                {!f.ref && (
                  <button className="pw-file-trash" title="Delete file" aria-label={`Delete ${f.name}`} onClick={() => setConfirming(f.id)}>
                    <Icon.Trash />
                  </button>
                )}
              </div>
            ),
          )}
          <div className="pw-menu-sep" />
          <button
            className="pw-menu-item"
            onClick={() => {
              setOpen(false)
              store.send({ t: 'home' })
            }}
          >
            <Icon.ChevronLeft /> <span className="pw-menu-label">All projects</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function useOutside(ref: React.RefObject<HTMLElement | null>, fn: () => void) {
  useEffect(() => {
    const h = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && fn()
    window.addEventListener('pointerdown', h)
    return () => window.removeEventListener('pointerdown', h)
  })
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
