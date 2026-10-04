import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import type { DiffJob } from '../server/design-diff'
import { startServer } from './host'
import { watchUpdates } from './updater'

// The desktop app: the Paperish server runs in a utility process (./host.ts),
// the editor is a window onto it, and the layout engine uses hidden windows of
// the same Chromium (./browser.ts).

app.setName('Paperish')

const HELP = `Usage: paperish [--help] [--version] [--mcp [project id]]
       paperish diff [--base <rev>] [--head <rev>] [--out <dir>] [--url <prefix>] [<repo>]

A design canvas that agents edit over MCP.

Commands:
  diff           Render every .paperish file changed since --base (default main) and
                 write before, after and heatmap images per artboard, diff.json and
                 summary.md to --out (default paperish-diff). --head defaults to the
                 working tree; --url prefixes the image links in summary.md.

Options:
  -h, --help     Print this help and exit
  -v, --version  Print the version and exit
  --mcp [id]     Serve a project's MCP tools over stdio (default Scratch), forwarding calls to the running app

Environment:
  PAPERISH_PORT  Server port (default 29980); agents connect to /mcp/<project id>
  PAPERISH_DATA  App data directory
`

const flags = process.argv.slice(app.isPackaged ? 1 : 2)

if (flags.some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

if (flags.some((a) => a === '--version' || a === '-v')) {
  process.stdout.write(`${app.getVersion()}\n`)
  process.exit(0)
}

const mcp = flags.indexOf('--mcp')

if (mcp >= 0) {
  app.dock?.hide()
  void import('./mcp').then(({ serveStdio }) =>
    serveStdio(flags[mcp + 1] ?? 'scratch', () => app.exit(0)),
  )
}

const job = flags[0] === 'diff' ? diffJob(flags.slice(1)) : null

const scratchData = job ? fs.mkdtempSync(path.join(os.tmpdir(), 'paperish-')) : ''

if (job) app.setPath('userData', scratchData)

// One app per machine: a second launch focuses this one (see 'second-instance').
const primary = mcp < 0 && !job && app.requestSingleInstanceLock()

if (mcp < 0 && !job && !primary) app.quit()

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

function diffJob(args: string[]): DiffJob {
  const { values, positionals } = parseArgs({
    args,
    strict: false,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      out: { type: 'string' },
      url: { type: 'string' },
    },
  })

  return {
    dir: path.resolve(positionals[0] ?? '.'),
    base: str(values.base) ?? 'main',
    head: str(values.head),
    out: path.resolve(str(values.out) ?? 'paperish-diff'),
    url: str(values.url),
  }
}

function str(v: string | boolean | undefined) {
  return v === undefined || v === true || v === false ? undefined : v
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      // SAFETY: a TCP server listening on a port reports its address as AddressInfo.
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

async function runDiff(diff: DiffJob) {
  app.dock?.hide()

  server = startServer(() => {}, {
    PAPERISH_DIFF: JSON.stringify(diff),
    PAPERISH_DATA: scratchData,
    PAPERISH_PORT: String(await freePort()),
  })

  let code = 1

  try {
    await server.ready
    code = await server.done
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  }

  await server.stop()
  fs.rmSync(scratchData, { recursive: true, force: true })
  app.exit(code)
}

// No top-level await: Electron holds 'ready' until the entry module finishes evaluating.
void app.whenReady().then(async () => {
  if (job) return runDiff(job)

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

  if (app.isPackaged) install = await watchUpdates(server.updateState)
})
