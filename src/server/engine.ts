import { canvasResetCss } from '../shared/reset'
import type { JsonValue } from '../shared/types'
import { Page, wait } from './browser'
import { ORIGIN } from './config'
import type { OpenFile } from './workspace'

// The layout engine is a hidden window running the same renderer as the
// editor. It follows the document over the normal websocket, so layout
// questions (sizes, computed styles, screenshots) are answered by a real
// browser whatever the editor windows are doing.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
  worldX: number
  worldY: number
  /** Document-space coordinates inside the engine page (for CDP clips). */
  pageX: number
  pageY: number
}

const MAX_EDGE = 1800

const MAX_PIXELS = 2_400_000

const VIEWPORT = { width: 1600, height: 1000 }

const MAX_VIEWPORT_EDGE = 8192

const IMPORT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

class Engine {
  private pages = new Map<string, Promise<Page>>()

  /** Close the engine page for a file that no longer exists. */
  async forget(fileId: string) {
    const p = this.pages.get(fileId)
    this.pages.delete(fileId)
    await (await p?.catch(() => null))?.close()
  }

  private async pageFor(fileId: string): Promise<Page> {
    const existing = await this.pages.get(fileId)?.catch(() => null)

    if (existing && !existing.isClosed()) return existing

    const ready = (async () => {
      const page = await Page.open(VIEWPORT)
      page.on('console-error', (m) => console.warn('[engine]', m))
      page.on('crash', (reason) => console.warn('[engine] page crashed:', reason))
      await page.goto(`${ORIGIN}/?engine=1&file=${encodeURIComponent(fileId)}`)
      // SAFETY: the engine page sets window.__engine on boot; waitFor polls until it exists.
      await page.waitFor(() => !!(window as { __engine?: unknown }).__engine, 20000)

      return page
    })()

    this.pages.set(fileId, ready)
    ready.catch(() => this.pages.get(fileId) === ready && this.pages.delete(fileId))

    return ready
  }

  /** Run an engine method after the page has caught up with the file's version. */
  async call<T>(
    f: OpenFile,
    method: string,
    args: Record<string, JsonValue | undefined> = {},
    pageId = f.pageId,
  ): Promise<T> {
    const page = await this.pageFor(f.doc.id)

    return page.evaluate(
      `window.__engine.call(${[method, args, f.version, pageId].map((a) => JSON.stringify(a)).join(',')})`,
    )
  }

  async layout(f: OpenFile, ids: string[], pageId?: string): Promise<Record<string, Rect>> {
    return this.call(f, 'layout', { ids }, pageId)
  }

  async screenshot(
    f: OpenFile,
    id: string,
    opts: {
      scale?: number
      transparent?: boolean
      format?: 'jpeg' | 'png' | 'webp'
      quality?: number
      cap?: boolean
    },
    pageId?: string,
  ): Promise<{ data: string; mimeType: string; width: number; height: number; scale: number }> {
    const page = await this.pageFor(f.doc.id)
    await this.call(f, 'settle', {}, pageId)
    const rects = await this.layout(f, [id], pageId)
    const r = rects[id]

    if (!r) throw new Error(`Node "${id}" is not rendered (hidden or on another page?)`)

    if (r.width < 1 || r.height < 1)
      throw new Error(`Node "${id}" has zero size (${r.width}×${r.height})`)
    let scale = opts.scale ?? 1

    if (opts.cap !== false) {
      const edge = Math.max(r.width, r.height) * scale

      if (edge > MAX_EDGE) scale *= MAX_EDGE / edge
      const px = r.width * r.height * scale * scale

      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px)
    }

    const format = opts.format ?? (opts.transparent ? 'png' : 'jpeg')

    if (opts.transparent)
      await page.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 },
      })

    // Chromium paints out-of-process frames (real components) only inside the viewport.
    const view = {
      width: Math.min(Math.max(VIEWPORT.width, Math.ceil(r.width)), MAX_VIEWPORT_EDGE),
      height: Math.min(Math.max(VIEWPORT.height, Math.ceil(r.height)), MAX_VIEWPORT_EDGE),
    }

    const grown = view.width !== VIEWPORT.width || view.height !== VIEWPORT.height

    try {
      if (grown)
        await page.send('Emulation.setDeviceMetricsOverride', {
          ...view,
          deviceScaleFactor: 0,
          mobile: false,
        })
      await page.evaluate(`window.scrollTo(${r.pageX}, ${r.pageY})`)
      await this.call(f, 'settle', {}, pageId)
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      )

      const data = await page.screenshot({
        format,
        quality: opts.quality ?? 88,
        clip: { x: r.pageX, y: r.pageY, width: r.width, height: r.height, scale },
      })

      return {
        data,
        mimeType: `image/${format}`,
        width: Math.round(r.width * scale),
        height: Math.round(r.height * scale),
        scale,
      }
    } finally {
      if (opts.transparent) await page.send('Emulation.setDefaultBackgroundColorOverride', {})

      if (grown) await page.send('Emulation.clearDeviceMetricsOverride', {})
    }
  }

  /** A hidden window with its own throwaway session, for loading a third-party page (URL import). */
  openImportPage(width: number): Promise<Page> {
    return Page.open({ width, height: 900, isolated: true, userAgent: IMPORT_UA })
  }

  /** Full-page PNG of a live URL at a given viewport width (reference for visual diff). */
  async captureUrl(url: string, width: number): Promise<Buffer> {
    const page = await this.openImportPage(width)

    try {
      await page.goto(/^https?:/i.test(url) ? url : `https://${url}`)
      await page.networkIdle(8000)
      await page.evaluate(async () => {
        const step = Math.max(400, window.innerHeight * 0.8)

        for (
          let y = step, i = 0;
          i < 40 && y < document.documentElement.scrollHeight + step;
          y += step, i++
        ) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 90))
        }

        window.scrollTo(0, 0)

        for (const el of document.querySelectorAll(
          '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="onetrust" i]',
        )) {
          const pos = getComputedStyle(el).position

          if (pos === 'fixed' || pos === 'sticky') el.remove()
        }

        for (const a of document.getAnimations()) {
          try {
            a.finish()
          } catch {}
        }

        await new Promise((r) => setTimeout(r, 250))
      })

      // Clip to the viewport width: decorative overflow can make the page wider than it looks.
      const height = await page.evaluate(() =>
        Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      )

      const data = await page.screenshot({
        format: 'png',
        clip: { x: 0, y: 0, width, height: Math.min(height, 16_000), scale: 1 },
      })

      return Buffer.from(data, 'base64')
    } finally {
      await page.close()
    }
  }

  /** Render standalone HTML in a scratch window and print it to PDF. */
  async pdf(
    pages: { html: string; width: number; height: number }[],
    head: string,
  ): Promise<Buffer> {
    const page = await Page.open({ width: 1600, height: 1000, isolated: true })

    try {
      const css = pages
        .map(
          (p, i) =>
            `@page p${i} { size: ${p.width}px ${p.height}px; margin: 0 } .pg${i} { page: p${i}; width: ${p.width}px; height: ${p.height}px; }`,
        )
        .join('\n')

      const body = pages.map((p, i) => `<div class="pg pg${i}">${p.html}</div>`).join('')
      await page.goto('about:blank')
      const { frameTree } = await page.send('Page.getFrameTree')
      await page.send('Page.setDocumentContent', {
        frameId: frameTree.frame.id,
        html: `<!doctype html><html><head><meta charset="utf-8"><base href="${ORIGIN}/">${head}<style>${PRINT_RESET}${css}</style></head><body>${body}</body></html>`,
      })
      await page.networkIdle(10_000)
      await page.evaluate(() => document.fonts.ready.then(() => true))
      await wait(50)

      return await page.pdf()
    } finally {
      await page.close()
    }
  }

  async close() {
    await Promise.all([...this.pages.keys()].map((id) => this.forget(id)))
  }
}

const PRINT_RESET = `${canvasResetCss('body')}
html,body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{display:flex;overflow:hidden;break-after:page}
`

export const engine = new Engine()
