import { useRef, useState } from 'react'
import type { Token } from '../../shared/types'
import { shallow, store, useCamera, useStore } from '../store'
import { pathTo, reveal, zoomTo, zoomToFit } from './actions'
import { Icon } from './icons'
import { resolveToken } from './Inspector'
import { DesignStatus } from './DesignChecks'
import { TaskPill } from './ImportDialog'
import { useWorldRects } from './measure'
import { BranchPicker } from './Repo'
import { useOutside } from './Topbar'

// The status bar, as in an IDE: where you are (checkout, branch, agents,
// problems) on the left; what you're looking at and the quick knobs
// (selection path and size, tokens, codebase, MCP, zoom) on the right.

export function StatusBar() {
  return (
    <footer className="pw-statusbar">
      <div className="pw-status-left">
        <BranchPicker />
        <DesignStatus />
        <AgentActivity />
        <TaskPill />
        <Problems />
      </div>
      <div className="pw-status-right">
        <SelectionPath />
        <Tokens />
        <Codebase />
        <Mcp />
        <ZoomMenu />
        <HelpMenu />
      </div>
    </footer>
  )
}

/** An agent editing this file, or another checkout of the project. */
function AgentActivity() {
  const working = useStore((s) => s.working.length)
  const elsewhere = useStore((s) => s.agentElsewhere)
  return (
    <>
      {working > 0 && (
        <span className="pw-status-item pw-status-agent" title="An agent is editing this file">
          <span className="pw-agent-dot" />
          Agent editing
        </span>
      )}
      {elsewhere && (
        <button className="pw-status-item pw-status-agent" title={elsewhere.checkout} onClick={() => store.send({ t: 'openCheckout', checkout: elsewhere.checkout })}>
          <span className="pw-agent-dot" />
          Agent in <code>{elsewhere.branch ?? elsewhere.checkout.split('/').pop()}</code>
          <span className="pw-status-link">View</span>
        </button>
      )}
    </>
  )
}

function Problems() {
  const connected = useStore((s) => s.connected)
  const error = useStore((s) => s.error)
  if (!connected) return <span className="pw-status-item warn">Reconnecting…</span>
  if (error)
    return (
      <span className="pw-status-item error" title={error}>
        {error}
      </span>
    )
  return null
}

/** Where the selection sits (click a crumb to select it) and its size (click to inspect). */
function SelectionPath() {
  const ids = useStore((s) => s.selection, shallow)
  const nodes = useStore((s) => s.doc?.nodes)
  const inspecting = useStore((s) => s.inspectOpen)
  const rects = useWorldRects(ids.length === 1 ? ids : [])
  if (!ids.length || !nodes) return null
  const path = ids.length === 1 ? pathTo(ids[0]) : []
  const shown = path.length > 4 ? path.slice(-4) : path
  const r = ids.length === 1 ? rects[ids[0]] : undefined
  return (
    <>
      {ids.length === 1 && (
        <span className="pw-crumbs">
          {path.length > shown.length && <span className="pw-crumb-more">…</span>}
          {shown.map((id, i) => (
            <button
              key={id}
              className={`pw-crumb ${i === shown.length - 1 ? 'current' : ''}`}
              onClick={() => {
                store.select([id])
                reveal([id])
              }}
            >
              {nodes[id]?.name || nodes[id]?.type}
            </button>
          ))}
        </span>
      )}
      <button className={`pw-status-item mono ${inspecting ? 'on' : ''}`} title="Inspect (I)" onClick={() => store.setInspectOpen(!inspecting)}>
        {r ? `${Math.round(r.width)} × ${Math.round(r.height)}` : `${ids.length} selected`}
      </button>
    </>
  )
}

/** The document's design tokens, editable in place: change the accent or a radius and see it everywhere at once. */
function Tokens() {
  const tokens = useStore((s) => s.doc?.tokens)
  const readOnly = useStore((s) => s.view?.kind === 'branch')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false))
  if (!tokens?.length) return null
  const colors = tokens.filter((t) => t.type === 'color').slice(0, 4)
  const set = (name: string, value: string) => {
    const next = tokens.map((t) => (t.name === name ? { ...t, value } : t))
    store.tx([{ t: 'tokens', tokens: next }], `set ${name}`)
  }
  return (
    <div className="pw-file-menu" ref={ref}>
      <button className={`pw-status-item ${open ? 'on' : ''}`} title="Design tokens" onClick={() => setOpen(!open)}>
        {colors.length ? (
          <span className="pw-token-dots">
            {colors.map((t) => (
              <span key={t.name} style={{ background: resolveToken(String(t.value)) }} />
            ))}
          </span>
        ) : (
          <Icon.Component size={13} />
        )}
        Tokens
      </button>
      {open && (
        <div className="pw-menu up right pw-tokens-menu">
          {tokens.map((t) => (
            <TokenRow key={t.name} token={t} readOnly={readOnly} onSet={(v) => set(t.name, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

function TokenRow({ token: t, readOnly, onSet }: { token: Token; readOnly: boolean; onSet: (v: string) => void }) {
  const value = String(t.value)
  const resolved = resolveToken(value)
  const hex = /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : /^#[0-9a-f]{3}$/i.test(resolved) ? '#' + [...resolved.slice(1)].map((c) => c + c).join('') : null
  const commit = (v: string) => v.trim() && v.trim() !== value && onSet(v.trim())
  return (
    <label className="pw-token-row" title={t.description}>
      {t.type === 'color' ? (
        <span className="pw-token-swatch" style={{ background: resolved }}>
          {hex && !readOnly && <input type="color" value={hex} onChange={(e) => onSet(e.target.value)} />}
        </span>
      ) : (
        <span className="pw-token-type">{t.type.slice(0, 2)}</span>
      )}
      <span className="pw-token-name">{t.name.replace(/^--/, '')}</span>
      <input
        key={value}
        className="pw-token-input"
        defaultValue={value}
        readOnly={readOnly}
        spellCheck={false}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Nudge the number, keeping the unit: 12px → 13px (Shift: ±10).
            const m = e.currentTarget.value.match(/^(-?\d*\.?\d+)(.*)$/)
            if (!m) return
            e.preventDefault()
            const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
            const next = `${Math.round((parseFloat(m[1]) + step) * 100) / 100}${m[2]}`
            e.currentTarget.value = next
            onSet(next)
          }
        }}
      />
    </label>
  )
}

/** The linked codebase's component host: frameworks, Tailwind, components. Opens the Components tab. */
function Codebase() {
  const linked = useStore((s) => s.doc?.project?.root)
  const p = useStore((s) => s.project)
  if (!linked) return null
  const label =
    !p || p.status === 'starting'
      ? 'Starting codebase…'
      : p.status === 'error'
        ? 'Codebase error'
        : !p.components.length && !p.tailwind
          ? 'No components'
          : [p.frameworks.map((f) => (f === 'react' ? 'React' : 'Vue')).join(' + '), p.tailwind && `Tailwind ${p.tailwind.split('.')[0]}`, `${p.components.length} components`]
              .filter(Boolean)
              .join(' · ')
  return (
    <button
      className={`pw-status-item ${p?.status === 'error' ? 'error' : ''}`}
      title={p?.status === 'error' ? p.error : `${linked}\nInsert a component`}
      onClick={() => store.openPalette('Insert ')}
    >
      <Icon.Code size={13} /> {label}
    </button>
  )
}

/** This project's MCP endpoint; click to copy. */
function Mcp() {
  const info = useStore((s) => s.projectInfo)
  const [copied, setCopied] = useState(false)
  if (!info) return null
  const title = info.scratch
    ? `MCP endpoint for Scratch: ${info.mcp}\nClick to copy`
    : `MCP endpoint: ${info.mcp}\nClaude Code picks it up from the repo's .mcp.json. Click to copy.`
  return (
    <button
      className="pw-status-item"
      title={title}
      onClick={() => {
        void navigator.clipboard.writeText(info.mcp)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <Icon.Plug size={13} /> {copied ? 'Copied' : 'MCP'}
    </button>
  )
}

function ZoomMenu() {
  const zoom = useCamera((c) => Math.round(c.zoom * 100))
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false))
  const item = (label: string, hint: string, fn: () => void) => (
    <button
      className="pw-menu-item"
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      <span className="pw-menu-label">{label}</span>
      <span className="pw-menu-meta">{hint}</span>
    </button>
  )
  return (
    <div className="pw-file-menu" ref={ref}>
      <button className="pw-status-item pw-zoom" title="Zoom" onClick={() => setOpen(!open)}>
        {zoom}%
      </button>
      {open && (
        <div className="pw-menu up right">
          {item('Zoom to fit', '⇧1', () => zoomToFit())}
          {item('Zoom to selection', '⇧2', () => zoomToFit(store.selection))}
          <div className="pw-menu-sep" />
          {item('50%', '', () => zoomTo(0.5))}
          {item('100%', '⌘0', () => zoomTo(1))}
          {item('200%', '', () => zoomTo(2))}
        </div>
      )}
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Find anything, run anything'],
  ['V  F  T  H', 'Move, frame, text, hand'],
  ['Space drag', 'Pan'],
  ['⌘ scroll', 'Zoom'],
  ['⇧1  ⇧2', 'Fit all, fit selection'],
  ['Enter  Esc', 'Into children, to parent'],
  ['⌘ click', 'Select deepest'],
  ['⌘D  ⌫', 'Duplicate, delete'],
  ['⌘C  ⌘V', 'Copy, paste HTML'],
  ['⌘Z  ⇧⌘Z', 'Undo, redo'],
  ['I', 'Inspect selection'],
  ['L', 'Design issues'],
  ['⌘,', 'Settings'],
  ['⇧⌘H  ⇧⌘L', 'Hide, lock'],
  ['P', 'Preview'],
  ['?', 'This list'],
]

function HelpMenu() {
  const open = useStore((s) => s.helpOpen)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => open && store.setHelpOpen(false))
  return (
    <div className="pw-file-menu" ref={ref}>
      <button className={`pw-status-item pw-help ${open ? 'on' : ''}`} title="Keyboard shortcuts (?)" aria-expanded={open} onClick={() => store.setHelpOpen(!open)}>
        ?
      </button>
      {open && (
        <div className="pw-menu up right pw-help-menu">
          <div className="pw-shortcuts">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k}>
                <span>{v}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

