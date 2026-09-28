import { BrowserWindow, session, type Session, type WebContents } from 'electron'

// Paperish runs inside Electron, so Chromium is already here: the layout
// engine, URL import and PDF export use hidden windows, driven through the
// DevTools protocol (webContents.debugger). This is the small slice of a
// Playwright-style page API those callers need.

export interface PageOptions {
  width: number
  height: number
  /** A throwaway in-memory session (cookies, cache), for third-party pages and anything that waits for the network. */
  isolated?: boolean
  userAgent?: string
}

type Listener = (params: any) => void

let partitions = 0
/** Isolated sessions are cleared and reused: Electron never frees a partition. */
const spare: string[] = []

export class Page {
  readonly win: BrowserWindow
  readonly wc: WebContents
  readonly session: Session
  private partition: string | null = null
  private listeners = new Map<string, Set<Listener>>()
  private inflight = new Set<number>()
  private lastActivity = Date.now()
  private closed = false

  private constructor(opts: PageOptions) {
    if (opts.isolated) this.partition = spare.pop() ?? `isolated-${++partitions}`
    this.session = this.partition ? session.fromPartition(this.partition) : session.defaultSession
    if (opts.userAgent || this.partition) this.session.setUserAgent(opts.userAgent ?? session.defaultSession.getUserAgent())
    if (opts.isolated) {
      // Session-wide, so requests from iframes and workers count too (CDP only sees this frame's).
      const { webRequest } = this.session
      webRequest.onSendHeaders((d) => {
        if (d.resourceType === 'webSocket') return
        this.inflight.add(d.id)
        this.lastActivity = Date.now()
      })
      const done = (d: { id: number }) => {
        this.inflight.delete(d.id)
        this.lastActivity = Date.now()
      }
      webRequest.onCompleted(done)
      webRequest.onErrorOccurred(done)
    }
    this.win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      useContentSize: true,
      webPreferences: { session: this.session, offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true },
    })
    this.wc = this.win.webContents
    this.wc.setFrameRate(30)
    this.wc.on('console-message', (e) => {
      if (e.level === 'error') this.emit('console-error', e.message)
    })
    this.wc.on('render-process-gone', (_e, d) => {
      this.closed = true
      this.emit('crash', d.reason)
    })
    this.win.on('closed', () => (this.closed = true))
  }

  static async open(opts: PageOptions): Promise<Page> {
    const p = new Page(opts)
    // The debugger only answers once the window has a renderer.
    await p.wc.loadURL('about:blank')
    const dbg = p.wc.debugger
    dbg.attach('1.3')
    dbg.on('message', (_e, method, params) => p.emit(method, params))
    await p.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false })
    return p
  }

  isClosed() {
    return this.closed || this.win.isDestroyed()
  }

  send<T = any>(method: string, params?: object): Promise<T> {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  on(event: string, fn: Listener) {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
  }

  private emit(event: string, params: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(params)
  }

  /** Navigate and wait for the load event. Returns the main document's HTTP status. */
  async goto(url: string, timeout = 45_000): Promise<number | null> {
    let status: number | null = null
    const onNav = (_e: unknown, _url: string, code: number) => (status = code)
    this.wc.on('did-navigate', onNav)
    try {
      await withTimeout(
        this.wc.loadURL(url).catch((e: Error & { code?: string }) => {
          // Client-side redirects abort the first navigation; the page still loads.
          if (e.code !== 'ERR_ABORTED') throw e
        }),
        timeout,
        `Timed out loading ${url}`,
      )
    } finally {
      this.wc.off('did-navigate', onNav)
    }
    return status
  }

  /** Resolve once no request has been in flight for 500ms (Playwright's "networkidle"). Isolated pages only. */
  async networkIdle(timeout: number): Promise<void> {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (!this.inflight.size && Date.now() - this.lastActivity >= 500) return
      await wait(100)
    }
    this.inflight.clear()
  }

  /** Evaluate a function (serialized with its argument) or an expression in the page. */
  evaluate<T, A = undefined>(fn: string | ((arg: A) => T | Promise<T>), arg?: A): Promise<T> {
    const src = typeof fn === 'string' ? fn : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    return this.wc.executeJavaScript(src, true) as Promise<T>
  }

  async waitFor(fn: () => unknown, timeout: number): Promise<void> {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await this.evaluate(fn).catch(() => false)) return
      await wait(50)
    }
    throw new Error('Timed out waiting for the page')
  }

  async screenshot(opts: { format?: 'png' | 'jpeg' | 'webp'; quality?: number; clip: { x: number; y: number; width: number; height: number; scale: number } }): Promise<string> {
    const res = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: opts.format ?? 'png',
      quality: opts.format === 'png' ? undefined : opts.quality,
      captureBeyondViewport: true,
      fromSurface: true,
      clip: opts.clip,
    })
    return res.data
  }

  pdf(): Promise<Buffer> {
    return this.wc.printToPDF({ printBackground: true, preferCSSPageSize: true })
  }

  /** HTTP GET through this page's session (its cookies and user agent). */
  async fetch(url: string, opts: { timeout: number; referrer?: string }): Promise<Response> {
    // A hand-set Referer header gets the request blocked (ERR_BLOCKED_BY_CLIENT); `referrer` is the supported way.
    return this.session.fetch(url, { referrer: opts.referrer, signal: AbortSignal.timeout(opts.timeout), bypassCustomProtocolHandlers: true })
  }

  async close() {
    if (this.win.isDestroyed()) return
    try {
      this.wc.debugger.detach()
    } catch {}
    this.win.destroy()
    if (this.partition) {
      await this.session.clearStorageData().catch(() => {})
      await this.session.clearCache().catch(() => {})
      spare.push(this.partition)
      this.partition = null
    }
  }
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}
