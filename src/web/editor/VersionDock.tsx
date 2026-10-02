import { useMemo, type CSSProperties } from 'react'
import { NodeView } from '../render/NodeView'
import { DesignScope } from '../render/World'
import { shallow, useStore } from '../store'
import { px } from './actions'
import { Icon } from './icons'
import { focusBoard, newVersion, versionNumber, viewOf } from './views'

// The focused view's versions, side by side under the canvas: [ and ] step
// through them, and New copies the one shown into the next.

const THUMB_W = 72

const THUMB_H = 45

const OFF_CANVAS: CSSProperties = { position: 'relative', left: 'auto', top: 'auto' }

export function VersionDock() {
  const focus = useStore((s) => s.focus)
  const picking = useStore((s) => !!s.proposal)
  const readOnly = useStore((s) => s.view?.kind === 'branch')
  const versions = useStore((s) => viewOf(s.focus)?.versions ?? [], shallow)
  const nav = useStore((s) => s.navOpen)

  if (!focus || picking) return null

  return (
    <div className={`pw-dock ${nav ? 'nav' : ''}`} role="toolbar" aria-label="Versions">
      <kbd>[</kbd>
      {versions.map((id) => (
        <Version key={id} id={id} on={id === focus} />
      ))}
      {!readOnly && (
        <>
          <span className="pw-pick-sep" />
          <button
            className="pw-dock-new"
            title="Copy this version into a new one"
            onClick={newVersion}
          >
            <Icon.Plus size={13} />
            New
          </button>
        </>
      )}
      <kbd>]</kbd>
    </div>
  )
}

function Version({ id, on }: { id: string; on: boolean }) {
  const name = useStore((s) => s.node(id)?.name ?? '')
  const width = useStore((s) => px(s.node(id)?.styles.width))
  const scale = width ? THUMB_W / width : 0.05

  const inner = useMemo<CSSProperties>(
    () => ({ transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: 'none' }),
    [scale],
  )

  return (
    <button
      className={`pw-dock-version ${on ? 'on' : ''}`}
      title={name}
      onClick={() => focusBoard(id)}
    >
      <span className="pw-dock-thumb" style={{ width: THUMB_W, height: THUMB_H }} inert>
        <DesignScope style={inner}>
          <NodeView id={id} override={OFF_CANVAS} />
        </DesignScope>
      </span>
      <span className="pw-dock-label">v{versionNumber(name)}</span>
    </button>
  )
}
