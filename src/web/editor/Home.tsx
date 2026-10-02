import { useState } from 'react'
import type { ProjectInfo } from '../../shared/types'
import { store, useStore } from '../store'
import { SettingsDialog } from './DesignChecks'
import { Icon } from './icons'
import { InlineInput } from './InlineInput'
import { timeAgo, UpdateButton } from './Topbar'

// The home screen: every project the app knows (Scratch first), and adding a
// repo. Adding one sets it up behind the scenes: design/ for its files and the
// repo's .mcp.json for agents.

export function Home() {
  return (
    <div className="pw-app">
      <header className="pw-topbar pw-home-bar">
        <span className="pw-home-brand">Paperish</span>
        <UpdateButton />
      </header>
      <div className="pw-stage">
        <div className="pw-home">
          <div className="pw-home-col">
            <Projects />
          </div>
        </div>
        <SettingsDialog />
      </div>
    </div>
  )
}

function Projects() {
  const projects = useStore((s) => s.projects)
  const connected = useStore((s) => s.connected)
  const repos = projects.filter((p) => !p.scratch)
  const scratch = projects.find((p) => p.scratch)

  return (
    <>
      <header className="pw-home-head">
        <h1>Projects</h1>
        <span className="pw-btn-row quiet">
          <button
            className="pw-btn"
            title="Settings (⌘,)"
            onClick={() => store.setSettingsOpen(true)}
          >
            Settings
          </button>
          <button
            className="pw-preview-btn pw-home-add"
            disabled={!connected}
            onClick={() => store.send({ t: 'addProject' })}
          >
            <Icon.Plus /> Add project…
          </button>
        </span>
      </header>
      <div className="pw-home-list">
        {repos.map((p) => (
          <ProjectRow key={p.root} project={p} />
        ))}
        {!repos.length && connected && (
          <p className="pw-home-hint">
            Add a repo to design in it. Its designs are saved in <code>design/</code> and versioned
            with the code, and agents working in the repo connect to it on their own.
          </p>
        )}
      </div>
      {scratch && (
        <div className="pw-home-list scratch">
          <ProjectRow project={scratch} />
        </div>
      )}
    </>
  )
}

function ProjectRow({ project: p }: { project: ProjectInfo }) {
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const files = `${p.fileCount} ${p.fileCount === 1 ? 'file' : 'files'}`

  const content = (
    <>
      <span className="pw-home-icon">{p.scratch ? <Icon.File /> : <Icon.Folder />}</span>
      <span className="pw-home-text">
        {renaming ? (
          <InlineInput
            value={p.name}
            onDone={(v) => {
              setRenaming(false)

              if (v !== p.name) store.send({ t: 'renameProject', projectId: p.id, name: v })
            }}
          />
        ) : (
          <strong>{p.name}</strong>
        )}
        <span className="pw-home-path">
          {p.scratch ? 'Designs outside any repo' : p.root.replace(/^\/Users\/[^/]+/, '~')}
        </span>
      </span>
      <span className="pw-home-meta">
        {files}
        {p.updatedAt && ` · ${timeAgo(p.updatedAt)}`}
      </span>
    </>
  )

  return (
    <div
      className={`pw-home-row ${p.scratch ? '' : 'removable'}`}
      onMouseLeave={() => setConfirming(false)}
    >
      {renaming ? (
        <div className="pw-home-open">{content}</div>
      ) : (
        <button
          className="pw-home-open"
          onClick={() => store.send({ t: 'openProject', projectId: p.id })}
        >
          {content}
        </button>
      )}
      {!p.scratch && !renaming && (
        <span className="pw-home-actions">
          {confirming ? (
            <button
              className="pw-home-remove confirm"
              onClick={() => store.send({ t: 'removeProject', projectId: p.id })}
            >
              Remove
            </button>
          ) : (
            <>
              <button
                className="pw-home-remove"
                title="Rename"
                aria-label={`Rename ${p.name}`}
                onClick={() => setRenaming(true)}
              >
                <Icon.Edit size={13} />
              </button>
              <button
                className="pw-home-remove"
                title="Remove from the list (the repo keeps its files)"
                aria-label={`Remove ${p.name}`}
                onClick={() => setConfirming(true)}
              >
                <Icon.Close size={13} />
              </button>
            </>
          )}
        </span>
      )}
    </div>
  )
}
