import type { Doc, Page } from '../../shared/types'
import { store } from '../store'
import { zoomToFit } from './actions'

// A page's artboards, grouped into views by name: "Checkout", "Checkout @v2"
// and "Checkout @v3" are three versions of the view "Checkout".

export interface View {
  name: string
  /** Artboard ids, oldest version first. */
  versions: string[]
}

const VERSION = /\s+@v(\d+)$/

function parse(name: string): { base: string; n: number } {
  const m = VERSION.exec(name)

  return m ? { base: name.slice(0, m.index), n: Number(m[1]) } : { base: name, n: 1 }
}

export function versionNumber(name: string): number {
  return parse(name).n
}

export function viewsOf(doc: Doc, page: Page): View[] {
  const groups = new Map<string, { id: string; n: number }[]>()

  for (const id of doc.nodes[page.rootId]?.children ?? []) {
    const n = doc.nodes[id]

    if (n?.type !== 'Frame') continue
    const { base, n: v } = parse(n.name)
    groups.set(base, [...(groups.get(base) ?? []), { id, n: v }])
  }

  return [...groups].map(([name, list]) => ({
    name,
    versions: list.toSorted((a, b) => a.n - b.n).map((x) => x.id),
  }))
}

export function viewOf(id: string | null): View | undefined {
  const doc = store.doc
  const page = store.page

  return id && doc && page ? viewsOf(doc, page).find((v) => v.versions.includes(id)) : undefined
}

/** Show one artboard alone on the canvas, fitted. */
export function focusBoard(id: string, pageId?: string) {
  if (pageId && pageId !== store.pageId) store.setPage(pageId)
  store.setFocus(id)
  requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit([id])))
}

export function unfocus() {
  store.setFocus(null)
  requestAnimationFrame(() => zoomToFit())
}

export function stepVersion(delta: number) {
  const view = viewOf(store.focus)

  if (!view || !store.focus) return
  const next = view.versions[view.versions.indexOf(store.focus) + delta]

  if (next) focusBoard(next)
}

export function stepView(delta: number) {
  const doc = store.doc
  const page = store.page

  if (!doc || !page) return
  const views = viewsOf(doc, page)
  const at = views.findIndex((v) => store.focus && v.versions.includes(store.focus))
  const next = views[at < 0 ? (delta > 0 ? 0 : views.length - 1) : at + delta]

  if (next) focusBoard(next.versions[next.versions.length - 1])
}

/** Copy the shown version into the next one and show that. */
export async function newVersion() {
  const view = viewOf(store.focus)

  if (!view || !store.focus) return
  const last = Math.max(...view.versions.map((id) => versionNumber(store.node(id)?.name ?? '')))
  const name = `${view.name} @v${last + 1}`
  const [id] = await store.command({ t: 'duplicate', ids: [store.focus], name })

  if (id) focusBoard(id)
}
