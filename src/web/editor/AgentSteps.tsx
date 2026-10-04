import { store, useStore } from '../store'
import { Icon } from './icons'

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function StepsStatus() {
  const n = useStore((s) => s.steps.length)
  const open = useStore((s) => s.stepsOpen)

  if (!n) return null

  return (
    <button
      className={`pw-status-item ${open ? 'on' : ''}`}
      title="What the agent changed, step by step"
      onClick={() => store.setStepsOpen(!open)}
    >
      {n} agent {n === 1 ? 'step' : 'steps'}
    </button>
  )
}

export function StepsCard() {
  const open = useStore((s) => s.stepsOpen)
  const steps = useStore((s) => s.steps)
  const readOnly = useStore((s) => s.view?.kind === 'branch')

  if (!open) return null

  return (
    <aside className="pw-inspect pw-lint" aria-label="Agent steps">
      <button
        className="pw-icon-btn pw-inspect-close"
        title="Close (Esc)"
        onClick={() => store.setStepsOpen(false)}
      >
        <Icon.Close size={13} />
      </button>
      <section className="pw-section">
        <header className="pw-section-head">
          <span>
            Agent steps <span className="pw-count">{steps.length || ''}</span>
          </span>
        </header>
        {!steps.length ? (
          <p className="pw-empty">No agent edits to undo.</p>
        ) : (
          <div className="pw-lint-list">
            {steps.map((s) => (
              <div key={s.id} className="pw-lint-row">
                <span className="pw-lint-dot" />
                <span className="pw-lint-text">
                  <span>{s.why ?? s.tools.join(', ')}</span>
                  <span className="pw-lint-detail">
                    {time(s.at)}
                    {s.why && ` · ${s.tools.join(', ')}`}
                    {s.reverted && ' · Reverted'}
                  </span>
                </span>
                {!s.reverted && !readOnly && (
                  <button
                    className="pw-lint-fix"
                    title="Undo just this step"
                    onClick={() => store.revertStep(s.id)}
                  >
                    Revert
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
