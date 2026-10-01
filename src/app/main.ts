import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'

// The desktop app: the Paperish server runs in this (main) process, the editor
// is a window onto it, and the layout engine uses hidden windows of the same
// Chromium (src/server/browser.ts).

app.setName('Paperish')

const HELP = `Usage: paperish [--help] [--version]

A design canvas that agents edit over MCP.

Options:
  -h, --help     Print this help and exit
  -v, --version  Print the version and exit

Environment:
  PAPERISH_PORT  Server port (default 29980); agents connect to /mcp/<project id>
  PAPERISH_DATA  App data directory
`

const flags = process.argv.slice(1)

if (flags.some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

if (flags.some((a) => a === '--version' || a === '-v')) {
  process.stdout.write(`${app.getVersion()}\n`)
  process.exit(0)
}

// One app per machine: a second launch focuses this one (see 'second-instance').
const primary = app.requestSingleInstanceLock()

if (!primary) app.quit()

let origin = ''

/** Editor windows, as opposed to the engine's hidden ones. */
const editors = new Set<BrowserWindow>()

const mac = process.platform === 'darwin'

/** Matches --frame and --text, so the window's own chrome sits in the app's title bar. */
const frame = () =>
  nativeTheme.shouldUseDarkColors
    ? { color: '#141414', symbolColor: '#ededed', height: 44 }
    : { color: '#eaeaea', symbolColor: '#141414', height: 44 }

function openEditor(url = `${origin}/`) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Paperish',
    // The app draws its own 44px title bar; the traffic lights (or window controls) sit in it.
    titleBarStyle: 'hidden',
    ...(mac ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: frame() }),
    backgroundColor: frame().color,
    webPreferences: { sandbox: true, contextIsolation: true },
  })

  editors.add(win)
  win.on('closed', () => {
    editors.delete(win)

    if (!mac && !editors.size) app.quit()
  })
  win.once('ready-to-show', () => win.show())
  // Our own URLs (e.g. an artboard preview) open as app windows; anything else in the browser.
  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (nextUrl.startsWith(origin)) openEditor(nextUrl)
    else void shell.openExternal(nextUrl)

    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, navUrl) => {
    if (!navUrl.startsWith(origin)) {
      e.preventDefault()
      void shell.openExternal(navUrl)
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

nativeTheme.on('updated', () => {
  if (!mac) for (const win of editors) win.setTitleBarOverlay(frame())
})

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
    // SAFETY: caught from server listen; ErrnoException carries code when the port is busy.
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
    // SAFETY: caught from server listen; Error carries the startup failure message.
    dialog.showErrorBox(
      'Paperish could not start',
      busy ? `Port ${PORT} is already in use. Is another Paperish running?` : (e as Error).message,
    )

    return app.exit(1)
  }

  origin = ORIGIN
  openEditor()

  if (app.isPackaged) {
    // New releases download in the background and install on quit.
    const { autoUpdater } = (await import('electron-updater')).default
    autoUpdater.logger = null
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((e: Error) => console.warn('[paperish] update check failed:', e.message))
  }
})
