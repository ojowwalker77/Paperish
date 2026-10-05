import { useMemo, type CSSProperties } from 'react'
import { versionNumber, type View } from '../../shared/views'
import { NodeView } from '../render/NodeView'
import { DesignScope } from '../render/World'
import { shallow, useStore } from '../store'
import { px } from './actions'
import { Icon } from './icons'
import { focusBoard, newVersion, viewOf } from './views'

// The focused view's versions, side by side under the canvas: [ and ] step
// through them, and Fork branches a new one off the one shown.

const THUMB_W = 72

const THUMB_H = 45

const OFF_CANVAS: CSSProperties = { position: 'relative', left: 'auto', top: 'auto' }

export function VersionDock() {
  const focus = useStore((s) => s.focus)
  const picking = useStore((s) => !!s.proposal || !!s.knobs)
  const readOnly = useStore((s) => s.view?.kind === 'branch')
  const versions = useStore((s) => viewOf(s.focus)?.versions ?? [], shallow)
  const branches = useStore((s) => branchPoints(viewOf(s.focus)), shallow)
  const why = useStore((s) => s.node(s.focus)?.fork?.why)

  if (!focus || picking) return null

  return (
    <div className="pw-dock" role="toolbar" aria-label="Versions">
      {why && <div className="pw-dock-why">{why}</div>}
      <kbd>[</kbd>
      {versions.map((id, i) => (
        <Version key={id} id={id} on={id === focus} from={branches[i]} />
      ))}
      {!readOnly && (
        <>
          <span className="pw-pick-sep" />
          <button
            className="pw-dock-new"
            title="Branch a new version off this one"
            onClick={newVersion}
          >
            <Icon.Plus size={13} />
            Fork
          </button>
        </>
      )}
      <kbd>]</kbd>
    </div>
  )
}

function Version({ id, on, from }: { id: string; on: boolean; from?: string }) {
  const name = useStore((s) => s.node(id)?.name ?? '')
  const why = useStore((s) => s.node(id)?.fork?.why)
  const parent = useStore((s) => (from ? s.node(from)?.name : undefined))
  const width = useStore((s) => px(s.node(id)?.styles.width))
  const scale = width ? THUMB_W / width : 0.05

  const inner = useMemo<CSSProperties>(
    () => ({ transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: 'none' }),
    [scale],
  )

  return (
    <button
      className={`pw-dock-version ${on ? 'on' : ''}`}
      title={why ? `${name}: ${why}` : name}
      onClick={() => focusBoard(id)}
    >
      <span className="pw-dock-thumb" style={{ width: THUMB_W, height: THUMB_H }} inert>
        <DesignScope style={inner}>
          <NodeView id={id} override={OFF_CANVAS} />
        </DesignScope>
      </span>
      <span className="pw-dock-label">
        v{versionNumber(name)}
        {parent && <span className="pw-dock-from"> from v{versionNumber(parent)}</span>}
      </span>
    </button>
  )
}

function branchPoints(view?: View): (string | undefined)[] {
  if (!view) return []
  const { versions, from } = view

  return versions.map((id, i) => (from[id] !== versions[i - 1] ? from[id] : undefined))
}
