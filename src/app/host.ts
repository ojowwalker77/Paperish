import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, nativeTheme, shell, utilityProcess } from 'electron'
import type { HostApi, HostArgs, HostValue, MainMsg, ServerMsg } from '../server/host'
import { Page } from './browser'

// Electron routes input to every window through the main process, so the
// server runs in a utility process where a slow save or agent call can't
// freeze the app. What only the main process can do, it asks for here.

/** From source (npm run dev), dev.mjs starts the server too; built, it's out/server.js. */
const ENTRY = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? 'dev.mjs' : 'server.js', import.meta.url),
)

export function startServer() {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERISH_ROOT: app.getAppPath() }

  if (app.isPackaged) {
    env.PAPERISH_PACKAGED = '1'
    env.PAPERISH_DATA ??= app.getPath('userData')
  }

  const child = utilityProcess.fork(ENTRY, [], { serviceName: 'Paperish server', env })
  const post = (msg: MainMsg) => child.postMessage(msg)
  const pages = new Map<number, Page>()
  let pageIds = 0
  let ready = false
  let exited = false
  let stopping = false

  const page = (id: number) => {
    const p = pages.get(id)

    if (!p) throw new Error('The page was closed')

    return p
  }

  const api: HostApi = {
    async openPage(opts) {
      const id = ++pageIds
      pages.set(id, await Page.open(opts))

      return id
    },
    async pageOn(id, event) {
      page(id).on(event, (params) => post({ t: 'event', page: id, event, params }))
    },
    pageSend: async (id, method, params) => page(id).send(method, params),
    pageGoto: async (id, url, timeout) => page(id).goto(url, timeout),
    pageNetworkIdle: async (id, timeout) => page(id).networkIdle(timeout),
    pageEvaluate: async (id, src) => page(id).evaluate(src),
    pageScreenshot: async (id, opts) => page(id).screenshot(opts),
    pagePdf: async (id) => new Uint8Array(await page(id).pdf()),
    async pageFetch(id, url, opts) {
      const res = await page(id).fetch(url, opts)

      return {
        status: res.status,
        headers: [...res.headers],
        body: res.ok ? new Uint8Array(await res.arrayBuffer()) : null,
      }
    },
    async pageClose(id) {
      const p = pages.get(id)
      pages.delete(id)
      await p?.close()
    },
    async openDialog(opts) {
      const win = BrowserWindow.getFocusedWindow()
      const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))

      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    trash: (file) => shell.trashItem(file),
    async setTheme(theme) {
      nativeTheme.themeSource = theme
    },
  }

  const started = new Promise<string>((resolve, reject) => {
    child.on('message', (msg: ServerMsg) => {
      if (msg.t === 'call') {
        // SAFETY: the server's call() pairs each method with that method's own arguments.
        const fn = api[msg.method] as (...args: HostArgs) => Promise<HostValue>
        fn(...msg.args).then(
          (value) => post({ t: 'reply', id: msg.id, value }),
          (e: Error) => post({ t: 'reply', id: msg.id, error: e.message }),
        )
      } else if (msg.t === 'ready') {
        ready = true
        resolve(msg.origin)
      } else reject(new Error(msg.message))
    })
    child.once('exit', (code) => {
      exited = true

      for (const p of pages.values()) void p.close()
      pages.clear()
      reject(new Error(`The server exited (code ${code}).`))

      if (ready && !stopping) {
        dialog.showErrorBox('Paperish stopped', `The server exited unexpectedly (code ${code}).`)
        app.exit(1)
      }
    })
  })

  /** Save everything and stop the server. */
  const stop = () =>
    new Promise<void>((resolve) => {
      stopping = true

      if (exited) return resolve()
      child.once('exit', () => resolve())

      if (ready) post({ t: 'stop' })
      else child.kill()
    })

  return { ready: started, stop }
}
