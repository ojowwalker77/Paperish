import { useEffect, type CSSProperties } from 'react'
import { store, useStore, type Tool } from '../store'
import { openPreview } from './actions'
import { Icon } from './icons'

const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: <Icon.Move /> },
  { id: 'frame', label: 'Frame', key: 'F', icon: <Icon.Frame size={16} /> },
  { id: 'text', label: 'Text', key: 'T', icon: <Icon.Text size={16} /> },
  { id: 'hand', label: 'Hand', key: 'H', icon: <Icon.Hand /> },
  { id: 'comment', label: 'Comment', key: 'C', icon: <Icon.Comment size={16} /> },
]

export function Topbar() {
  const tool = useStore((s) => s.tool)
  const hasFrames = useStore((s) => !!(s.page && s.doc?.nodes[s.page.rootId]?.children.length))
  const project = useStore((s) => s.projectInfo?.name)
  const navOpen = useStore((s) => s.navOpen)

  return (
    <header className="pw-topbar">
      <div className="pw-topbar-left">
        <button
          className={`pw-icon-btn ${navOpen ? 'on' : ''}`}
          title={'Navigator (⌘\\)'}
          aria-pressed={navOpen}
          onClick={() => store.setNavOpen(!navOpen)}
        >
          <Icon.PanelLeft />
        </button>
        <Title />
      </div>

      <button
        className="pw-command"
        title="Find anything, run anything (⌘K)"
        onClick={() => store.openPalette()}
      >
        <Icon.Search size={13} />
        <span>{project ? `Search ${project}` : 'Search'}</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="pw-topbar-right">
        <UpdateButton />
        <div className="pw-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`pw-tool ${tool === t.id ? 'active' : ''}`}
              title={`${t.label} (${t.key})`}
              aria-pressed={tool === t.id}
              onClick={() => store.setTool(t.id)}
            >
              {t.icon}
            </button>
          ))}
        </div>
        <button
          className="pw-preview-btn"
          title="Preview frame as a full page (P)"
          disabled={!hasFrames}
          onClick={openPreview}
        >
          Preview
        </button>
      </div>
    </header>
  )
}

/** The open file and page; the navigator switches them. */
function Title() {
  const file = useStore((s) => s.doc?.name)
  const page = useStore((s) => s.page?.name)

  if (!file) return <span className="pw-nav-title">Loading…</span>

  return (
    <button className="pw-nav-title" onClick={() => store.setNavOpen(!store.navOpen)}>
      <span className="pw-file-title">{file}</span>
      {page && (
        <>
          <span className="pw-crumb-sep">/</span>
          <span className="pw-nav-title-page">{page}</span>
        </>
      )}
    </button>
  )
}

/** A new version's download, then the restart that installs it. */
export function UpdateButton() {
  const update = useStore((s) => s.update)

  if (!update) return null

  // SAFETY: the download's progress as a custom property; React passes --* through to CSS.
  const progress = { '--p': `${update.percent}%` } as CSSProperties

  if (!update.ready)
    return (
      <span
        className="pw-update-progress"
        title={`Downloading Paperish ${update.version}`}
        style={progress}
      >
        Updating {update.percent}%
      </span>
    )

  return (
    <button
      className="pw-update-btn"
      title={`Paperish ${update.version} is ready. Restart to install it.`}
      onClick={() => store.send({ t: 'installUpdate' })}
    >
      Restart to update
    </button>
  )
}

export function useOutside(ref: React.RefObject<HTMLElement | null>, fn: () => void) {
  useEffect(() => {
    // SAFETY: pointerdown target for outside-click is a node; contains checks menu membership.
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
