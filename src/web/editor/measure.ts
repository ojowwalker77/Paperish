import { useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { store, useCamera, useStore } from '../store'
import { nodeEl, viewportSize, worldRectOf, type Box } from './actions'

export type Rects = Record<string, Box>

const EMPTY: Rects = {}

/**
 * World-space rects of canvas nodes, re-measured only when something that can
 * move them happens: a DOM change inside the design (edits, drags, typing,
 * component resizes), an element resize, or an image or font load. Camera
 * moves don't change world rects, so panning and zooming never read the DOM.
 */
export function useWorldRects(ids: readonly string[]): Rects {
  const [rects, setRects] = useState<Rects>(EMPTY)
  const key = ids.join('\n')
  const pageId = useStore((s) => s.pageId)

  useLayoutEffect(() => {
    const list = key ? key.split('\n') : []

    if (!list.length) {
      setRects(EMPTY)

      return
    }

    let raf = 0
    let sig = ''
    const observed = new Set<Element>()
    const ro = new ResizeObserver(() => schedule())

    const measure = (inLayoutEffect: boolean) => {
      raf = 0
      const next: Rects = {}
      let s = ''

      for (const id of list) {
        const el = nodeEl(id)

        if (!el) continue

        if (!observed.has(el)) {
          observed.add(el)
          ro.observe(el)
        }

        const r = worldRectOf(el)

        if (!r) continue
        next[id] = r
        s += `${id}:${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)};`
      }

      if (s === sig) return
      sig = s

      // From rAF, commit before this frame paints so outlines never trail.
      if (inLayoutEffect) setRects(next)
      else flushSync(() => setRects(next))
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => measure(false))
    }

    const world = document.querySelector('.pw-canvas .pw-world')
    const mo = new MutationObserver(schedule)

    if (world)
      mo.observe(world, { subtree: true, childList: true, attributes: true, characterData: true })
    world?.addEventListener('load', schedule, true)
    document.fonts.addEventListener('loadingdone', schedule)
    measure(true)

    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
      world?.removeEventListener('load', schedule, true)
      document.fonts.removeEventListener('loadingdone', schedule)
    }
  }, [key, pageId])

  return rects
}

export type View = Box & { zoom: number }

/**
 * The world area on screen plus a 512px margin, recomputed only when the
 * camera crosses a 256px step or zooms past a quarter octave.
 */
export function useView(): View {
  const step = useCamera(
    (c) => `${Math.round(Math.log2(c.zoom) * 4)} ${Math.round(c.x / 256)} ${Math.round(c.y / 256)}`,
  )

  return useMemo(() => {
    const { x, y, zoom } = store.camera
    const vp = viewportSize()
    const m = 512 / zoom

    return {
      x: -x / zoom - m,
      y: -y / zoom - m,
      width: vp.width / zoom + 2 * m,
      height: vp.height / zoom + 2 * m,
      zoom,
    }
  }, [step])
}

export function intersects(a: Box, b: Box) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
