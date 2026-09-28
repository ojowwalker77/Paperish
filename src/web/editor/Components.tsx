import type { ComponentInfo } from '../../shared/types'
import { store } from '../store'
import { viewportSize } from './actions'

// Placing the linked codebase's components: an instance goes into the selected
// frame, or onto the canvas at the middle of the view.

export function propSummary(c: ComponentInfo): string {
  return c.props.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type === 'enum' ? p.options?.join(' | ') : p.type}`).join('\n')
}

/** Markup for a fresh instance: required props get placeholder values. */
export function instanceMarkup(c: ComponentInfo): string {
  const attrs = c.props
    .filter((p) => p.required && p.default === undefined)
    .map((p) => {
      if (p.type === 'number') return ` ${p.name}={0}`
      if (p.type === 'boolean') return ` ${p.name}`
      if (p.type === 'enum') return ` ${p.name}="${p.options?.[0] ?? ''}"`
      return ` ${p.name}="${p.name.charAt(0).toUpperCase() + p.name.slice(1)}"`
    })
    .join('')
  return c.slot ? `<${c.name}${attrs}>${c.name}</${c.name}>` : `<${c.name}${attrs} />`
}

export async function insertComponent(c: ComponentInfo) {
  const sel = store.node(store.selection[0])
  let parent = sel?.type === 'Frame' ? sel : store.node(sel?.parent)
  const styles: Record<string, string> = {}
  if (!parent || parent.type === 'Root') {
    parent = store.node(store.page?.rootId)
    const vp = viewportSize()
    const cam = store.camera
    let left = Math.round((vp.width / 2 - cam.x) / cam.zoom - 100)
    let top = Math.round((vp.height / 2 - cam.y) / cam.zoom - 40)
    // Repeated inserts cascade instead of stacking on the same spot.
    const taken = new Set(
      (parent?.children ?? []).map((id) => {
        const st = store.node(id)?.styles
        return `${st?.left},${st?.top}`
      }),
    )
    while (taken.has(`${left}px,${top}px`)) {
      left += 32
      top += 32
    }
    styles.left = `${left}px`
    styles.top = `${top}px`
  }
  if (!parent) return
  const ids = await store.command({ t: 'insertHtml', parentId: parent.id, html: instanceMarkup(c), styles })
  store.select(ids)
}
