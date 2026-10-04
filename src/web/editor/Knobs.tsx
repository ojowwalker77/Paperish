import { useEffect, useRef, useState } from 'react'
import type { Knob } from '../../shared/types'
import { store, useNode, useStore } from '../store'
import { nodeEl, zoomToFit } from './actions'

export function KnobsBar() {
  const knobs = useStore((s) => s.knobs)
  const picking = useStore((s) => !!s.proposal)
  useEffect(() => {
    if (knobs) requestAnimationFrame(() => zoomToFit([knobs.nodeId]))
  }, [knobs?.id])

  if (!knobs || picking) return null

  return (
    <div className="pw-pick" role="dialog" aria-label="Knobs">
      {knobs.knobs.map((k) => (
        <KnobControl key={k.name} nodeId={knobs.nodeId} knob={k} />
      ))}
      <span className="pw-pick-sep" />
      <button className="pw-pick-none" onClick={() => store.closeKnobs()}>
        Done
      </button>
    </div>
  )
}

function KnobControl({ nodeId, knob }: { nodeId: string; knob: Knob }) {
  const css = String(useNode(nodeId)?.styles[knob.name] ?? '')
  const saved = knob.type === 'color' ? css : String(Number.parseFloat(css) || 0)
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const value = draft ?? saved
  const toCss = (v: string) => (knob.type === 'color' ? v : `${v}${knob.unit ?? ''}`)

  useEffect(() => {
    if (draft === saved) setDraft(null)
  }, [saved])

  useEffect(() => {
    const el = ref.current!
    const commit = () => el.value !== '' && store.turnKnob(knob.name, toCss(el.value))
    el.addEventListener('change', commit)

    return () => el.removeEventListener('change', commit)
  }, [knob])

  return (
    <label className="pw-knob" title={knob.name}>
      <span className="pw-knob-label">{knob.label}</span>
      <input
        ref={ref}
        type={knob.type === 'slider' ? 'range' : knob.type}
        className={`pw-knob-${knob.type}`}
        min={knob.min}
        max={knob.max}
        step={knob.step ?? 1}
        value={value}
        onChange={(e) => {
          setDraft(e.target.value)

          if (e.target.value !== '')
            nodeEl(nodeId)?.style.setProperty(knob.name, toCss(e.target.value))
        }}
        onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()}
      />
      {knob.type !== 'number' ? (
        <span className="pw-knob-value">{toCss(value)}</span>
      ) : (
        knob.unit && <span className="pw-knob-value">{knob.unit}</span>
      )}
    </label>
  )
}
