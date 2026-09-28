// Editor performance bench. Drives the running server's editor with real
// input (wheel pan, pinch zoom, hover, drag, edits, selection) and reports
// main-thread cost per interaction from Chrome's own counters. The artboard it
// drags and restyles is put back afterwards.
//
//   npx playwright install chromium   # once; the bench drives its own browser
//   npm run perf -- [fileId] [--headed]
//   PAPERISH_URL=http://127.0.0.1:29981 npm run perf -- <fileId>   # another server

import { chromium, type CDPSession, type Page } from 'playwright'

const BASE = process.env.PAPERISH_URL ?? 'http://127.0.0.1:29980'
const args = process.argv.slice(2)
const fileId = args.find((a) => !a.startsWith('--'))
const headed = args.includes('--headed')

type Metrics = Record<string, number>

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

async function measure(page: Page, cdp: CDPSession, name: string, n: number, run: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __raf: number; __lofs: number }
    w.__frames = []
    w.__lofs = 0
    let last = performance.now()
    const tick = (t: number) => {
      w.__frames.push(t - last)
      last = t
      w.__raf = requestAnimationFrame(tick)
    }
    w.__raf = requestAnimationFrame(tick)
  })
  const before = await metrics(cdp)
  const t0 = Date.now()
  await run()
  // let trailing work (rAF batches, React commits) land
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const wall = Date.now() - t0
  const after = await metrics(cdp)
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __raf: number }
    cancelAnimationFrame(w.__raf)
    return w.__frames.slice(1)
  })
  const d = (k: string) => ((after[k] ?? 0) - (before[k] ?? 0)) * 1000
  const sorted = [...frames].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const row = {
    scenario: name,
    'task ms/op': +(d('TaskDuration') / n).toFixed(2),
    'script ms/op': +(d('ScriptDuration') / n).toFixed(2),
    'style ms/op': +(d('RecalcStyleDuration') / n).toFixed(2),
    'layout ms/op': +(d('LayoutDuration') / n).toFixed(2),
    'wall ms/op': +(wall / n).toFixed(2),
    'p95 frame': +p95.toFixed(1),
    'max frame': +(sorted[sorted.length - 1] ?? 0).toFixed(1),
  }
  console.log(JSON.stringify(row))
  return row
}

async function main() {
  const browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  page.on('crash', () => console.log('PAGE CRASHED'))
  page.on('close', () => console.log('page closed'))
  browser.on('disconnected', () => console.log('browser disconnected'))
  page.on('pageerror', (e) => console.log('page error:', e.message))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.addInitScript('window.__name = (f) => f; localStorage.clear()')
  await page.goto(`${BASE}/${fileId ? `?file=${fileId}` : ''}`)
  await page.waitForFunction(() => (window as unknown as { __store?: { doc?: unknown } }).__store?.doc)
  await page.waitForTimeout(1500)
  const count = await page.evaluate(() => Object.keys((window as any).__store.doc.nodes).length)
  console.log(`file ${await page.evaluate(() => (window as any).__store.doc.name)} · ${count} nodes`)

  const rows = []
  const cx = 720
  const cy = 450

  rows.push(await measure(page, cdp, 'idle (per s)', 2, () => page.waitForTimeout(2000)))

  await page.mouse.move(cx, cy)
  rows.push(
    await measure(page, cdp, 'wheel pan', 120, async () => {
      for (let i = 0; i < 120; i++) await page.mouse.wheel(i % 40 < 20 ? 12 : -12, i % 60 < 30 ? 18 : -18)
    }),
  )

  await page.keyboard.down('Control')
  rows.push(
    await measure(page, cdp, 'pinch zoom', 120, async () => {
      for (let i = 0; i < 120; i++) await page.mouse.wheel(0, i < 60 ? -6 : 6)
    }),
  )
  await page.keyboard.up('Control')

  // Zoom to 100% on the busiest artboard so hover hits real content.
  const bigId = await page.evaluate(() => {
    const s = (window as any).__store
    const root = s.doc.nodes[s.page.rootId]
    const big = root.children.map((id: string) => s.doc.nodes[id]).sort((a: any, b: any) => b.children.length - a.children.length)[0]
    const left = parseFloat(big.styles.left ?? 0)
    const top = parseFloat(big.styles.top ?? 0)
    s.setCamera({ zoom: 1, x: 300 - left, y: 80 - top })
    return big.id as string
  })
  await page.waitForTimeout(300)
  rows.push(
    await measure(page, cdp, 'hover sweep', 150, async () => {
      for (let i = 0; i < 150; i++) await page.mouse.move(320 + (i % 50) * 14, 120 + Math.floor(i / 50) * 180 + (i % 7) * 9)
    }),
  )

  // Remember what the drag and edits below touch, to restore it at the end.
  const original = await page.evaluate((id) => {
    const n = (window as any).__store.doc.nodes[id]
    return { left: n.styles.left ?? null, top: n.styles.top ?? null, opacity: n.styles.opacity ?? null }
  }, bigId)

  // Select a top-level artboard via its label and drag it.
  const label = page.locator(`.pw-label[data-label-for="${bigId}"]`)
  const box = (await label.boundingBox())!
  await page.mouse.move(box.x + 10, box.y + 10)
  await page.mouse.down()
  rows.push(
    await measure(page, cdp, 'drag move', 80, async () => {
      for (let i = 1; i <= 80; i++) await page.mouse.move(box.x + 10 + i * 3, box.y + 10 + (i % 20))
    }),
  )
  await page.mouse.up()
  await page.waitForTimeout(300)

  // Edits round-trip through the server like inspector changes do.
  rows.push(
    await measure(page, cdp, 'style edit', 30, async () => {
      for (let i = 0; i < 30; i++) {
        await page.evaluate(async (i) => {
          const s = (window as any).__store
          const id = s.selection[0]
          if (!id) throw new Error('nothing selected')
          const v = s.version
          s.tx([{ t: 'styles', id, set: { opacity: String(0.5 + (i % 2) * 0.5) } }])
          await s.waitForVersion(v + 1)
          await new Promise((r) => requestAnimationFrame(r))
        }, i)
      }
    }),
  )

  // Select deep leaves one by one (inspector + layers + overlay churn).
  await page.evaluate(() => {
    const s = (window as any).__store
    ;(window as any).__texts = Object.keys(s.doc.nodes).filter((id) => s.doc.nodes[id].type === 'Text')
  })
  rows.push(
    await measure(page, cdp, 'select', 40, async () => {
      for (let i = 0; i < 40; i++) {
        await page.evaluate((i) => {
          const s = (window as any).__store
          const ids = (window as any).__texts as string[]
          s.select([ids[(i * 37) % ids.length]])
          return new Promise((r) => requestAnimationFrame(r))
        }, i)
      }
    }),
  )

  await page.evaluate(
    async ({ id, set }) => {
      const s = (window as any).__store
      const v = s.version
      s.tx([{ t: 'styles', id, set }], 'perf: restore')
      await s.waitForVersion(v + 1)
    },
    { id: bigId, set: original },
  )

  console.table(rows)
  await browser.close()
}

void main()
