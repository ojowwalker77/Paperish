import { createElement, memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { stylesToCss } from '../../shared/styles'
import { RENDER_TAGS } from '../../shared/tags'
import type { PNode } from '../../shared/types'
import { useEditingText, useNode } from '../store'
import { ComponentView } from './ComponentView'

// Renders a design node as a real DOM element. Every node carries
// data-pid so the editor overlay and the layout engine can find it.

function tagOf(n: PNode): string {
  const t = n.tag?.toLowerCase()

  return t && RENDER_TAGS.has(t) ? t : n.type === 'Text' ? 'span' : 'div'
}

/** Table cells keep their spans. */
function cellProps(n: PNode, tag: string) {
  if ((tag !== 'td' && tag !== 'th') || !n.attrs) return {}
  const out: Record<string, number> = {}

  if (n.attrs.colspan) out.colSpan = Number(n.attrs.colspan)

  if (n.attrs.rowspan) out.rowSpan = Number(n.attrs.rowspan)

  return out
}

function styleOf(n: PNode, top: boolean): CSSProperties {
  const s = { ...n.styles }

  if (top) {
    s.position = 'absolute'

    if (s.overflow === undefined && s.overflowX === undefined && s.overflowY === undefined)
      s.overflow = 'hidden'

    if (s.left === undefined) s.left = 0

    if (s.top === undefined) s.top = 0
  }

  if (n.type === 'Text' && s.whiteSpace === undefined) s.whiteSpace = 'pre-wrap'

  // SAFETY: s holds validated Styles (string|number values) accepted by React CSSProperties.
  return s as CSSProperties
}

/**
 * `override` is merged over the root node's styles only; the preview uses it
 * to take an artboard off the canvas (position/left/top) or make it responsive.
 *
 * Each view subscribes to its own node only, and children are the memoized
 * `NodeView` (not the inner function), so an edit re-renders just that node.
 */
export const NodeView = memo(NodeViewImpl)

function NodeViewImpl({
  id,
  top = false,
  override,
}: {
  id: string
  top?: boolean
  override?: CSSProperties
}) {
  const n = useNode(id)
  const editing = useEditingText(id) && !override

  const style = useMemo(
    () => (n ? { ...styleOf(n, top), ...override } : undefined),
    [n?.styles, n?.type, top, override],
  )

  if (!n || n.hidden) return null

  switch (n.type) {
    case 'Text': {
      const tag = tagOf(n)
      const base = { 'data-pid': id, style, key: editing ? 'edit' : 'view', ...cellProps(n, tag) }

      const props = editing
        ? {
            ...base,
            contentEditable: 'plaintext-only' as const,
            suppressContentEditableWarning: true,
          }
        : base

      return createElement(tag, props, n.text)
    }

    case 'Image':
      return (
        <img data-pid={id} src={n.src} alt={n.attrs?.alt ?? ''} style={style} draggable={false} />
      )
    case 'SVG':
      return <SvgView n={n} style={style!} />
    case 'Component':
      return <ComponentView n={n} style={style!} />
    default: {
      const tag = tagOf(n)

      return createElement(
        tag,
        { 'data-pid': id, style, ...cellProps(n, tag) },
        n.children.map((c) => <NodeView key={c} id={c} />),
      )
    }
  }
}

function SvgView({ n, style }: { n: PNode; style: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const host = ref.current

    if (!host) return
    host.innerHTML = n.svg ?? ''
    const svg = host.firstElementChild

    if (!svg) return
    svg.setAttribute('data-pid', n.id)
    // SAFETY: style originates from styleOf plus preview overrides, all string|number CSS values.
    svg.setAttribute('style', stylesToCss(style as Record<string, string>))
  }, [n.svg, n.id, style])

  return <span ref={ref} style={{ display: 'contents' }} />
}
