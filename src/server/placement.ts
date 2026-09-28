import { engine } from './engine'
import type { OpenFile } from './workspace'

export const ARTBOARD_GAP = 80

/** Top-left for a new top-level node: to the right of everything on the page. */
export async function findPlacement(f: OpenFile): Promise<{ left: number; top: number }> {
  const root = f.doc.nodes[f.page.rootId]

  if (!root.children.length) return { left: 0, top: 0 }
  const rects = await engine.layout(f, root.children, f.pageId)
  let right = -Infinity
  let top = Infinity

  for (const r of Object.values(rects)) {
    right = Math.max(right, r.worldX + r.width)
    top = Math.min(top, r.worldY)
  }

  if (!isFinite(right)) return { left: 0, top: 0 }

  return { left: Math.round(right + ARTBOARD_GAP), top: Math.round(top) }
}
