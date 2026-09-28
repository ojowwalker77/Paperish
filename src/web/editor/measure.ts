import { useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useStore } from '../store'
import { nodeEl, worldRectOf, type Box } from './actions'

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
