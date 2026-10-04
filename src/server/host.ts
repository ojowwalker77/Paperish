import type { JsonValue, ThemeSetting, UpdateState } from '../shared/types'

// The server runs in a utility process (src/app/server.ts), off the thread that
// routes input to the app's windows. Windows, dialogs, the trash and the app
// theme stay in Electron's main process; the server reaches them with call().

export interface PageOptions {
  width: number
  height: number
  /** A throwaway in-memory session (cookies, cache), for third-party pages and anything that waits for the network. */
  isolated?: boolean
  userAgent?: string
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
  clip: { x: number; y: number; width: number; height: number; scale: number }
}

export interface FetchOptions {
  timeout: number
  referrer?: string
}

interface FetchReply {
  status: number
  headers: [string, string][]
  /** Only read for successful responses. */
  body: Uint8Array<ArrayBuffer> | null
}

/** What the main process does for the server (src/app/host.ts). Pages are the layout engine's hidden windows. */
export interface HostApi {
  openPage(opts: PageOptions): Promise<number>
  pageOn(page: number, event: string): Promise<void>
  pageSend(page: number, method: string, params?: Record<string, JsonValue>): Promise<JsonValue>
  pageGoto(page: number, url: string, timeout: number): Promise<number | null>
  pageNetworkIdle(page: number, timeout: number): Promise<void>
  pageEvaluate(page: number, src: string): Promise<JsonValue>
  pageScreenshot(page: number, opts: ScreenshotOptions): Promise<string>
  pagePdf(page: number): Promise<Uint8Array>
  pageFetch(page: number, url: string, opts: FetchOptions): Promise<FetchReply>
  pageClose(page: number): Promise<void>
  /** The chosen path, or null if cancelled. */
  openDialog(opts: Electron.OpenDialogOptions): Promise<string | null>
  trash(file: string): Promise<void>
  setTheme(theme: ThemeSetting): Promise<void>
  /** Quit and restart into the downloaded update. */
  installUpdate(): Promise<void>
}

type Method = keyof HostApi

export type HostArgs = Parameters<HostApi[Method]>

export type HostValue = Awaited<ReturnType<HostApi[Method]>>

/** Server → main. */
export type ServerMsg =
  | { t: 'call'; id: number; method: Method; args: HostArgs }
  | { t: 'ready'; origin: string }
  | { t: 'failed'; message: string }
  | { t: 'done'; code: number }

/** Main → server. */
export type MainMsg =
  | { t: 'reply'; id: number; value?: HostValue; error?: string }
  | { t: 'event'; page: number; event: string; params: JsonValue }
  | { t: 'update'; update: UpdateState }
  | { t: 'stop' }

const pending = new Map<number, { resolve: (v: HostValue) => void; reject: (e: Error) => void }>()

let calls = 0

export const post = (msg: ServerMsg) => process.parentPort?.postMessage(msg)

export function onMain(fn: (msg: MainMsg) => void) {
  process.parentPort?.on('message', (e) => fn(e.data))
}

onMain((msg) => {
  if (msg.t !== 'reply') return
  const p = pending.get(msg.id)
  pending.delete(msg.id)

  if (msg.error !== undefined) p?.reject(new Error(msg.error))
  else p?.resolve(msg.value)
})

export function call<M extends Method>(
  method: M,
  ...args: Parameters<HostApi[M]>
): Promise<Awaited<ReturnType<HostApi[M]>>> {
  const id = ++calls

  return new Promise((resolve, reject) => {
    // SAFETY: the main process answers each call with its method's own result.
    pending.set(id, { resolve: resolve as (v: HostValue) => void, reject })
    post({ t: 'call', id, method, args })
  })
}
