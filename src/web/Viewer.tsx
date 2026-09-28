import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { pageOf } from '../shared/ops'
import { DeviceShell, shellContentHeight } from './DeviceShell'
import { DEVICES, deviceById, shellSize } from './devices'
import { Icon } from './editor/icons'
import { InteractiveContext } from './render/ComponentView'
import { NodeView } from './render/NodeView'
import { DesignScope } from './render/World'
import { store, useStore, VIEW_NODE, type PreviewMode } from './store'

// Shows one artboard as a full page UI: off the canvas, at real size (or
// scaled to fit, or at a device/window width so its layout reflows). Because
// it reads the live document, agent edits appear here as they happen.

const MODES: { id: PreviewMode; label: string; title: string }[] = [
  { id: 'fit', label: 'Fit', title: 'Scale down to fit the window' },
  { id: 'actual', label: '100%', title: 'Actual size' },
  { id: 'responsive', label: 'Responsive', title: 'Render at a device or window width so the layout reflows' },
]

const PAD = 40

export function Viewer({ id, onNavigate, onClose, standalone }: { id: string; onNavigate: (id: string) => void; onClose?: () => void; standalone?: boolean }) {
  const doc = useStore((s) => s.doc)
  const version = useStore((s) => s.version)
  const mode = useStore((s) => s.previewMode)
  const prefs = useStore((s) => s.previewDevice)
  const node = doc?.nodes[id]
  const stageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })

  const responsive = mode === 'responsive'
  const device = responsive ? deviceById(prefs.id) : undefined
  const screen = device ? device.screens[Math.min(prefs.screen, device.screens.length - 1)] : undefined
  const finish = device ? (device.finishes[prefs.finish[device.id] ?? 0] ?? device.finishes[0]) : undefined

  // Artboards on the same page, in canvas order, for prev/next.
  const siblings = useMemo(() => {
    if (!doc || !node) return []
    const page = pageOf(doc, id)
    const root = page ? doc.nodes[page.rootId] : undefined
    return (root?.children ?? []).filter((c) => !doc.nodes[c]?.hidden)
  }, [doc, node, id])
  const index = siblings.indexOf(id)
  const go = (delta: number) => {
    if (!siblings.length) return
    onNavigate(siblings[(index + delta + siblings.length) % siblings.length])
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'SELECT') return
      if (e.key === 'Escape' && onClose) onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    stageRef.current?.scrollTo(0, 0)
  }, [id])

  // Measure the frame's unscaled size and the stage.
  useLayoutEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-pid="${CSS.escape(id)}"]`)
    const measure = () => {
      setStage({ w: stageEl.clientWidth, h: stageEl.clientHeight })
      if (el) setSize({ w: el.offsetWidth ?? el.getBoundingClientRect().width, h: el.offsetHeight ?? el.getBoundingClientRect().height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stageEl)
    if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [id, node, mode, device])

  const shell = screen ? shellSize(screen) : null
  const scale = shell
    ? Math.min(1, (stage.w - PAD * 2) / shell.width, (stage.h - PAD * 2) / shell.height)
    : mode === 'fit' && size && stage.w
      ? Math.min(1, (stage.w - PAD * 2) / size.w)
      : 1

  const minHeight = screen ? shellContentHeight(screen, prefs.chrome) : stage.h
  const override = useMemo<CSSProperties>(
    () => ({
      position: 'relative',
      left: 'auto',
      top: 'auto',
      // Responsive: behave like a page at this width — fill it, grow with content.
      ...(responsive ? { width: '100%', maxWidth: 'none', height: 'auto', minHeight } : {}),
    }),
    [responsive, minHeight],
  )

  const openInTab = () => {
    const q = new URLSearchParams({ file: doc?.id ?? '', view: id, mode })
    if (device) {
      q.set('device', device.id)
      q.set('screen', String(prefs.screen))
      q.set('chrome', prefs.chrome)
    }
    window.open(`?${q}`, '_blank')
  }

  const design = (
    <InteractiveContext.Provider value={true}>
      <DesignScope>
        <NodeView id={id} top override={override} />
      </DesignScope>
    </InteractiveContext.Provider>
  )

  let body: React.ReactNode
  if (!node) body = <div className="pw-viewer-empty">{doc ? 'This frame no longer exists.' : 'Connecting…'}</div>
  else if (device && screen && finish && shell)
    body = (
      <div className="pw-viewer-sizer device" style={{ width: shell.width * scale, height: shell.height * scale }}>
        <div className="pw-viewer-scale" style={{ width: shell.width, transform: `scale(${scale})` }}>
          <DeviceShell device={device} screen={screen} finish={finish} chrome={prefs.chrome} url={urlFor(node.name)} watch={version}>
            {design}
          </DeviceShell>
        </div>
      </div>
    )
  else if (responsive)
    body = (
      <div className="pw-viewer-sizer" style={{ width: '100%' }}>
        <div ref={contentRef}>{design}</div>
      </div>
    )
  else
    body = (
      <div className="pw-viewer-sizer" style={{ width: size ? size.w * scale : undefined, height: size ? size.h * scale : undefined, visibility: size ? 'visible' : 'hidden' }}>
        <div ref={contentRef} style={{ width: 'max-content', transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {design}
        </div>
      </div>
    )

  const sizeLabel = screen
    ? `${screen.width} × ${screen.height} @${device!.dpr}x${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}`
    : size
      ? `${Math.round(responsive ? stage.w : size.w)} × ${Math.round(size.h)}${mode === 'fit' && scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}`
      : ''

  return (
    <div className={`pw-viewer ${standalone ? 'standalone' : ''}`}>
      <header className="pw-viewer-bar">
        <div className="pw-viewer-left">
          {onClose ? (
            <button className="pw-viewer-btn" title="Back to canvas (Esc)" onClick={onClose}>
              <Icon.Close />
            </button>
          ) : (
            <a className="pw-viewer-btn" title="Open in editor" href={`?file=${doc?.id ?? ''}`}>
              <Icon.Edit />
            </a>
          )}
          <span className="pw-viewer-title">{node?.name ?? 'Frame'}</span>
          {siblings.length > 1 && index >= 0 && (
            <span className="pw-viewer-nav">
              <button className="pw-viewer-btn" title="Previous (←)" onClick={() => go(-1)}>
                <Icon.ChevronLeft />
              </button>
              <span className="pw-viewer-count">
                {index + 1} / {siblings.length}
              </span>
              <button className="pw-viewer-btn" title="Next (→)" onClick={() => go(1)}>
                <Icon.Chevron size={12} />
              </button>
            </span>
          )}
        </div>

        <div className="pw-viewer-center">
          <div className="pw-segmented" role="tablist">
            {MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'active' : ''} title={m.title} onClick={() => store.setPreviewMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          {responsive && (
            <select className="pw-viewer-select" value={prefs.id ?? ''} title="Device" onChange={(e) => store.setPreviewDevice({ id: e.target.value || null, screen: 0 })}>
              <option value="">Full width</option>
              {DEVICES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="pw-viewer-right">
          {device && device.screens.length > 1 && (
            <div className="pw-segmented small" role="tablist" title="Fold state">
              {device.screens.map((s, i) => (
                <button key={s.label} role="tab" aria-selected={prefs.screen === i} className={prefs.screen === i ? 'active' : ''} onClick={() => store.setPreviewDevice({ screen: i })}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {device && (
            <button
              className={`pw-viewer-chip ${prefs.chrome === 'safari' ? 'on' : ''}`}
              aria-pressed={prefs.chrome === 'safari'}
              title="Show Safari's browser chrome (page starts below the status bar)"
              onClick={() => store.setPreviewDevice({ chrome: prefs.chrome === 'safari' ? 'app' : 'safari' })}
            >
              Safari
            </button>
          )}
          {device && (
            <span className="pw-finishes" role="radiogroup" aria-label="Finish">
              {device.finishes.map((f, i) => (
                <button
                  key={f.name}
                  role="radio"
                  aria-checked={f === finish}
                  title={f.name}
                  className={f === finish ? 'active' : ''}
                  style={{ background: f.edge }}
                  onClick={() => store.setPreviewDevice({ finish: { ...prefs.finish, [device.id]: i } })}
                />
              ))}
            </span>
          )}
          {sizeLabel && <span className="pw-viewer-size">{sizeLabel}</span>}
          {!standalone && (
            <button className="pw-viewer-btn" title="Open in a new tab (live)" onClick={openInTab}>
              <Icon.External />
            </button>
          )}
        </div>
      </header>

      <div ref={stageRef} className={`pw-viewer-stage ${responsive && !device ? 'responsive' : ''}`}>
        {body}
      </div>
    </div>
  )
}

/** Something URL-like for the Safari bar. */
function urlFor(name: string) {
  const n = name.trim().toLowerCase()
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(n)) return n
  return `${n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preview'}.paperish.app`
}

/** Full-window preview opened in its own tab. */
export function StandaloneViewer() {
  const [id, setId] = useState(VIEW_NODE!)
  const name = useStore((s) => s.doc?.nodes[id]?.name)
  const mode = useStore((s) => s.previewMode)
  const prefs = useStore((s) => s.previewDevice)
  useEffect(() => {
    document.title = name ? `${name} — Paperish` : 'Paperish'
  }, [name])
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('view', id)
    url.searchParams.set('mode', mode)
    for (const k of ['device', 'screen', 'chrome']) url.searchParams.delete(k)
    if (mode === 'responsive' && prefs.id) {
      url.searchParams.set('device', prefs.id)
      url.searchParams.set('screen', String(prefs.screen))
      url.searchParams.set('chrome', prefs.chrome)
    }
    history.replaceState(null, '', url)
  }, [id, mode, prefs])
  return <Viewer id={id} onNavigate={setId} standalone />
}
