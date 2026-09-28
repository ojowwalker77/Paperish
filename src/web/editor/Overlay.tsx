import type { CSSProperties, Ref } from 'react'
import { shallow, useStore } from '../store'
import type { Box } from './actions'
import { useWorldRects } from './measure'

// Screen-space chrome drawn above the canvas: artboard labels, agent working
// indicators, hover and selection outlines. Items carry world rects
// (--x/--y/--w/--h); CSS scales them by --zoom, and the canvas translates the
// whole pan layer. So a pan is a single compositor transform (no restyle, no
// repaint) and a zoom restyles only these few elements.

export function Overlay({
  marquee,
  draft,
  panRef,
}: {
  marquee: Box | null
  draft: Box | null
  panRef: Ref<HTMLDivElement>
}) {
  const selection = useStore((s) => s.selection)
  const hover = useStore((s) => s.hover)
  const working = useStore((s) => s.working)
  const editing = useStore((s) => s.editingText)

  const rootChildren =
    useStore((s) => (s.page ? s.doc?.nodes[s.page.rootId]?.children : undefined)) ?? []

  // Only what the labels show, so edits deep inside artboards don't re-render this.
  const labels = useStore((s) => rootChildren.map((id) => s.doc?.nodes[id]), shallow)
  const agentRecent = useStore((s) => s.lastAgentActivity)

  // Hover churns on every mouse move; measure it separately from the stable set.
  const rects = useWorldRects(uniq([...rootChildren, ...selection]))
  const hoverRects = useWorldRects(hover && !selection.includes(hover) ? [hover] : [])

  const selBounds = (() => {
    const rs = selection.map((id) => rects[id]).filter(Boolean)

    if (rs.length < 2) return null
    const x1 = Math.min(...rs.map((r) => r.x))
    const y1 = Math.min(...rs.map((r) => r.y))
    const x2 = Math.max(...rs.map((r) => r.x + r.width))
    const y2 = Math.max(...rs.map((r) => r.y + r.height))

    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  })()

  const single = selection.length === 1 ? rects[selection[0]] : null
  const recentlyActive = Date.now() - agentRecent < 2500

  return (
    <div className="pw-overlay">
      <div className="pw-overlay-pan" ref={panRef}>
        {labels.map((n, i) => {
          const id = rootChildren[i]
          const r = rects[id]

          if (!r || !n || n.hidden) return null
          const isWorking = working.includes(id)
          const selected = selection.includes(id)

          return (
            <div key={id}>
              {isWorking && (
                <div
                  className={`pw-ob pw-working ${recentlyActive ? 'active' : ''}`}
                  style={vars(r)}
                />
              )}
              <div
                className={`pw-label ${selected ? 'selected' : ''}`}
                data-label-for={id}
                style={vars(r)}
              >
                {isWorking && (
                  <span className="pw-agent-chip">
                    <span className="pw-agent-dot" />
                    Agent
                  </span>
                )}
                <span className="pw-label-name">{n.name}</span>
              </div>
            </div>
          )
        })}

        {hover && hoverRects[hover] && (
          <div className="pw-ob pw-hover" style={vars(hoverRects[hover])} />
        )}

        {selection.map((id) =>
          rects[id] ? (
            <div
              key={id}
              className={`pw-ob pw-selected ${editing === id ? 'editing' : ''}`}
              style={vars(rects[id])}
            />
          ) : null,
        )}
        {selBounds && <div className="pw-ob pw-selected-group" style={vars(selBounds)} />}

        {single && editing !== selection[0] && (
          <div className="pw-size" style={vars(single)}>
            {fmt(single.width)} × {fmt(single.height)}
          </div>
        )}

        {marquee && <div className="pw-ob pw-marquee" style={vars(marquee)} />}
        {draft && <div className="pw-ob pw-draft" style={vars(draft)} />}
      </div>
    </div>
  )
}

function vars(r: Box) {
  // SAFETY: custom properties for overlay rects; React passes --* through to CSS.
  return { '--x': r.x, '--y': r.y, '--w': r.width, '--h': r.height } as CSSProperties
}

function uniq(ids: string[]) {
  return [...new Set(ids)]
}

function fmt(v: number) {
  return Math.round(v * 10) / 10
}
