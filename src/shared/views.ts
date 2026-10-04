import type { Doc, Page } from './types'

// A page's artboards, grouped into views by name: "Checkout", "Checkout @v2"
// and "Checkout @v3" are three versions of the view "Checkout".

export interface View {
  name: string
  /** Artboard ids as a tree, depth first: each version after the one it came from. */
  versions: string[]
  from: Record<string, string>
  latest: string
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

  return [...groups].map(([name, list]) => {
    const ids = list.toSorted((a, b) => a.n - b.n).map((x) => x.id)
    const from: Record<string, string> = {}
    const children = new Map<string, string[]>()

    ids.forEach((id, i) => {
      const fork = doc.nodes[id].fork?.from
      const parent = fork && fork !== id && ids.includes(fork) ? fork : ids[i - 1]

      if (!parent) return
      from[id] = parent
      children.set(parent, [...(children.get(parent) ?? []), id])
    })

    const versions: string[] = []
    const seen = new Set<string>()

    const walk = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      versions.push(id)

      for (const c of children.get(id) ?? []) walk(c)
    }

    for (const id of ids) if (!from[id]) walk(id)

    for (const id of ids) walk(id)

    return { name, versions, from, latest: ids[ids.length - 1] }
  })
}

export function nextVersionName(view: View, doc: Doc): string {
  return `${view.name} @v${versionNumber(doc.nodes[view.latest].name) + 1}`
}
