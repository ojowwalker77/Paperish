import { memo, useMemo, type CSSProperties, type ReactNode } from 'react'
import { fontFaceCss } from '../../shared/fontfaces'
import { canvasResetCss } from '../../shared/reset'
import { useStore } from '../store'
import { NodeView } from './NodeView'

const RESET = canvasResetCss('.pw-design')

/** Everything a design needs to render: the UA reset, token variables and fonts. */
export function DesignScope({
  style,
  className,
  children,
}: {
  style?: CSSProperties
  className?: string
  children: ReactNode
}) {
  const tokens = useStore((s) => s.doc?.tokens)
  const faces = useStore((s) => s.doc?.fontFaces)
  const faceCss = useMemo(() => fontFaceCss(faces), [faces])

  const vars = useMemo(() => {
    const v: Record<string, string> = {}

    for (const t of tokens ?? []) v[t.name] = String(t.value)

    return v
  }, [tokens])

  return (
    <div className={`pw-design ${className ?? ''}`} style={{ ...vars, ...style }}>
      <style>{RESET}</style>
      {faceCss && <style>{faceCss}</style>}
      {children}
    </div>
  )
}

/** The design itself: page root children rendered in world coordinates. */
export const World = memo(function World({
  style,
  className,
}: {
  style?: CSSProperties
  className?: string
}) {
  const rootId = useStore((s) => s.page?.rootId)
  const children = useStore((s) => (rootId ? s.doc?.nodes[rootId]?.children : undefined))

  return (
    <DesignScope className={`pw-world ${className ?? ''}`} style={style}>
      {children?.map((id) => (
        <NodeView key={id} id={id} top />
      ))}
    </DesignScope>
  )
})
