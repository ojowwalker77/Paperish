// Packaged apps watch GitHub releases. A new version downloads in the
// background; the editor then offers a restart, or it installs on quit.

const FIRST_CHECK = 15_000

const EVERY = 60 * 60_000

export async function watchUpdates(ready: (version: string) => void) {
  const { autoUpdater } = (await import('electron-updater')).default
  autoUpdater.logger = null
  autoUpdater.on('update-downloaded', (info) => ready(info.version))

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e: Error) => console.warn('[paperish] update check failed:', e.message))

  setTimeout(check, FIRST_CHECK)
  setInterval(check, EVERY)

  return () => autoUpdater.quitAndInstall()
}
