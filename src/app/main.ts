import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'

// The desktop app: the Paperish server runs in this (main) process, the editor
// is a window onto it, and the layout engine uses hidden windows of the same
// Chromium (src/server/browser.ts).

app.setName('Paperish')

// One app per machine: a second launch focuses this one (see 'second-instance').
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()

let origin = ''
/** Editor windows, as opposed to the engine's hidden ones. */
const editors = new Set<BrowserWindow>()

function openEditor(url = `${origin}/`) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Paperish',
    // The app draws its own 44px title bar; the traffic lights sit centred in it.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    // Matches --frame, so a new window doesn't flash the other theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#eaeaea',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  editors.add(win)
  win.on('closed', () => {
    editors.delete(win)
    if (process.platform !== 'darwin' && !editors.size) app.quit()
  })
  win.once('ready-to-show', () => win.show())
  // Our own URLs (e.g. an artboard preview) open as app windows; anything else in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) openEditor(url)
    else void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  void win.loadURL(url)
  return win
}

app.on('second-instance', () => {
  const [win] = editors
  if (!win) return void openEditor()
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on('activate', () => {
  if (origin && !editors.size) openEditor()
})

app.on('window-all-closed', () => {})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void import('../server/index').then((s) => s.shutdown()).finally(() => app.exit(0))
})

// No top-level await: Electron holds 'ready' until the entry module finishes evaluating.
void app.whenReady().then(async () => {
  if (!primary) return
  const { ORIGIN, PORT } = await import('../server/config')
  try {
    const server = await import('../server/index')
    await server.listening
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
    dialog.showErrorBox('Paperish could not start', busy ? `Port ${PORT} is already in use. Is another Paperish running?` : (e as Error).message)
    return app.exit(1)
  }
  origin = ORIGIN
  openEditor()
  if (app.isPackaged) {
    // New releases download in the background and install on quit.
    const { autoUpdater } = (await import('electron-updater')).default
    autoUpdater.logger = null
    autoUpdater.checkForUpdatesAndNotify().catch((e: Error) => console.warn('[paperish] update check failed:', e.message))
  }
})
