import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { startServer } from './host'
import { watchUpdates } from './updater'

// The desktop app: the Paperish server runs in a utility process (./host.ts),
// the editor is a window onto it, and the layout engine uses hidden windows of
// the same Chromium (./browser.ts).

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

let server: ReturnType<typeof startServer> | null = null

let install: (() => void) | null = null

/** Save everything first: the updater quits on its own, past 'before-quit'. */
function installUpdate() {
  if (quitting || !install) return
  quitting = true
  void (server?.stop() ?? Promise.resolve()).finally(install)
}

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void (server?.stop() ?? Promise.resolve()).finally(() => app.exit(0))
})

// No top-level await: Electron holds 'ready' until the entry module finishes evaluating.
void app.whenReady().then(async () => {
  if (!primary) return
  server = startServer(installUpdate)

  try {
    origin = await server.ready
  } catch (e) {
    if (quitting) return
    // SAFETY: startServer rejects with Error carrying the startup failure message.
    dialog.showErrorBox('Paperish could not start', (e as Error).message)

    return app.exit(1)
  }

  openEditor()

  if (app.isPackaged) install = await watchUpdates(server.updateReady)
})
