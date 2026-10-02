import type { UpdateState } from '../shared/types'

// Packaged apps watch GitHub releases. A new version downloads in the
// background, its progress in the title bar; the editor then offers a
// restart, or it installs on quit.

const FIRST_CHECK = 15_000

const EVERY = 60 * 60_000

export async function watchUpdates(report: (update: UpdateState) => void) {
  const { autoUpdater } = (await import('electron-updater')).default
  autoUpdater.logger = null

  let update: UpdateState | null = null

  const set = (next: UpdateState) => {
    update = next
    report(next)
  }

  autoUpdater.on('update-available', (info) => {
    if (update?.ready && update.version === info.version) return
    set({ version: info.version, percent: 0, ready: false })
  })
  autoUpdater.on('download-progress', (p) => {
    if (update && !update.ready) set({ ...update, percent: Math.floor(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) =>
    set({ version: info.version, percent: 100, ready: true }),
  )

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e: Error) => console.warn('[paperish] update check failed:', e.message))

  setTimeout(check, FIRST_CHECK)
  setInterval(check, EVERY)

  return () => autoUpdater.quitAndInstall()
}
