import { useEffect } from 'react'
import { store, useStore } from '../store'
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  isTyping,
  openPreview,
  nudge,
  setHidden,
  setLocked,
  paste,
  selectChildren,
  selectParent,
  zoomBy,
  zoomTo,
  zoomToFit,
} from './actions'
import { Viewer } from '../Viewer'
import { Canvas } from './Canvas'
import { ImportDialog } from './ImportDialog'
import { Inspector } from './Inspector'
import { Navigator } from './Navigator'
import { Palette } from './Palette'
import { Home } from './Home'
import { LintCard, SettingsDialog } from './DesignChecks'
import { PickBar } from './Pick'
import { CommentsPanel } from './Comments'
import { ChangesView } from './Repo'
import { StatusBar } from './StatusBar'
import { Topbar } from './Topbar'
import { VersionDock } from './VersionDock'
import { newVersion, stepVersion, stepView, unfocus } from './views'

export function Editor() {
  // Coarse on purpose: this component owns the whole editor tree.
  const loaded = useStore((s) => !!s.doc)
  const home = useStore((s) => s.home)
  const preview = useStore((s) => s.preview)
  useShortcuts()

  if (home) return <Home />

  return (
    <div className="pw-app">
      {/* The title bar holds the toolbar; everything else lives in the stage below it. */}
      <Topbar />
      <div className="pw-stage">
        {/* No sidebars: the canvas is the stage. ⌘K finds things, I inspects, the status bar has the rest. */}
        <main className="pw-main">
          <Canvas />
          {!loaded && <div className="pw-loading">Connecting…</div>}
        </main>
        <Navigator />
        <Inspector />
        <LintCard />
        <PickBar />
        <VersionDock />
        <CommentsPanel />
        <Palette />
        <SettingsDialog />
        <ImportDialog />
        <ChangesView />
        {preview && (
          <Viewer
            id={preview}
            onNavigate={(id) => {
              store.setPreview(id)
              store.select([id])
            }}
            onClose={() => store.setPreview(null)}
          />
        )}
      </div>
      <StatusBar />
    </div>
  )
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !store.home)
        return (e.preventDefault(), store.palette ? store.closePalette() : store.openPalette())

      if ((e.metaKey || e.ctrlKey) && e.key === '\\' && !store.home)
        return (e.preventDefault(), store.setNavOpen(!store.navOpen))

      if ((e.metaKey || e.ctrlKey) && e.key === ',')
        return (e.preventDefault(), store.setSettingsOpen(true))

      if (
        isTyping(e) ||
        store.palette ||
        store.preview ||
        store.importOpen ||
        store.changesOpen ||
        store.settingsOpen ||
        store.home
      )
        return

      if (e.key === '?') return (e.preventDefault(), store.setHelpOpen(!store.helpOpen))

      if (e.key === 'Escape' && store.helpOpen) return store.setHelpOpen(false)
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      const handled = () => e.preventDefault()

      if (mod && k === 'z') return (handled(), store.send({ t: e.shiftKey ? 'redo' : 'undo' }))

      if (mod && k === 'y') return (handled(), store.send({ t: 'redo' }))

      if (mod && e.shiftKey && k === 'h')
        return (
          handled(),
          store.selection.forEach((id) => setHidden(id, !store.node(store.selection[0])?.hidden))
        )

      if (mod && e.shiftKey && k === 'l')
        return (
          handled(),
          store.selection.forEach((id) => setLocked(id, !store.node(store.selection[0])?.locked))
        )

      if (mod && k === 'd') return (handled(), void duplicateSelection())

      if (mod && e.shiftKey && k === 'n' && store.focus) return (handled(), void newVersion())

      if (mod && k === 'a') {
        handled()

        const parent =
          store.node(store.node(store.selection[0])?.parent) ?? store.node(store.page?.rootId)

        return store.select(parent?.children ?? [])
      }

      if (mod && (k === '=' || k === '+')) return (handled(), zoomBy(1.25))

      if (mod && k === '-') return (handled(), zoomBy(0.8))

      if (mod && k === '0') return (handled(), zoomTo(1))

      if (mod) return

      const option =
        !e.shiftKey && store.proposal?.options.find((o) => o.letter.toLowerCase() === k)

      if (option) return (handled(), store.pick(option.nodeId))

      if (e.shiftKey && e.code === 'Digit1') return (handled(), zoomToFit())

      if (e.altKey && (k === 'arrowup' || k === 'arrowdown'))
        return (handled(), stepView(k === 'arrowup' ? -1 : 1))

      if (store.focus && (e.key === '[' || e.key === ']'))
        return (handled(), stepVersion(e.key === '[' ? -1 : 1))

      if (e.shiftKey && e.code === 'Digit2') return (handled(), zoomToFit(store.selection))

      if (e.shiftKey && e.code === 'KeyR') return (handled(), store.setRulers(!store.rulers))

      switch (k) {
        case 'backspace':
        case 'delete':
          return (handled(), deleteSelection())
        case 'escape':
          if (store.inspectOpen) return store.setInspectOpen(false)

          if (store.lintOpen) return store.setLintOpen(false)

          if (store.commentDraft) return store.startComment(null)

          if (store.activeThread) return store.openThread(null)

          if (store.tool !== 'move') return store.setTool('move')

          if (!store.selection.length && store.focus) return unfocus()

          return selectParent()
        case 'enter':
          return (handled(), selectChildren())
        case 'v':
          return store.setTool('move')
        case 'f':
        case 'a':
          return store.setTool('frame')
        case 't':
          return store.setTool('text')
        case 'c':
          return store.setTool(store.tool === 'comment' ? 'move' : 'comment')
        case 'h':
          return store.setTool('hand')
        case 'p':
          return (handled(), openPreview())
        case 'l':
          return (handled(), store.setLintOpen(!store.lintOpen))
        case 'i':
          return store.selection.length
            ? (handled(), store.setInspectOpen(!store.inspectOpen))
            : undefined
        case 'arrowleft':
          return (handled(), nudge(e.shiftKey ? -10 : -1, 0))
        case 'arrowright':
          return (handled(), nudge(e.shiftKey ? 10 : 1, 0))
        case 'arrowup':
          return (handled(), nudge(0, e.shiftKey ? -10 : -1))
        case 'arrowdown':
          return (handled(), nudge(0, e.shiftKey ? 10 : 1))
      }
    }

    const overlay = () => !!(store.preview || store.changesOpen || store.home || store.palette)
    const onCopy = (e: ClipboardEvent) => !isTyping(e) && !overlay() && copySelection(e)

    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e) || overlay()) return
      copySelection(e)
      deleteSelection()
    }

    const onPaste = (e: ClipboardEvent) => !isTyping(e) && !overlay() && void paste(e)
    window.addEventListener('keydown', onKey)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [])
}
