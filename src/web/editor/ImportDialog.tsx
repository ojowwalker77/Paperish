import { useState, type ReactNode } from 'react'
import { store, useStore, type ImportSource } from '../store'
import { Icon } from './icons'

const WIDTHS = [
  { w: 1440, label: 'Desktop' },
  { w: 1280, label: 'Laptop' },
  { w: 768, label: 'Tablet' },
  { w: 390, label: 'Mobile' },
]

interface SourceDef {
  id: ImportSource
  label: string
  title: string
  icon: ReactNode
  panel: ReactNode
}

const SOURCES: SourceDef[] = [
  {
    id: 'url',
    label: 'Web page',
    title: 'Import a web page',
    icon: <Icon.Globe size={16} />,
    panel: <WebPanel />,
  },
  {
    id: 'figma',
    label: 'Figma',
    title: 'Import a Figma frame',
    icon: <Icon.Frame size={16} />,
    panel: <FigmaPanel />,
  },
]

export function ImportDialog() {
  const source = useStore((s) => s.importSource)
  const def = SOURCES.find((s) => s.id === source)

  if (!def) return null

  return (
    <div
      className="pw-modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && store.setImport(null)}
    >
      <div
        className="pw-modal"
        role="dialog"
        aria-label={def.title}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Escape') store.setImport(null)
        }}
      >
        <header className="pw-modal-head">
          {def.icon}
          <span>{def.title}</span>
        </header>
        {SOURCES.length > 1 && (
          <div className="pw-seg-light">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={s.id === source ? 'active' : ''}
                onClick={() => store.setImport(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {def.panel}
      </div>
    </div>
  )
}

function ImportFooter({ disabled, onSubmit }: { disabled: boolean; onSubmit: () => void }) {
  return (
    <footer className="pw-modal-foot">
      <button className="pw-btn" onClick={() => store.setImport(null)}>
        Cancel
      </button>
      <button className="pw-btn primary" disabled={disabled} onClick={onSubmit}>
        Import
      </button>
    </footer>
  )
}

function WebPanel() {
  const [url, setUrl] = useState('')
  const [width, setWidth] = useState(1440)
  const submit = () => url.trim() && store.startImport({ t: 'importUrl', url: url.trim(), width })

  return (
    <>
      <p className="pw-modal-text">
        Loads the page in a headless browser and rebuilds it as editable layers — real CSS, fluid
        sizing, images and web fonts copied into Paperish.
      </p>
      <input
        className="pw-modal-input"
        autoFocus
        placeholder="https://example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <div className="pw-modal-row">
        <span className="pw-muted">Viewport</span>
        <div className="pw-seg-light">
          {WIDTHS.map((o) => (
            <button
              key={o.w}
              className={o.w === width ? 'active' : ''}
              onClick={() => setWidth(o.w)}
              title={`${o.w}px`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <ImportFooter disabled={!url.trim()} onSubmit={submit} />
    </>
  )
}

function FigmaPanel() {
  const saved = useStore((s) => !!s.settings?.figma)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const ready = !!url.trim() && (saved || !!token.trim())

  const submit = () => {
    if (!ready) return

    if (token.trim()) store.saveSettings({ figmaToken: token.trim() })
    store.startImport({ t: 'importFigma', url: url.trim() })
  }

  return (
    <>
      <p className="pw-modal-text">
        Rebuilds a frame through Figma's API: auto layout becomes flex, text keeps its styles,
        vectors come in as SVG and images are copied into Paperish.
        {!saved &&
          ' It needs a personal access token (Figma → Settings → Security) that can read file content. The token stays on this machine.'}
      </p>
      <input
        className="pw-modal-input"
        autoFocus
        placeholder="Link to a frame (Copy link to selection)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        className="pw-modal-input"
        type="password"
        spellCheck={false}
        placeholder={
          saved ? 'Token saved. Paste a new one to replace it' : 'Personal access token (figd_…)'
        }
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <ImportFooter disabled={!ready} onSubmit={submit} />
    </>
  )
}

export function TaskPill() {
  const tasks = useStore((s) => s.tasks)
  const t = tasks[tasks.length - 1]

  if (!t) return null

  return (
    <span className={`pw-task ${t.status}`} title={t.message ?? t.label}>
      {t.status === 'running' ? <span className="pw-spinner" /> : t.status === 'done' ? '✓' : '!'}
      <span className="pw-task-label">
        {t.status === 'running'
          ? t.label
          : t.status === 'done'
            ? `${t.label} — ${t.message ?? ''}`
            : `Import failed: ${t.message}`}
      </span>
      {t.status === 'running' && (
        <span className="pw-task-bar">
          <span style={{ width: `${t.pct}%` }} />
        </span>
      )}
    </span>
  )
}
