import { useEffect, useMemo, useState } from 'react'
import { toStaticHTML } from '../../shared/html'
import { parseStyleAttr, stylesToCss } from '../../shared/styles'
import type { ComponentProp, JsonValue, Op, PNode, StyleValue } from '../../shared/types'
import { shallow, store, useStore } from '../store'
import { isMovable, rename } from './actions'
import { useWorldRects } from './measure'
import { Icon, NodeIcon } from './icons'

/**
 * The inspector, on demand: I (or the selection size in the status bar)
 * opens it for the selection, Esc closes it. Most changes come from agents;
 * this is for checking values and quick tweaks.
 */
export function Inspector() {
  const open = useStore((s) => s.inspectOpen)

  // Only the selected nodes, so edits elsewhere (e.g. an agent at work) don't re-render the panel.
  const sel = useStore(
    (s) => s.selection.map((id) => s.doc?.nodes[id]).filter((n): n is PNode => !!n),
    shallow,
  )

  if (!open || !sel.length) return null

  return (
    <aside className="pw-inspect" aria-label="Inspector">
      <button
        className="pw-icon-btn pw-inspect-close"
        title="Close (Esc)"
        onClick={() => store.setInspectOpen(false)}
      >
        <Icon.Close size={13} />
      </button>
      <NodePanel nodes={sel} />
    </aside>
  )
}

function ComponentProps({ node }: { node: PNode }) {
  const project = useStore((s) => s.project)
  const info = project?.components.find((c) => c.id === node.component?.id)
  const props = node.props ?? {}

  const set = (name: string, value: JsonValue | undefined) => {
    const next = { ...props }

    if (value === undefined || value === '') delete next[name]
    else next[name] = value
    store.tx([{ t: 'patch', id: node.id, patch: { props: next } }], `set ${name}`)
  }

  const known = new Set(info?.props.map((p) => p.name))
  const extra = Object.keys(props).filter((k) => !known.has(k))

  return (
    <section className="pw-section">
      <header className="pw-section-head">
        <span>{node.component?.name}</span>
        <span className={`pw-chip ${node.component?.framework}`}>
          {node.component?.framework === 'vue' ? 'Vue' : 'React'}
        </span>
      </header>
      {info ? (
        <>
          <a
            className="pw-path"
            href={`vscode://file/${project!.root}/${info.file}`}
            title="Open in VS Code"
          >
            {info.file}
          </a>
          <div className="pw-props">
            {info.props.map((p) => (
              <PropField
                key={p.name}
                prop={p}
                value={props[p.name]}
                onChange={(v) => set(p.name, v)}
              />
            ))}
            {extra.map((k) => (
              <PropField
                key={k}
                prop={{ name: k, type: 'unknown' }}
                value={props[k]}
                onChange={(v) => set(k, v)}
              />
            ))}
          </div>
          {info.slot && <ContentField node={node} />}
        </>
      ) : (
        <div className="pw-empty">
          {project
            ? 'This component is no longer in the codebase.'
            : 'Link the codebase to edit props.'}
        </div>
      )}
    </section>
  )
}

function PropField({
  prop,
  value,
  onChange,
}: {
  prop: ComponentProp
  value: JsonValue | undefined
  onChange: (v: JsonValue | undefined) => void
}) {
  const placeholder =
    prop.default !== undefined ? `${prop.default} (default)` : prop.required ? 'required' : ''

  if (prop.type === 'boolean')
    return (
      <label className="pw-prop bool">
        <span>{prop.name}</span>
        <input
          type="checkbox"
          checked={value === undefined ? prop.default === 'true' : !!value}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    )

  if (prop.type === 'enum')
    return (
      <label className="pw-prop">
        <span>{prop.name}</span>
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">{prop.default ? `${prop.default} (default)` : '—'}</option>
          {prop.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    )

  return <TextProp prop={prop} value={value} placeholder={placeholder} onChange={onChange} />
}

function TextProp({
  prop,
  value,
  placeholder,
  onChange,
}: {
  prop: ComponentProp
  value: JsonValue | undefined
  placeholder: string
  onChange: (v: JsonValue | undefined) => void
}) {
  const shown =
    value === undefined ? '' : String(value) === value ? String(value) : JSON.stringify(value)

  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])

  const commit = () => {
    if (draft === shown) return

    if (draft === '') return onChange(undefined)

    if (prop.type === 'number') return onChange(Number(draft))

    if (prop.type === 'object' || prop.type === 'unknown') {
      try {
        return onChange(JSON.parse(draft))
      } catch {}
    }

    onChange(draft)
  }

  return (
    <label className="pw-prop">
      <span>{prop.name}</span>
      <input
        value={draft}
        placeholder={placeholder}
        type={prop.type === 'number' ? 'number' : 'text'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

function ContentField({ node }: { node: PNode }) {
  const [draft, setDraft] = useState(node.content ?? '')
  useEffect(() => setDraft(node.content ?? ''), [node.content, node.id])

  return (
    <>
      <div className="pw-subhead">Children</div>
      <textarea
        className="pw-code"
        spellCheck={false}
        rows={Math.min(10, Math.max(2, draft.split('\n').length + 1))}
        value={draft}
        placeholder="Text or markup, e.g. <CardTitle>Plan</CardTitle>"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() =>
          draft !== (node.content ?? '') &&
          store.tx(
            [{ t: 'patch', id: node.id, patch: { content: draft || null } }],
            'edit children',
          )
        }
        onKeyDown={(e) => e.stopPropagation()}
      />
    </>
  )
}

/** A token value with var(--x) references followed through. */
export function resolveToken(v: string): string {
  const m = v.match(/^var\((--[\w-]+)\)$/)

  if (!m) return v
  const t = store.doc?.tokens.find((x) => x.name === m[1])

  return t ? resolveToken(String(t.value)) : v
}

// ---- selection -----------------------------------------------------------------

function NodePanel({ nodes }: { nodes: PNode[] }) {
  const n = nodes[0]
  const multi = nodes.length > 1
  const rect = useWorldRects(multi ? [] : [n.id])[n.id]
  const types = new Set(nodes.map((x) => x.type))
  const allText = types.size === 1 && types.has('Text')
  const topLevel = !multi && !!n.parent && store.node(n.parent)?.type === 'Root'

  const setStyle = (prop: string, value: string) => {
    const ops: Op[] = nodes.map((x) => ({
      t: 'styles',
      id: x.id,
      set: { [prop]: value.trim() === '' ? null : value.trim() },
    }))

    store.tx(ops, `set ${prop}`)
  }

  return (
    <>
      <section className="pw-section pw-node-head">
        <span className="pw-node-icon">
          <NodeIcon type={n.type} top={topLevel} />
        </span>
        {multi ? (
          <span className="pw-node-title">{nodes.length} layers</span>
        ) : (
          <input
            key={n.id + n.name}
            className="pw-name-input"
            defaultValue={n.name}
            onBlur={(e) => rename(n.id, e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        )}
        <span className="pw-badge">
          {multi ? 'Mixed' : topLevel && n.type === 'Frame' ? 'Artboard' : n.type}
        </span>
      </section>

      <section className="pw-section">
        <header className="pw-section-head">
          <span>Frame</span>
        </header>
        <div className="pw-grid2">
          {!multi && isMovable(n.id) ? (
            <>
              <StyleField
                nodes={nodes}
                prop="left"
                label="X"
                onSet={setStyle}
                placeholder={fmt(rect?.x)}
              />
              <StyleField
                nodes={nodes}
                prop="top"
                label="Y"
                onSet={setStyle}
                placeholder={fmt(rect?.y)}
              />
            </>
          ) : null}
          <StyleField
            nodes={nodes}
            prop="width"
            label="W"
            onSet={setStyle}
            placeholder={fmt(rect?.width)}
          />
          <StyleField
            nodes={nodes}
            prop="height"
            label="H"
            onSet={setStyle}
            placeholder={fmt(rect?.height)}
          />
        </div>
      </section>

      {!multi && n.type === 'Component' && <ComponentProps node={n} />}

      {!multi && allText && (
        <section className="pw-section">
          <header className="pw-section-head">
            <span>Text</span>
          </header>
          <TextContent node={n} />
        </section>
      )}

      {!multi && <CssEditor node={n} />}
      {!multi && <ExportPanel node={n} />}
    </>
  )
}

function fmt(v: number | undefined) {
  return v === undefined ? '' : String(Math.round(v * 10) / 10)
}

function common(nodes: PNode[], prop: string): { value: string; mixed: boolean } {
  const vals = new Set(
    nodes.map((n) => (n.styles[prop] === undefined ? '' : String(n.styles[prop]))),
  )

  return vals.size > 1 ? { value: '', mixed: true } : { value: [...vals][0] ?? '', mixed: false }
}

function StyleField({
  nodes,
  prop,
  label,
  onSet,
  placeholder,
  color,
  wide,
}: {
  nodes: PNode[]
  prop: string
  label: string
  onSet: (prop: string, v: string) => void
  placeholder?: string
  color?: boolean
  wide?: boolean
}) {
  const { value, mixed } = common(nodes, prop)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value, nodes[0]?.id])

  const commit = () => {
    if (draft !== value)
      onSet(
        prop,
        /^-?\d+(\.\d+)?$/.test(draft.trim()) &&
          !['opacity', 'fontWeight', 'lineHeight', 'flexGrow', 'zIndex'].includes(prop)
          ? `${draft.trim()}px`
          : draft,
      )
  }

  return (
    <label className={`pw-field ${wide ? 'wide' : ''}`}>
      <span className="pw-field-label">{label}</span>
      {color && (
        <span
          className="pw-swatch"
          style={{ background: value ? resolveToken(value) : 'transparent' }}
        />
      )}
      <input
        value={draft}
        placeholder={mixed ? 'Mixed' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()

          if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }

          e.stopPropagation()
        }}
      />
    </label>
  )
}

function TextContent({ node }: { node: PNode }) {
  const [draft, setDraft] = useState(node.text ?? '')
  useEffect(() => setDraft(node.text ?? ''), [node.text, node.id])

  return (
    <textarea
      className="pw-textarea"
      rows={Math.min(6, Math.max(2, draft.split('\n').length))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() =>
        draft !== node.text &&
        store.tx([{ t: 'patch', id: node.id, patch: { text: draft } }], 'edit text')
      }
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}

function CssEditor({ node }: { node: PNode }) {
  const css = useMemo(
    () => stylesToCss(node.styles, ';\n') + (Object.keys(node.styles).length ? ';' : ''),
    [node.styles],
  )

  const [draft, setDraft] = useState(css)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setDraft(css)
    setDirty(false)
  }, [css, node.id])

  const apply = () => {
    const next = parseStyleAttr(draft)
    const set: Record<string, StyleValue | null> = {}

    for (const k of Object.keys(node.styles)) if (!(k in next)) set[k] = null

    for (const [k, v] of Object.entries(next)) if (String(node.styles[k]) !== String(v)) set[k] = v

    if (Object.keys(set).length) store.tx([{ t: 'styles', id: node.id, set }], 'edit css')
    setDirty(false)
  }

  return (
    <section className="pw-section">
      <header className="pw-section-head">
        <span>CSS</span>
        {dirty && (
          <button className="pw-text-btn" onClick={apply}>
            Apply ⌘↵
          </button>
        )}
      </header>
      <textarea
        className="pw-code"
        spellCheck={false}
        rows={Math.min(18, Math.max(2, draft.split('\n').length + (draft ? 1 : 0)))}
        value={draft}
        placeholder="No styles yet"
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        onBlur={() => dirty && apply()}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            apply()
          }
        }}
      />
    </section>
  )
}

function ExportPanel({ node }: { node: PNode }) {
  const [msg, setMsg] = useState<string | null>(null)

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(null), 1400)
  }

  const copyJsx = async (format: 'tailwind' | 'inline-styles') => {
    const res = await fetch(`/api/jsx?file=${store.doc!.id}&node=${node.id}&format=${format}`)
    await navigator.clipboard.writeText(await res.text())
    flash(format === 'tailwind' ? 'Copied JSX + Tailwind' : 'Copied JSX')
  }

  return (
    <section className="pw-section">
      <header className="pw-section-head">
        <span>Copy as</span>
        {msg && <span className="pw-flash">{msg}</span>}
      </header>
      <div className="pw-btn-row quiet">
        <button className="pw-btn" onClick={() => void copyJsx('tailwind')}>
          Tailwind
        </button>
        <button className="pw-btn" onClick={() => void copyJsx('inline-styles')}>
          JSX
        </button>
        <button
          className="pw-btn"
          onClick={() => {
            void navigator.clipboard.writeText(
              toStaticHTML(store.doc!.nodes, node.id, undefined, { componentMarkup: true }),
            )
            flash('Copied HTML')
          }}
        >
          HTML
        </button>
      </div>
    </section>
  )
}
