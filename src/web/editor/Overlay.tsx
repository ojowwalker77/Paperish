import { memo, useMemo, type CSSProperties, type Ref } from 'react'
import { shallow, useStore } from '../store'
import { boardReach, boardRect, type Box } from './actions'
import { CommentPins } from './Comments'
import { intersects, useView, useWorldRects, type View } from './measure'
import type { Guide } from './snap'

// Screen-space chrome drawn above the canvas: artboard labels, agent working
// indicators, hover and selection outlines. Items carry world rects
// (--x/--y/--w/--h); CSS scales them by --zoom, and the canvas translates the
// whole pan layer. So a pan is a single compositor transform (no restyle, no
// repaint) and a zoom restyles only these few elements.

export function Overlay({
  marquee,
  draft,
  guides,
  panRef,
}: {
  marquee: Box | null
  draft: Box | null
  guides: Guide[]
  panRef: Ref<HTMLDivElement>
}) {
  const selection = useStore((s) => s.selection)
  const editing = useStore((s) => s.editingText)
  const rects = useWorldRects(selection)

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

  return (
    <div className="pw-overlay">
      <div className="pw-overlay-pan" ref={panRef}>
        <Labels />
        <Hover />

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
        {guides.map((g) => (
          <div
            key={`${g.x1},${g.y1},${g.x2},${g.y2}`}
            className="pw-ob pw-guide"
            style={vars({ x: g.x1, y: g.y1, width: g.x2 - g.x1, height: g.y2 - g.y1 })}
          />
        ))}
        <CommentPins />
      </div>
    </div>
  )
}

/**
 * Labels of the artboards in view and wide enough to show one, so a zoom
 * restyles a screenful of them, however many artboards the page has. Hover
 * and selection changes stay off this list.
 */
const Labels = memo(function Labels() {
  const working = useStore((s) => s.working)

  const rootChildren = useStore((s) => s.boards, shallow)

  // Only what the labels show, so edits deep inside artboards don't re-render this.
  const labels = useStore((s) => rootChildren.map((id) => s.doc?.nodes[id]), shallow)
  const agentRecent = useStore((s) => s.lastAgentActivity)
  const proposal = useStore((s) => s.proposal)
  const view = useView()
  const sizes = useStore((s) => s.boardSizes)

  const shown = useMemo(
    () => rootChildren.filter((id) => working.includes(id) || labelled(id, view)),
    [rootChildren, working, view, sizes],
  )

  const rects = useWorldRects(shown)
  const isShown = new Set(shown)
  const recentlyActive = Date.now() - agentRecent < 2500

  return labels.map((n, i) => {
    const id = rootChildren[i]
    const r = isShown.has(id) ? (rects[id] ?? boardRect(id)) : null
    const isWorking = working.includes(id)

    if (!r || !n || n.hidden) return null
    const option = proposal?.options.find((o) => o.nodeId === id)

    return (
      <Label
        key={id}
        id={id}
        x={r.x}
        y={r.y}
        width={r.width}
        height={r.height}
        name={option ? option.label : n.name}
        letter={option?.letter}
        working={isWorking}
        active={recentlyActive}
      />
    )
  })
})

const Label = memo(function Label({
  id,
  name,
  letter,
  working,
  active,
  ...r
}: Box & { id: string; name: string; letter?: string; working: boolean; active: boolean }) {
  const selected = useStore((s) => s.selection.includes(id))

  return (
    <div>
      {working && <div className={`pw-ob pw-working ${active ? 'active' : ''}`} style={vars(r)} />}
      <div className={`pw-label ${selected ? 'selected' : ''}`} data-label-for={id} style={vars(r)}>
        {working && (
          <span className="pw-agent-chip">
            <span className="pw-agent-dot" />
            Agent
          </span>
        )}
        {letter && <span className="pw-label-letter">{letter}</span>}
        <span className="pw-label-name">{name}</span>
      </div>
    </div>
  )
})

/** Labels fade out under 28px wide; within a quarter octave of zoom, under 20px never reaches that. */
function labelled(id: string, view: View) {
  const r = boardReach(id)

  return !!r && r.width * view.zoom >= 20 && intersects(r, view)
}

function Hover() {
  const hover = useStore((s) => (s.hover && !s.selection.includes(s.hover) ? s.hover : null))
  const rects = useWorldRects(hover ? [hover] : [])

  return hover && rects[hover] ? (
    <div className="pw-ob pw-hover" style={vars(rects[hover])} />
  ) : null
}

function vars(r: Box) {
  // SAFETY: custom properties for overlay rects; React passes --* through to CSS.
  return { '--x': r.x, '--y': r.y, '--w': r.width, '--h': r.height } as CSSProperties
}

function fmt(v: number) {
  return Math.round(v * 10) / 10
}
