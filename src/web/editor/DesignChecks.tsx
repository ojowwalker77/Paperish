import { useState } from 'react'
import type { LintState } from '../../shared/types'
import { store, useStore } from '../store'
import { reveal } from './actions'
import { Icon } from './icons'

// Design checks against the repo's DESIGN.md, so a team without a designer
// still ships consistent screens: the status bar count, the issues card, and
// the OpenRouter key that lets Jev judge the Do's and Don'ts.

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const [key, setKey] = useState('')

  if (!open || !settings) return null

  const close = () => {
    setKey('')
    store.setSettingsOpen(false)
  }

  const saveKey = () => {
    if (key.trim()) store.saveSettings({ openRouterKey: key.trim() })
    close()
  }

  return (
    <div
      className="pw-modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="pw-modal"
        role="dialog"
        aria-label="Settings"
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Escape') close()
        }}
      >
        <header className="pw-modal-head">
          <span>Settings</span>
        </header>
        <p className="pw-modal-text">
          Designs are checked against the repo's DESIGN.md. Its Do's and Don'ts are judged by Jev
          through OpenRouter, with your key. The key stays in Paperish's data folder on this
          machine.
        </p>
        <input
          className="pw-modal-input"
          type="password"
          autoFocus
          spellCheck={false}
          placeholder={
            settings.openRouter
              ? 'OpenRouter key saved. Paste a new one to replace it'
              : 'OpenRouter API key (sk-or-…)'
          }
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveKey()}
        />
        <footer className="pw-modal-foot">
          {settings.openRouter && (
            <button
              className="pw-btn pw-foot-left"
              onClick={() => {
                store.saveSettings({ openRouterKey: '' })
                close()
              }}
            >
              Remove key
            </button>
          )}
          <button className="pw-btn" onClick={close}>
            Cancel
          </button>
          <button className="pw-btn primary" disabled={!key.trim()} onClick={saveKey}>
            Save key
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Status bar: which DESIGN.md is in effect, and the issue count (opens the card). */
export function DesignStatus() {
  const lint = useStore((s) => s.lint)
  const open = useStore((s) => s.lintOpen)

  if (!lint) return null
  const n = lint.issues.length

  return (
    <>
      <span
        className="pw-status-item"
        title={
          lint.designMd ?? 'Add a DESIGN.md at the repo root to check designs against your system'
        }
      >
        <Icon.File size={12} /> {lint.designMd ? 'DESIGN.md' : 'No DESIGN.md'}
      </span>
      <button
        className={`pw-status-item ${open ? 'on' : ''}`}
        title="Design issues (L)"
        onClick={() => store.setLintOpen(!open)}
      >
        {n > 0 && (
          <span
            className={`pw-lint-dot ${lint.issues.some((i) => i.severity === 'error') ? 'error' : ''}`}
          />
        )}
        {n ? `${n} ${n === 1 ? 'issue' : 'issues'}` : 'No issues'}
      </button>
    </>
  )
}

export function LintCard() {
  const open = useStore((s) => s.lintOpen)
  const lint = useStore((s) => s.lint)
  const readOnly = useStore((s) => s.view?.kind === 'branch')

  if (!open) return null
  const issues = lint?.issues ?? []
  const fixes = issues.flatMap((i) => i.fix ?? [])
  const several = new Set(issues.map((i) => i.artboard)).size > 1

  return (
    <aside className="pw-inspect pw-lint" aria-label="Design issues">
      <button
        className="pw-icon-btn pw-inspect-close"
        title="Close (Esc)"
        onClick={() => store.setLintOpen(false)}
      >
        <Icon.Close size={13} />
      </button>
      <section className="pw-section">
        <header className="pw-section-head">
          <span>
            Issues <span className="pw-count">{issues.length || ''}</span>
          </span>
        </header>
        {!lint ? (
          <p className="pw-empty">Checking…</p>
        ) : !issues.length ? (
          <p className="pw-empty">Nothing to fix on this page.</p>
        ) : (
          <div className="pw-lint-list">
            {issues.map((i) => (
              <div
                key={i.id}
                className="pw-lint-row"
                onClick={() => {
                  store.select(i.nodeIds)
                  reveal(i.nodeIds)
                }}
              >
                <span className={`pw-lint-dot ${i.severity}`} />
                <span className="pw-lint-text">
                  <span>{i.title}</span>
                  <span className="pw-lint-detail">
                    {several && `${i.artboard} · `}
                    {i.detail}
                  </span>
                </span>
                {i.fix && !readOnly && (
                  <button
                    className="pw-lint-fix"
                    onClick={(e) => {
                      e.stopPropagation()
                      store.tx(i.fix!, `fix ${i.title.toLowerCase()}`)
                    }}
                  >
                    Fix
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {fixes.length > 0 && !readOnly && (
          <button
            className="pw-btn pw-lint-all"
            onClick={() => store.tx(fixes, 'fix design issues')}
          >
            Fix all
          </button>
        )}
      </section>
      {lint && (
        <section className="pw-section pw-lint-foot">
          <Source lint={lint} />
        </section>
      )}
    </aside>
  )
}

function Source({ lint }: { lint: LintState }) {
  if (lint.error) return <span className="pw-lint-error">{lint.error}</span>
  const { count, status, error } = lint.rules
  const rules = count === 1 ? "1 Do or Don't" : `${count} Do's and Don'ts`

  return (
    <>
      <span>
        {lint.designMd
          ? 'Checked against DESIGN.md.'
          : 'No DESIGN.md in this repo, so only contrast and the 4px grid are checked.'}
      </span>
      {status === 'checked' && <span> Jev checked {rules}.</span>}
      {status === 'no-key' && (
        <span>
          {' '}
          {rules} need an OpenRouter key.{' '}
          <button onClick={() => store.setSettingsOpen(true)}>Add key</button>
        </span>
      )}
      {status === 'error' && <span className="pw-lint-error"> Jev: {error}</span>}
    </>
  )
}
