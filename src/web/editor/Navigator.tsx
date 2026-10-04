import { useRef, useState } from 'react'
import type { FileSummary, Page } from '../../shared/types'
import { artboardOf } from '../../shared/ops'
import { viewsOf, type View } from '../../shared/views'
import { shallow, store, useStore } from '../store'
import { Icon } from './icons'
import { InlineInput } from './InlineInput'
import { timeAgo, useOutside } from './Topbar'
import { focusBoard, unfocus } from './views'

// Where you are, as one tree over the canvas (⌘\): the project and its branch
// on top, then its files, the open one with its pages as folders of views.

export function Navigator() {
  const open = useStore((s) => s.navOpen)
  const inGit = useStore((s) => !!s.repo?.root)

  if (!open) return null

  return (
    <aside className="pw-nav" aria-label="Navigator">
      <ProjectSwitcher />
      <Files />
      {inGit && (
        <div className="pw-nav-foot">
          <button className="pw-nav-row" onClick={() => store.setChangesOpen(true)}>
            <Icon.Branch />
            <span className="pw-menu-label">Show changes</span>
          </button>
        </div>
      )}
    </aside>
  )
}

function ProjectSwitcher() {
  const info = useStore((s) => s.projectInfo)
  const projects = useStore((s) => s.projects)
  const view = useStore((s) => s.view)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false))

  if (!info) return null

  const where = info.scratch
    ? 'Designs outside any repo'
    : info.root.replace(/^\/Users\/[^/]+/, '~')

  const branch = view?.kind === 'branch' ? `${view.branch}, read-only` : view?.branch

  const go = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="pw-file-menu" ref={ref}>
      <button
        className="pw-nav-project"
        onClick={() => {
          if (!open) store.send({ t: 'projects' })
          setOpen(!open)
        }}
      >
        <span className="pw-nav-mark">{info.name.slice(0, 1).toUpperCase()}</span>
        <span className="pw-nav-project-text">
          <strong>{info.name}</strong>
          <span>
            {branch && (
              <>
                <Icon.Branch size={11} /> {branch} ·{' '}
              </>
            )}
            {where}
          </span>
        </span>
        <span className="pw-chev">▼</span>
      </button>
      {open && (
        <div className="pw-menu">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`pw-menu-item ${p.id === info.id ? 'active' : ''}`}
              onClick={go(
                () => p.id !== info.id && store.send({ t: 'openProject', projectId: p.id }),
              )}
            >
              {p.scratch ? <Icon.File /> : <Icon.Folder />}
              <span className="pw-menu-label">{p.name}</span>
            </button>
          ))}
          <div className="pw-menu-sep" />
          <button className="pw-menu-item" onClick={go(() => store.send({ t: 'addProject' }))}>
            <Icon.Plus /> <span className="pw-menu-label">Add project…</span>
          </button>
          <button className="pw-menu-item" onClick={go(() => store.send({ t: 'home' }))}>
            <Icon.ChevronLeft /> <span className="pw-menu-label">All projects</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Files() {
  const files = useStore((s) => s.files)
  const docId = useStore((s) => s.doc?.id)
  const readOnly = useStore((s) => s.view?.kind === 'branch')

  return (
    <div className="pw-nav-list">
      <div className="pw-nav-head">
        Files
        {!readOnly && (
          <button
            className="pw-nav-add"
            title="New file"
            aria-label="New file"
            onClick={() => store.send({ t: 'createFile' })}
          >
            <Icon.Plus size={12} />
          </button>
        )}
      </div>
      {files.map((f) =>
        f.id === docId ? <OpenFile key={f.id} file={f} /> : <FileRow key={f.id} file={f} />,
      )}
    </div>
  )
}

const openFile = (f: FileSummary) =>
  f.ref
    ? store.send({ t: 'openBranch', branch: f.ref.branch, rel: f.ref.rel })
    : store.send({ t: 'open', fileId: f.id })

function FileRow({ file: f }: { file: FileSummary }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming)
    return (
      <Confirm
        label={f.name}
        onCancel={() => setConfirming(false)}
        onDelete={() => store.send({ t: 'deleteFile', fileId: f.id })}
      />
    )

  return (
    <div className="pw-nav-row pw-file-row">
      <button className="pw-file-open" onClick={() => openFile(f)} title={f.source}>
        <span className="pw-nav-twisty">
          <Icon.Chevron size={9} />
        </span>
        <span className="pw-menu-label">{f.name}</span>
        <span className="pw-menu-meta">{f.updatedAt ? timeAgo(f.updatedAt) : ''}</span>
      </button>
      {!f.ref && (
        <button
          className="pw-file-trash"
          title="Delete file"
          aria-label={`Delete ${f.name}`}
          onClick={() => setConfirming(true)}
        >
          <Icon.Trash />
        </button>
      )}
    </div>
  )
}

/** The open file, with its pages under it. */
function OpenFile({ file: f }: { file: FileSummary }) {
  const name = useStore((s) => s.doc?.name ?? f.name)
  const pages = useStore((s) => s.doc?.pages) ?? []
  const readOnly = useStore((s) => s.view?.kind === 'branch')
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const rename = (v: string) => {
    setRenaming(false)

    if (v && v !== name) store.tx([{ t: 'doc:rename', name: v }], 'rename file')
  }

  return (
    <>
      {confirming ? (
        <Confirm
          label={name}
          onCancel={() => setConfirming(false)}
          onDelete={() => store.send({ t: 'deleteFile', fileId: f.id })}
        />
      ) : (
        <div className="pw-nav-row pw-file-row open">
          <span className="pw-nav-twisty down">
            <Icon.Chevron size={9} />
          </span>
          {renaming ? (
            <InlineInput value={name} onDone={rename} />
          ) : (
            <span
              className="pw-menu-label"
              title={readOnly ? f.source : `${f.source}\nDouble-click to rename`}
              onDoubleClick={() => !readOnly && setRenaming(true)}
            >
              {name}
            </span>
          )}
          {!readOnly && !renaming && (
            <>
              <button
                className="pw-file-trash pw-file-rename"
                title="Rename file"
                aria-label={`Rename ${name}`}
                onClick={() => setRenaming(true)}
              >
                <Icon.Edit size={13} />
              </button>
              <button
                className="pw-file-trash"
                title="Delete file"
                aria-label={`Delete ${name}`}
                onClick={() => setConfirming(true)}
              >
                <Icon.Trash />
              </button>
            </>
          )}
        </div>
      )}
      {pages.map((p) => (
        <PageRow key={p.id} page={p} last={pages.length === 1} readOnly={readOnly} />
      ))}
      {!readOnly && (
        <button
          className="pw-nav-row pw-nav-page faint"
          onClick={() => store.send({ t: 'createPage' })}
        >
          <Icon.Plus size={12} />
          <span className="pw-menu-label">New page</span>
        </button>
      )}
    </>
  )
}

function PageRow({ page: p, last, readOnly }: { page: Page; last: boolean; readOnly: boolean }) {
  const active = useStore((s) => s.pageId === p.id)
  const focused = useStore((s) => !!s.focus)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(active)
  const views = useStore((s) => (s.doc ? viewsOf(s.doc, p) : []), sameViews)

  if (confirming)
    return (
      <Confirm
        label={p.name}
        onCancel={() => setConfirming(false)}
        onDelete={() => {
          setConfirming(false)

          if (active) store.setPage(store.doc!.pages.find((x) => x.id !== p.id)!.id)
          store.tx([{ t: 'page:remove', pageId: p.id }], 'delete page')
        }}
      />
    )

  if (renaming)
    return (
      <div className="pw-nav-row pw-nav-page">
        <InlineInput
          value={p.name}
          onDone={(v) => {
            setRenaming(false)

            if (v && v !== p.name)
              store.tx([{ t: 'page:rename', pageId: p.id, name: v }], 'rename page')
          }}
        />
      </div>
    )

  return (
    <>
      <div className={`pw-nav-row pw-nav-page pw-file-row ${active && !focused ? 'active' : ''}`}>
        <button
          className="pw-file-open"
          onClick={() => {
            setOpen(true)

            if (active) unfocus()
            else store.setPage(p.id)
          }}
          onDoubleClick={() => !readOnly && setRenaming(true)}
        >
          <span
            className={`pw-nav-twisty ${open ? 'down' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
          >
            <Icon.Chevron size={9} />
          </span>
          <span className="pw-menu-label">{p.name}</span>
        </button>
        {!readOnly && (
          <button
            className="pw-file-trash pw-file-rename"
            title="Rename page"
            aria-label={`Rename ${p.name}`}
            onClick={() => setRenaming(true)}
          >
            <Icon.Edit size={13} />
          </button>
        )}
        {!readOnly && !last && (
          <button
            className="pw-file-trash"
            title="Delete page"
            aria-label={`Delete ${p.name}`}
            onClick={() => setConfirming(true)}
          >
            <Icon.Trash />
          </button>
        )}
      </div>
      {open && views.length > 0 && (
        <div className="pw-nav-views">
          {views.map((v) => (
            <ViewRow key={v.versions[0]} view={v} page={p} />
          ))}
        </div>
      )}
    </>
  )
}

function ViewRow({ view, page }: { view: View; page: Page }) {
  const focused = useStore((s) => !!s.focus && view.versions.includes(s.focus))

  const agent = useStore((s) =>
    s.working.some((id) => {
      const board = s.doc && artboardOf(s.doc.nodes, id)

      return !!board && view.versions.includes(board.id)
    }),
  )

  const count = view.versions.length

  return (
    <button
      className={`pw-nav-row pw-nav-view ${focused ? 'active' : ''}`}
      onClick={() => focusBoard(view.latest, page.id)}
    >
      <span className="pw-menu-label">{view.name}</span>
      {agent && <span className="pw-nav-agent" />}
      {count > 1 && <span className="pw-nav-version">v{count}</span>}
    </button>
  )
}

function Confirm(props: { label: string; onCancel: () => void; onDelete: () => void }) {
  return (
    <div className="pw-nav-row pw-file-confirm">
      <span className="pw-menu-label">Delete “{props.label}”?</span>
      <button className="pw-file-cancel" onClick={props.onCancel}>
        Cancel
      </button>
      <button className="pw-file-delete" autoFocus onClick={props.onDelete}>
        Delete
      </button>
    </div>
  )
}

function sameViews(a: View[], b: View[]): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => v.name === b[i].name && shallow(v.versions, b[i].versions))
  )
}
