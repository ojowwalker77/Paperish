import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Device, DeviceScreen, Finish } from './devices'
import './device-shell.css'

// A phone frame around live design content. Visual approach adapted from
// liquidframe (MIT): see device-shell.css and THIRD_PARTY_NOTICES.md.

export type ShellChrome = 'app' | 'safari'

const SAFARI_BOTTOM = 94

export function DeviceShell({
  device,
  screen,
  finish,
  chrome,
  url,
  watch,
  children,
}: {
  device: Device
  screen: DeviceScreen
  finish: Finish
  chrome: ShellChrome
  url: string
  /** Changes whenever the content may have changed (re-samples the status bar tone). */
  watch: unknown
  children: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tone, setTone] = useState<'dark' | 'light'>('dark')
  const [pageBg, setPageBg] = useState<string>('#ffffff')
  const safari = chrome === 'safari'

  // Status bar icons follow whatever is under them, like iOS does.
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let raf = 0
    const sample = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const root = scroll.querySelector<HTMLElement>('[data-pid]')
        const bg = root ? opaque(getComputedStyle(root).backgroundColor) : null
        if (bg) setPageBg(bg.css)
        const r = scroll.getBoundingClientRect()
        const k = r.height / screen.height
        const x = r.left + r.width * 0.18
        const y = r.top + (screen.safeTop / 2) * k
        let lum = bg?.lum ?? 1
        for (const el of document.elementsFromPoint(x, y)) {
          if (!scroll.contains(el)) continue
          const c = opaque(getComputedStyle(el).backgroundColor)
          if (c) {
            lum = c.lum
            break
          }
          if (el.tagName === 'IMG') {
            lum = 0.3
            break
          }
        }
        setTone(lum < 0.55 ? 'light' : 'dark')
      })
    }
    sample()
    scroll.addEventListener('scroll', sample, { passive: true })
    const ro = new ResizeObserver(sample)
    ro.observe(scroll)
    return () => {
      cancelAnimationFrame(raf)
      scroll.removeEventListener('scroll', sample)
      ro.disconnect()
    }
  }, [watch, screen, chrome])

  const frame: CSSProperties = {
    width: screen.width + screen.bezel * 2,
    height: screen.height + screen.bezel * 2,
    borderWidth: screen.bezel,
    borderRadius: screen.radius + screen.bezel,
    ['--edge' as string]: finish.edge,
    ['--edge-inner' as string]: finish.inner,
  }

  return (
    <div className="pw-device-wrap">
      <div className={`pw-device tone-${tone}`} style={frame} data-device={device.id}>
        {screen.buttons.map((b, i) => (
          <div key={i} className={`pw-device-btn ${b.side} ${b.kind ?? ''}`} style={buttonStyle(b, screen.bezel)} />
        ))}
        <div className="pw-device-screen" style={{ borderRadius: screen.radius, background: pageBg }}>
          <div
            ref={scrollRef}
            className="pw-device-scroll"
            style={{ paddingTop: safari ? screen.safeTop : 0, paddingBottom: safari ? SAFARI_BOTTOM : 0, background: pageBg }}
          >
            {children}
          </div>
          {screen.crease && <div className="pw-device-crease" />}
          <StatusBar screen={screen} />
          {screen.cutout.kind === 'island' && (
            <div className="pw-device-island" style={{ top: screen.cutout.top, width: screen.cutout.width, height: screen.cutout.height }} />
          )}
          {screen.cutout.kind === 'hole' && (
            <div className="pw-device-hole" style={{ top: screen.cutout.top, width: screen.cutout.size, height: screen.cutout.size }} />
          )}
          {safari ? <SafariBar url={url} /> : <div className="pw-device-home" style={{ width: Math.round(Math.min(screen.width * 0.333, 200)) }} />}
        </div>
      </div>
    </div>
  )
}

/** Content min-height so a short page still fills the screen. */
export function shellContentHeight(screen: DeviceScreen, chrome: ShellChrome) {
  return chrome === 'safari' ? screen.height - screen.safeTop - SAFARI_BOTTOM : screen.height
}

function buttonStyle(b: { side: string; at: number; length: number }, bezel: number): CSSProperties {
  const out = -(bezel + 6)
  if (b.side === 'top') return { top: out, left: b.at, width: b.length }
  return { [b.side]: out, top: b.at, height: b.length }
}

function StatusBar({ screen }: { screen: DeviceScreen }) {
  const c = screen.cutout
  const center = c.kind === 'island' ? c.top + c.height / 2 : c.kind === 'hole' ? c.top + c.size / 2 : screen.safeTop / 2
  const gap = c.kind === 'island' ? c.width + 24 : c.kind === 'hole' ? c.size + 48 : 0
  const style: CSSProperties =
    screen.statusLayout === 'island'
      ? { height: center * 2, gridTemplateColumns: `1fr ${gap}px 1fr` }
      : { height: center * 2, display: 'flex', justifyContent: 'space-between', padding: '0 28px' }
  return (
    <div className={`pw-device-status ${screen.statusLayout}`} style={style}>
      <span className="pw-device-time">9:41</span>
      {screen.statusLayout === 'island' && <span />}
      <span className="pw-device-icons">
        <svg width="19" height="13" viewBox="0 0 24 24" fill="currentColor">
          <rect x="1" y="16" width="3.5" height="5" rx="0.5" />
          <rect x="6.5" y="12" width="3.5" height="9" rx="0.5" />
          <rect x="12" y="7.5" width="3.5" height="13.5" rx="0.5" />
          <rect x="17.5" y="3" width="3.5" height="18" rx="0.5" />
        </svg>
        <svg width="18" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h.01" />
          <path d="M8.5 16.5a5 5 0 0 1 7 0" />
          <path d="M5 13a10 10 0 0 1 14 0" />
          <path d="M1.5 9.5a15 15 0 0 1 21 0" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
          <rect x="0.5" y="0.5" width="23" height="12" rx="3.8" stroke="currentColor" opacity="0.4" />
          <rect x="2" y="2" width="20" height="9" rx="2.5" fill="currentColor" />
          <path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.45" />
        </svg>
      </span>
    </div>
  )
}

function SafariBar({ url }: { url: string }) {
  return (
    <div className="pw-device-safari">
      <div className="pw-glass circle">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </div>
      <div className="pw-glass pill">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        <span className="pw-safari-url">{url}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </div>
      <div className="pw-glass circle">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
          <circle cx="5" cy="12" r="1" />
        </svg>
      </div>
    </div>
  )
}

/** Parse a computed rgb()/rgba() color; null when mostly transparent. */
function opaque(color: string): { css: string; lum: number } | null {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/)
  if (!m) return null
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  if (a < 0.4) return null
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = parseFloat(v) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return { css: color, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b }
}
