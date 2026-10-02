import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react'
import { store, useStore, type Camera } from '../store'
import {
  commitText,
  isTyping,
  isMovable,
  nodeEl,
  pathTo,
  pickTarget,
  px,
  reveal,
  setViewport,
  startEditingText,
  toWorld,
  worldRect,
  zoomToFit,
  type Box,
} from './actions'
import { Boards } from './Boards'
import { Overlay } from './Overlay'

const DRAG_THRESHOLD = 3

function hitId(target: EventTarget | null): string | null {
  // SAFETY: pointer targets in the canvas are elements; closest finds the measured node.
  const el = (target as Element | null)?.closest?.('.pw-world [data-pid]')

  return el?.getAttribute('data-pid') ?? null
}

function drag(
  e: RPointerEvent,
  onMove: (ev: PointerEvent, dx: number, dy: number) => void,
  onUp?: (ev: PointerEvent, moved: boolean) => void,
) {
  const sx = e.clientX
  const sy = e.clientY
  let moved = false

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx
    const dy = ev.clientY - sy

    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    moved = true
    onMove(ev, dx, dy)
  }

  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onUp?.(ev, moved)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

async function createText(e: RPointerEvent, parentId: string | null) {
  store.setTool('move')
  const p = toWorld(e.clientX, e.clientY)

  const ids = parentId
    ? await store.command({
        t: 'insertHtml',
        parentId,
        html: '<span style="font-size:16px">Text</span>',
      })
    : await store.command({
        t: 'insertHtml',
        parentId: store.page!.rootId,
        html: `<span style="font-size:24px;left:${Math.round(p.x)}px;top:${Math.round(p.y)}px">Text</span>`,
      })

  if (ids[0]) startEditingText(ids[0])
}

function startMove(e: RPointerEvent) {
  const items = store.selection.filter(isMovable).map((id) => {
    const n = store.node(id)!

    return { id, left: px(n.styles.left), top: px(n.styles.top), el: nodeEl(id) }
  })

  if (!items.length) return
  const zoom = store.camera.zoom
  let last = { dx: 0, dy: 0 }
  drag(
    e,
    (_ev, dx, dy) => {
      last = { dx: Math.round(dx / zoom), dy: Math.round(dy / zoom) }

      for (const it of items) {
        if (!it.el) continue
        it.el.style.left = `${it.left + last.dx}px`
        it.el.style.top = `${it.top + last.dy}px`
      }
    },
    (_ev, moved) => {
      if (!moved) return
      store.tx(
        items.map((it) => ({
          t: 'styles',
          id: it.id,
          set: { left: `${it.left + last.dx}px`, top: `${it.top + last.dy}px` },
        })),
        'move',
      )
    },
  )
}

export function Canvas() {
  const vpRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const tool = useStore((s) => s.tool)
  const docId = useStore((s) => s.doc?.id)
  const pageId = useStore((s) => s.pageId)
  const editing = useStore((s) => s.editingText)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [draft, setDraft] = useState<Box | null>(null)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    setViewport(vpRef.current)
    store.onReveal = reveal

    return () => {
      setViewport(null)
      store.onReveal = null
    }
  }, [])

  // The camera never goes through React: a pan writes two transforms straight
  // to the DOM (design and overlay); a zoom also sets the overlay's --zoom.
  useLayoutEffect(() => {
    const cam = cameraRef.current!
    const grid = gridRef.current!
    const overlay = overlayRef.current!
    let lastZoom = NaN

    const apply = () => {
      const c = store.camera
      cam.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.zoom})`
      overlay.style.transform = `translate(${c.x}px, ${c.y}px)`
      const zoomed = c.zoom !== lastZoom
      lastZoom = c.zoom

      if (zoomed) overlay.parentElement!.style.setProperty('--zoom', String(c.zoom))
      paintGrid(grid, c, zoomed)
    }

    apply()

    return store.subscribeCamera(apply)
  }, [])

  // Fit content the first time a file/page is shown without a saved camera.
  useEffect(() => {
    if (!docId) return
    store.restoreCamera()

    if (store.needsFit) {
      store.needsFit = false
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit(undefined, false)))
    }
  }, [docId, pageId])

  // Wheel: pan, pinch/ctrl to zoom around the cursor.
  useEffect(() => {
    const el = vpRef.current!

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = store.camera

      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
        const zoom = Math.max(0.02, Math.min(32, c.zoom * Math.exp(-delta * 0.01)))
        store.setCamera({
          zoom,
          x: sx - ((sx - c.x) / c.zoom) * zoom,
          y: sy - ((sy - c.y) / c.zoom) * zoom,
        })
      } else {
        const k = e.deltaMode === 1 ? 16 : 1
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        store.setCamera({ ...c, x: c.x - dx * k, y: c.y - dy * k })
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })

    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Space to pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        e.preventDefault()
        setSpace(true)
      }
    }

    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)

    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Focus the text being edited and select its content.
  useEffect(() => {
    if (!editing) return
    const el = nodeEl(editing)

    if (!el) return
    el.focus()

    // Defer so the browser's own double-click word selection doesn't win.
    const selectAll = () => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }

    selectAll()
    const t = setTimeout(selectAll, 0)
    const onBlur = () => commitText()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        el.blur()
      }
    }

    el.addEventListener('blur', onBlur)
    el.addEventListener('keydown', onKey)

    return () => {
      clearTimeout(t)
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('keydown', onKey)
    }
  }, [editing])

  const startPan = (e: RPointerEvent) => {
    const start = { ...store.camera }
    setPanning(true)
    drag(
      e,
      (_ev, dx, dy) => store.setCamera({ ...start, x: start.x + dx, y: start.y + dy }),
      () => setPanning(false),
    )
  }

  const startMarquee = (e: RPointerEvent) => {
    const a = toWorld(e.clientX, e.clientY)
    const additive = e.shiftKey
    const before = store.selection
    drag(
      e,
      (ev) => {
        const b = toWorld(ev.clientX, ev.clientY)

        const box = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(a.x - b.x),
          height: Math.abs(a.y - b.y),
        }

        setMarquee(box)

        const hits = store.boards.filter((id) => {
          const r = worldRect(id)

          return (
            r &&
            r.x < box.x + box.width &&
            r.x + r.width > box.x &&
            r.y < box.y + box.height &&
            r.y + r.height > box.y
          )
        })

        const next = additive ? [...new Set([...before, ...hits])] : hits

        if (
          next.length !== store.selection.length ||
          next.some((id, i) => id !== store.selection[i])
        )
          store.select(next)
      },
      () => setMarquee(null),
    )
  }

  const startFrame = (e: RPointerEvent, parentId: string | null) => {
    const a = toWorld(e.clientX, e.clientY)
    let box: Box = { x: a.x, y: a.y, width: 0, height: 0 }
    drag(
      e,
      (ev) => {
        const b = toWorld(ev.clientX, ev.clientY)
        box = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(a.x - b.x),
          height: Math.abs(a.y - b.y),
        }
        setDraft(box)
      },
      async (_ev, moved) => {
        setDraft(null)
        store.setTool('move')
        const w = Math.round(moved ? box.width : parentId ? 120 : 400)
        const h = Math.round(moved ? box.height : parentId ? 80 : 300)

        if (!parentId) {
          const ids = await store.command({
            t: 'insertHtml',
            parentId: store.page!.rootId,
            html: `<div layer-name="Frame" style="display:flex;flex-direction:column;background-color:#FFFFFF;width:${w}px;height:${h}px;left:${Math.round(box.x)}px;top:${Math.round(box.y)}px"></div>`,
          })

          store.select(ids)
        } else {
          const ids = await store.command({
            t: 'insertHtml',
            parentId,
            html: `<div layer-name="Frame" style="display:flex;flex-direction:column;background-color:#E7E5E4;width:${w}px;height:${h}px;flex-shrink:0"></div>`,
          })

          store.select(ids)
        }
      },
    )
  }

  const onPointerDown = (e: RPointerEvent) => {
    if (editing) {
      // SAFETY: pointer target in the canvas is a node; contains checks if the click stayed in the editor.
      if (nodeEl(editing)?.contains(e.target as Node)) return
      commitText()
    }

    if (e.button === 1 || space || tool === 'hand') {
      e.preventDefault()

      return startPan(e)
    }

    if (e.button !== 0) return

    // SAFETY: pointer target in the canvas is an element; closest finds the artboard label.
    const labelId =
      (e.target as HTMLElement).closest<HTMLElement>('[data-label-for]')?.dataset.labelFor ?? null

    const hit = labelId ?? hitId(e.target)

    if (tool === 'comment') {
      e.preventDefault()

      if (store.view?.kind === 'branch') return
      const p = toWorld(e.clientX, e.clientY)
      const r = hit ? worldRect(hit) : null

      return store.startComment({
        pageId: store.pageId,
        nodeId: r ? hit : null,
        x: r ? p.x - r.x : p.x,
        y: r ? p.y - r.y : p.y,
      })
    }

    if (tool === 'frame' || tool === 'text') {
      let container: string | null = null

      if (hit) {
        const path = pathTo(hit)
        container = path.toReversed().find((id) => store.node(id)?.type === 'Frame') ?? null
      }

      return tool === 'frame' ? startFrame(e, container) : void createText(e, container)
    }

    if (!hit) {
      if (!e.shiftKey) store.select([])

      return startMarquee(e)
    }

    const target = labelId ?? pickTarget(hit, e.metaKey || e.ctrlKey)

    if (e.shiftKey) {
      store.select(
        store.selection.includes(target)
          ? store.selection.filter((s) => s !== target)
          : [...store.selection, target],
      )

      return
    }

    if (!store.selection.includes(target)) store.select([target])
    startMove(e)
  }

  const onPointerMove = (e: RPointerEvent) => {
    if (e.buttons || (tool !== 'move' && tool !== 'comment')) return

    // SAFETY: pointer target in the canvas is an element; closest finds the artboard label.
    const labelId = (e.target as HTMLElement).closest<HTMLElement>('[data-label-for]')?.dataset
      .labelFor

    const hit = labelId ?? hitId(e.target)
    store.setHover(
      hit
        ? (labelId ?? (tool === 'comment' ? hit : pickTarget(hit, e.metaKey || e.ctrlKey)))
        : null,
    )
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitId(e.target)

    if (!hit || editing) return
    const path = pathTo(hit)
    const cur = store.selection[0]
    const i = cur ? path.indexOf(cur) : -1
    const next = i >= 0 && i < path.length - 1 ? path[i + 1] : path[path.length - 1]

    if (store.node(next)?.type === 'Text' && (next === hit || next === cur)) startEditingText(next)
    else if (cur === hit && store.node(hit)?.type === 'Text') startEditingText(hit)
    else store.select([next])
  }

  const cursor = panning
    ? 'grabbing'
    : space || tool === 'hand'
      ? 'grab'
      : tool === 'frame' || tool === 'text' || tool === 'comment'
        ? 'crosshair'
        : 'default'

  return (
    <div
      ref={vpRef}
      className="pw-canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => store.setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="pw-grid" ref={gridRef} />
      <div className="pw-camera" ref={cameraRef}>
        <Boards />
      </div>
      <Overlay marquee={marquee} draft={draft} panRef={overlayRef} />
    </div>
  )
}

// A dot on every 8px of the design, fading in only once you zoom past 120%.
// The pattern is drawn once per zoom level; panning only shifts the layer by
// the camera offset modulo one step.
function paintGrid(el: HTMLElement, c: Camera, zoomed: boolean) {
  const alpha = Math.min(1, Math.max(0, (c.zoom - 1.2) / 1.8)) * 0.22

  if (alpha <= 0.005) {
    if (el.dataset.on) {
      delete el.dataset.on
      el.style.display = ''
    }

    return
  }

  const step = 8 * c.zoom

  if (zoomed || !el.dataset.on) {
    el.dataset.on = '1'
    el.style.display = 'block'
    el.style.inset = `${-step}px`
    el.style.backgroundImage = `radial-gradient(circle, rgb(var(--ink) / ${alpha.toFixed(3)}) 1px, transparent 1.25px)`
    el.style.backgroundSize = `${step}px ${step}px`
  }

  const mod = (v: number) => (((v + step / 2) % step) + step) % step
  el.style.transform = `translate(${mod(c.x)}px, ${mod(c.y)}px)`
}
