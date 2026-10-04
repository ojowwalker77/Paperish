import { viewsOf, type View } from '../../shared/views'
import { store } from '../store'
import { zoomToFit } from './actions'

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

  if (next) focusBoard(next.latest)
}

export async function newVersion() {
  if (!store.focus) return
  const [id] = await store.command({ t: 'fork', id: store.focus })

  if (id) focusBoard(id)
}
