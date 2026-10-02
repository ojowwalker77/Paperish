import { memo, useDeferredValue, useLayoutEffect, useRef } from 'react'
import { artboardOf } from '../../shared/ops'
import { NodeView } from '../render/NodeView'
import { DesignScope } from '../render/World'
import { shallow, store, useStore } from '../store'
import { boardReach, nodeEl, worldRectOf } from './actions'
import { intersects, useView } from './measure'

type Size = { width: number; height: number }

/**
 * The page's artboards near the screen; the rest aren't rendered, so the
 * canvas costs what's in view however many artboards the page has. Selected
 * and edited ones always render; each is measured when it renders, so its
 * size is known after.
 */
export const Boards = memo(function Boards() {
  const children = useStore((s) => (s.page ? s.doc?.nodes[s.page.rootId]?.children : undefined))
  const sizes = useStore((s) => s.boardSizes)
  const pinned = useStore(pinnedBoards, shallow)
  const view = useDeferredValue(useView())
  useStore((s) => s.doc?.nodes)

  const keep = new Set(pinned)

  const shown = (children ?? []).filter((id) => {
    const r = boardReach(id)

    return !r || keep.has(id) || intersects(r, view)
  })

  const observer = useRef<{ ro: ResizeObserver; seen: WeakSet<Element> } | null>(null)

  useLayoutEffect(() => {
    const ro = new ResizeObserver(onResize)
    observer.current = { ro, seen: new WeakSet() }

    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const fresh = new Map<string, Size>()

    for (const id of shown) {
      const el = nodeEl(id)

      if (!el) continue

      if (observer.current && !observer.current.seen.has(el)) {
        observer.current.seen.add(el)
        observer.current.ro.observe(el)
      }

      if (sizes.has(id)) continue
      const r = worldRectOf(el)

      if (r) fresh.set(id, { width: r.width, height: r.height })
    }

    if (fresh.size) store.setBoardSizes(fresh)
  })

  return (
    <DesignScope className="pw-world">
      {shown.map((id) => (
        <NodeView key={id} id={id} top />
      ))}
    </DesignScope>
  )
})

function pinnedBoards(s: typeof store): string[] {
  const nodes = s.doc?.nodes

  if (!nodes) return []

  return [...s.selection, s.editingText].flatMap((id) => {
    const board = id ? artboardOf(nodes, id) : undefined

    return board ? [board.id] : []
  })
}

/** Fonts and images resize rendered artboards without an edit. */
function onResize(entries: ResizeObserverEntry[], ro: ResizeObserver) {
  const sizes = new Map<string, Size>()

  for (const e of entries) {
    const id = e.target.getAttribute('data-pid')
    const box = e.borderBoxSize[0]

    if (!e.target.isConnected) ro.unobserve(e.target)

    if (!e.target.isConnected || !id || !box) continue
    sizes.set(id, { width: box.inlineSize, height: box.blockSize })
  }

  if (sizes.size) store.setBoardSizes(sizes)
}
