import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { iconComponents } from '../../shared/icons'
import { parseMarkup } from '../../shared/markup'
import type { PNode } from '../../shared/types'
import { useStore } from '../store'

// A real component from the linked codebase, rendered by the project's own
// dev server inside an iframe (so its CSS, framework version and CSS-in-JS stay
// isolated from the editor). Props and children are sent via postMessage and
// the host reports the rendered size back.

/** True in Preview: component instances receive pointer events. */
export const InteractiveContext = createContext(false)

const INTRINSIC = new Set(['fit-content', 'auto', 'max-content', 'min-content'])

function hasExplicitWidth(styles: PNode['styles']): boolean {
  const w = styles.width

  return (
    (w !== undefined && !INTRINSIC.has(String(w))) ||
    (styles.flexGrow !== undefined && Number(styles.flexGrow) > 0) ||
    styles.flex !== undefined
  )
}

/** An explicit height makes the instance a fixed-size viewport (e.g. a full screen). */
function hasExplicitHeight(styles: PNode['styles']): boolean {
  const h = styles.height

  return h !== undefined && !INTRINSIC.has(String(h))
}

export function ComponentView({ n, style }: { n: PNode; style: CSSProperties }) {
  const project = useStore((s) => s.project)
  const interactive = useContext(InteractiveContext)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const iid = useMemo(() => Math.random().toString(36).slice(2), [])
  const origin = project?.status === 'ready' ? project.hostOrigin : undefined
  const fill = hasExplicitWidth(n.styles)
  const fillHeight = hasExplicitHeight(n.styles)
  const components = project?.components
  const icons = project?.icons

  const parsed = useMemo(
    () => parseMarkup(n.content, [...(components ?? []), ...iconComponents(icons)]),
    [n.content, components, icons],
  )

  const payload = useMemo(
    () => ({
      type: 'pw:render',
      component: n.component?.id,
      props: n.props ?? {},
      tree: parsed.nodes,
      refs: parsed.refs,
      fill,
    }),
    [n.component?.id, n.props, parsed, fill],
  )

  const latest = useRef(payload)
  latest.current = payload

  useEffect(() => {
    ready.current = false

    if (!origin) return

    const onMsg = (e: MessageEvent) => {
      const win = frame.current?.contentWindow

      if (!win || e.source !== win || !e.data?.__paperish) return

      // SAFETY: checked e.source is our iframe and __paperish flag; host only sends pw:* render messages.
      const d = e.data as {
        type: string
        w?: number
        h?: number
        message?: string
        issues?: string[]
      }

      if (d.type === 'pw:ready') {
        ready.current = true
        win.postMessage(latest.current, origin)
      } else if (d.type === 'pw:size') setSize({ w: d.w!, h: d.h! })
      else if (d.type === 'pw:rendered') {
        setState('ready')
        setError(null)
        setIssues(d.issues ?? [])
      } else if (d.type === 'pw:error') {
        setState('error')
        setError(d.message ?? 'Render error')
      }
    }

    window.addEventListener('message', onMsg)

    return () => window.removeEventListener('message', onMsg)
  }, [origin])

  useEffect(() => {
    if (ready.current && origin) frame.current?.contentWindow?.postMessage(payload, origin)
  }, [payload, origin])

  const wrapper: CSSProperties = {
    ...style,
    position: style.position ?? 'relative',
  }

  if (!fill) wrapper.width = style.width ?? 'fit-content'

  if (!origin) {
    const label = !project
      ? 'Codebase not linked'
      : project.status === 'error'
        ? `Codebase error: ${project.error}`
        : 'Starting codebase…'

    return (
      <div
        data-pid={n.id}
        data-component-state={project?.status === 'starting' ? 'loading' : 'error'}
        data-component-error={project?.status === 'starting' ? undefined : label}
        className="pw-comp-placeholder"
        style={wrapper}
        title={label}
      >
        <span className="pw-comp-name">{n.component?.name ?? n.name}</span>
        <span className="pw-comp-note">{label}</span>
      </div>
    )
  }

  return (
    <div
      data-pid={n.id}
      data-component-state={state}
      data-component-error={state === 'error' ? (error ?? '') : undefined}
      data-component-issues={state === 'ready' && issues.length ? issues.join('\n') : undefined}
      style={wrapper}
    >
      <iframe
        ref={frame}
        src={`${origin}/__paperish/host.html?iid=${iid}`}
        title={n.name}
        tabIndex={interactive ? 0 : -1}
        style={{
          display: 'block',
          border: 0,
          width: fill ? '100%' : (size?.w ?? 0),
          height: fillHeight ? '100%' : (size?.h ?? 0),
          pointerEvents: interactive ? 'auto' : 'none',
          background: 'transparent',
          colorScheme: 'normal',
        }}
      />
      {state === 'loading' && !size && <div className="pw-comp-loading">{n.component?.name}</div>}
      {state === 'error' && (
        <div className="pw-comp-error" title={error ?? ''}>
          {n.component?.name}: {error}
        </div>
      )}
      {state === 'ready' && issues.length > 0 && (
        <div className="pw-comp-error pw-comp-issue" title={issues.join('\n')}>
          {n.component?.name}: {issues[0]}
        </div>
      )}
    </div>
  )
}
