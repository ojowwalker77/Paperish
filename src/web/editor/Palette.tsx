import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeType } from '../../shared/types'
import { store, useStore } from '../store'
import { openPreview, reveal, setHidden, setLocked, zoomToFit } from './actions'
import { insertComponent, propSummary } from './Components'
import { Icon, NodeIcon } from './icons'

// The command palette (⌘K): the one way to find anything. Layers, artboards,
// pages, files, checkouts, branches, components to insert and actions, ranked
// by how well they match what you type.

interface Item {
  key: string
  label: string
  /** Right-hand detail: where it is, or its shortcut. */
  hint?: string
  kind: string
  icon: React.ReactNode
  run: () => void
}

export function Palette() {
  const palette = useStore((s) => s.palette)

  return palette ? <PaletteDialog initial={palette.query} /> : null
}

function runPaletteItem(item: Item | undefined) {
  if (!item) return
  store.closePalette()
  item.run()
}

function PaletteDialog({ initial }: { initial: string }) {
  const [query, setQuery] = useState(initial)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const items = useItems()
  const results = useMemo(() => rank(items, query), [items, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = runPaletteItem

  return (
    <div
      className="pw-palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && store.closePalette()}
    >
      <div className="pw-palette" role="dialog" aria-label="Command palette">
        <input
          className="pw-palette-input"
          autoFocus
          placeholder="Search layers, pages, files, branches, components, actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()

            if (e.key === 'Escape') store.closePalette()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(results.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(results[active])
            }
          }}
        />
        <div className="pw-palette-list" ref={listRef}>
          {results.map((item, i) => (
            <button
              key={item.key}
              data-i={i}
              className={`pw-palette-item ${i === active ? 'active' : ''}`}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => run(item)}
            >
              <span className="pw-palette-icon">{item.icon}</span>
              <span className="pw-palette-label">{item.label}</span>
              {item.hint && <span className="pw-palette-hint">{item.hint}</span>}
              <span className="pw-palette-kind">{item.kind}</span>
            </button>
          ))}
          {!results.length && <div className="pw-palette-empty">Nothing matches “{query}”.</div>}
        </div>
      </div>
    </div>
  )
}

function useItems(): Item[] {
  const doc = useStore((s) => s.doc)
  const pageId = useStore((s) => s.pageId)
  const files = useStore((s) => s.files)
  const view = useStore((s) => s.view)
  const checkouts = useStore((s) => s.checkouts)
  const branches = useStore((s) => s.branches)
  const project = useStore((s) => s.project)
  const info = useStore((s) => s.projectInfo)
  const inGit = useStore((s) => !!s.repo?.root)
  const selection = useStore((s) => s.selection)
  const rulers = useStore((s) => s.rulers)

  return useMemo(() => {
    const out: Item[] = []

    const act = (
      label: string,
      run: () => void,
      hint?: string,
      icon: React.ReactNode = <Icon.Play size={12} />,
    ) => out.push({ key: `a:${label}`, label, hint, kind: 'Action', icon, run })

    act('Zoom to fit', () => zoomToFit(), '⇧1')
    act(rulers ? 'Hide rulers' : 'Show rulers', () => store.setRulers(!rulers), '⇧R')

    if (selection.length) {
      act('Zoom to selection', () => zoomToFit(selection), '⇧2')
      act('Inspect selection', () => store.setInspectOpen(true), 'I')
      const first = store.node(selection[0])
      act(
        first?.hidden ? 'Show selection' : 'Hide selection',
        () => selection.forEach((id) => setHidden(id, !first?.hidden)),
        '⇧⌘H',
      )
      act(
        first?.locked ? 'Unlock selection' : 'Lock selection',
        () => selection.forEach((id) => setLocked(id, !first?.locked)),
        '⇧⌘L',
      )
    }

    act('Preview', openPreview, 'P')
    act('Import a web page…', () => store.setImport('url'), undefined, <Icon.Globe size={12} />)

    if (inGit)
      act('Show changes', () => store.setChangesOpen(true), undefined, <Icon.Branch size={12} />)

    if (view?.kind !== 'branch')
      act('New file', () => store.send({ t: 'createFile' }), undefined, <Icon.Plus size={12} />)
    act('New page', () => store.send({ t: 'createPage' }), undefined, <Icon.Plus size={12} />)

    if (info)
      act(
        'Copy MCP endpoint',
        () => void navigator.clipboard.writeText(info.mcp),
        info.mcp,
        <Icon.Plug size={12} />,
      )
    act('Design issues', () => store.setLintOpen(true), 'L')
    act('Settings…', () => store.setSettingsOpen(true), '⌘,')
    act('All projects', () => store.send({ t: 'home' }), undefined, <Icon.ChevronLeft size={12} />)

    // Layers of the current page, with where they sit.
    const page = doc?.pages.find((p) => p.id === pageId)

    if (doc && page) {
      const walk = (id: string, trail: string[]) => {
        const n = doc.nodes[id]

        if (!n) return
        const top = n.parent === page.rootId
        out.push({
          key: `n:${id}`,
          label: n.name || n.type,
          hint: trail.join(' › '),
          kind: top ? 'Artboard' : n.type === 'Component' ? 'Component' : 'Layer',
          // SAFETY: n.type comes from the document model; top-level Frames render as artboards here.
          icon: <NodeIcon type={n.type as NodeType} top={top} />,
          run: () => {
            store.select([id])
            reveal([id])
          },
        })

        for (const c of n.children) walk(c, [...trail, n.name || n.type])
      }

      for (const id of doc.nodes[page.rootId]?.children ?? []) walk(id, [])

      for (const p of doc.pages)
        if (p.id !== pageId)
          out.push({
            key: `p:${p.id}`,
            label: p.name,
            kind: 'Page',
            icon: <Icon.File size={12} />,
            run: () => store.setPage(p.id),
          })
    }

    for (const f of files)
      if (f.id !== doc?.id)
        out.push({
          key: `f:${f.id}`,
          label: f.name,
          hint: f.ref ? `${f.ref.branch}, read-only` : undefined,
          kind: 'File',
          icon: <Icon.File size={12} />,
          run: () =>
            f.ref
              ? store.send({ t: 'openBranch', branch: f.ref.branch, rel: f.ref.rel })
              : store.send({ t: 'open', fileId: f.id }),
        })

    for (const c of checkouts)
      if (!(view?.kind === 'checkout' && view.path === c.path))
        out.push({
          key: `c:${c.path}`,
          label: c.branch ?? 'detached',
          hint: c.main ? 'main checkout' : `worktree · ${c.path.split('/').pop()}`,
          kind: 'Checkout',
          icon: <Icon.Branch size={12} />,
          run: () => store.send({ t: 'openCheckout', checkout: c.path }),
        })

    for (const b of branches)
      if (!(view?.kind === 'branch' && view.branch === b))
        out.push({
          key: `b:${b}`,
          label: b,
          hint: 'as committed, read-only',
          kind: 'Branch',
          icon: <Icon.Branch size={12} />,
          run: () => store.send({ t: 'openBranch', branch: b }),
        })

    for (const c of project?.components ?? [])
      out.push({
        key: `i:${c.id}`,
        label: `Insert ${c.name}`,
        hint: propSummary(c).split('\n').slice(0, 3).join(', '),
        kind: 'Component',
        icon: <Icon.Component size={12} />,
        run: () => void insertComponent(c),
      })

    return out
  }, [doc, pageId, files, view, checkouts, branches, project, info, inGit, selection, rulers])
}

/** Best matches first: whole-label prefix, then word starts, then substrings, then letters in order. Empty query: actions and artboards. */
function rank(items: Item[], query: string): Item[] {
  const q = query.trim().toLowerCase()

  if (!q)
    return items
      .filter(
        (i) =>
          i.kind === 'Action' || i.kind === 'Artboard' || i.kind === 'Page' || i.kind === 'File',
      )
      .slice(0, 60)
  const scored: [number, Item][] = []

  for (const item of items) {
    const inHint = item.hint ? score(item.hint.toLowerCase(), q) : null
    const s = score(item.label.toLowerCase(), q) ?? (inHint === null ? null : inHint - 40)

    if (s !== null) scored.push([s - item.label.length * 0.01, item])
  }

  return scored
    .toSorted((a, b) => b[0] - a[0])
    .slice(0, 80)
    .map(([, i]) => i)
}

function score(label: string, q: string): number | null {
  if (label === q) return 100

  if (label.startsWith(q)) return 80
  const at = label.indexOf(q)

  if (at > 0 && /[\s›/_-]/.test(label[at - 1])) return 60

  if (at >= 0) return 40
  let i = 0

  for (const ch of label) if (ch === q[i]) i++

  return i === q.length ? 10 : null
}
