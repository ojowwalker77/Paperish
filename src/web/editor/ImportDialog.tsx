import { useState } from 'react'
import { store, useStore } from '../store'
import { Icon } from './icons'

const WIDTHS = [
  { w: 1440, label: 'Desktop' },
  { w: 1280, label: 'Laptop' },
  { w: 768, label: 'Tablet' },
  { w: 390, label: 'Mobile' },
]

export function ImportDialog() {
  const open = useStore((s) => s.importOpen)
  const [url, setUrl] = useState('')
  const [width, setWidth] = useState(1440)
  if (!open) return null
  const submit = () => url.trim() && store.importUrl(url.trim(), width)
  return (
    <div className="pw-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && store.setImportOpen(false)}>
      <div className="pw-modal" role="dialog" aria-label="Import a web page" onKeyDown={(e) => e.stopPropagation()}>
        <header className="pw-modal-head">
          <Icon.Globe size={16} />
          <span>Import a web page</span>
        </header>
        <p className="pw-modal-text">Loads the page in a headless browser and rebuilds it as editable layers — real CSS, fluid sizing, images and web fonts copied into Paperish.</p>
        <input
          className="pw-modal-input"
          autoFocus
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') store.setImportOpen(false)
          }}
        />
        <div className="pw-modal-row">
          <span className="pw-muted">Viewport</span>
          <div className="pw-seg-light">
            {WIDTHS.map((o) => (
              <button key={o.w} className={o.w === width ? 'active' : ''} onClick={() => setWidth(o.w)} title={`${o.w}px`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <footer className="pw-modal-foot">
          <button className="pw-btn" onClick={() => store.setImportOpen(false)}>
            Cancel
          </button>
          <button className="pw-btn primary" disabled={!url.trim()} onClick={submit}>
            Import
          </button>
        </footer>
      </div>
    </div>
  )
}

export function TaskPill() {
  const tasks = useStore((s) => s.tasks)
  const t = tasks[tasks.length - 1]
  if (!t) return null
  return (
    <span className={`pw-task ${t.status}`} title={t.message ?? t.label}>
      {t.status === 'running' ? <span className="pw-spinner" /> : t.status === 'done' ? '✓' : '!'}
      <span className="pw-task-label">{t.status === 'running' ? t.label : t.status === 'done' ? `${t.label} — ${t.message ?? ''}` : `Import failed: ${t.message}`}</span>
      {t.status === 'running' && (
        <span className="pw-task-bar">
          <span style={{ width: `${t.pct}%` }} />
        </span>
      )}
    </span>
  )
}
