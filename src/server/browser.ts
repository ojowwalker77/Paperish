import type { JsonValue } from '../shared/types'
import { call, onMain, type FetchOptions, type PageOptions, type ScreenshotOptions } from './host'

// The layout engine, URL import and PDF export use hidden windows of the
// app's own Chromium. Windows live in the main process (src/app/browser.ts);
// a Page drives one from here, with a small slice of a Playwright-style API.

type Listener = (params: any) => void

const live = new Map<number, Page>()

onMain((msg) => {
  if (msg.t === 'event') live.get(msg.page)?.emit(msg.event, msg.params)
})

export class Page {
  private listeners = new Map<string, Set<Listener>>()
  private closed = false

  private constructor(private readonly id: number) {}

  static async open(opts: PageOptions): Promise<Page> {
    const p = new Page(await call('openPage', opts))
    live.set(p.id, p)
    p.on('crash', () => (p.closed = true))

    return p
  }

  isClosed() {
    return this.closed
  }

  async send<T = any>(method: string, params?: Record<string, JsonValue>): Promise<T> {
    // SAFETY: CDP sendCommand resolves with the called method's documented payload, which each caller types as T.
    return (await call('pageSend', this.id, method, params)) as T
  }

  on(event: string, fn: Listener) {
    let set = this.listeners.get(event)

    if (!set) {
      this.listeners.set(event, (set = new Set()))
      void call('pageOn', this.id, event)
    }

    set.add(fn)
  }

  emit(event: string, params: JsonValue) {
    for (const fn of this.listeners.get(event) ?? []) fn(params)
  }

  /** Navigate and wait for the load event. Returns the main document's HTTP status. */
  goto(url: string, timeout = 45_000): Promise<number | null> {
    return call('pageGoto', this.id, url, timeout)
  }

  /** Resolve once no request has been in flight for 500ms (Playwright's "networkidle"). Isolated pages only. */
  networkIdle(timeout: number): Promise<void> {
    return call('pageNetworkIdle', this.id, timeout)
  }

  /** Evaluate a function (serialized with its argument) or an expression in the page. */
  async evaluate<T, A = undefined>(fn: string | ((arg: A) => T | Promise<T>), arg?: A): Promise<T> {
    const src = isPageSource(fn)
      ? fn
      : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`

    // SAFETY: executeJavaScript resolves with the evaluated script's value, which each caller types as T.
    return (await call('pageEvaluate', this.id, src)) as T
  }

  async waitFor(fn: () => boolean | Promise<boolean>, timeout: number): Promise<void> {
    const end = Date.now() + timeout

    while (Date.now() < end) {
      if (await this.evaluate(fn).catch(() => false)) return
      await wait(50)
    }

    throw new Error('Timed out waiting for the page')
  }

  screenshot(opts: ScreenshotOptions): Promise<string> {
    return call('pageScreenshot', this.id, opts)
  }

  async pdf(): Promise<Buffer> {
    return Buffer.from(await call('pagePdf', this.id))
  }

  /** HTTP GET through this page's session (its cookies and user agent). */
  async fetch(url: string, opts: FetchOptions): Promise<Response> {
    const res = await call('pageFetch', this.id, url, opts)

    return new Response(res.body?.byteLength ? res.body : null, {
      status: res.status,
      headers: res.headers,
    })
  }

  async close() {
    if (!live.delete(this.id)) return
    this.closed = true
    await call('pageClose', this.id)
  }
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function isPageSource<T, A>(v: string | ((arg: A) => T | Promise<T>)): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}
