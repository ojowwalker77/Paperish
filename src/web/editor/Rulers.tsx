import { useLayoutEffect, useRef } from 'react'
import { store, useStore } from '../store'

const SIZE = 16

export function Rulers() {
  const on = useStore((s) => s.rulers)
  const top = useRef<HTMLCanvasElement>(null)
  const left = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    if (!on) return
    const x = top.current!
    const y = left.current!
    const dark = matchMedia('(prefers-color-scheme: dark)')
    let ink = ''

    const paint = () => {
      paintRuler(x, 'x', ink)
      paintRuler(y, 'y', ink)
    }

    const restyle = () => {
      ink = getComputedStyle(x).color
      paint()
    }

    const ro = new ResizeObserver(paint)
    ro.observe(x)
    ro.observe(y)
    dark.addEventListener('change', restyle)
    restyle()
    const off = store.subscribeCamera(paint)

    return () => {
      ro.disconnect()
      dark.removeEventListener('change', restyle)
      off()
    }
  }, [on])

  if (!on) return null

  return (
    <div className="pw-rulers">
      <canvas className="pw-ruler x" ref={top} />
      <canvas className="pw-ruler y" ref={left} />
      <div className="pw-ruler-corner" />
    </div>
  )
}

function paintRuler(cv: HTMLCanvasElement, axis: 'x' | 'y', ink: string) {
  const dpr = devicePixelRatio
  const length = axis === 'x' ? cv.clientWidth : cv.clientHeight
  const w = Math.round((axis === 'x' ? length : SIZE) * dpr)
  const h = Math.round((axis === 'x' ? SIZE : length) * dpr)

  if (cv.width !== w || cv.height !== h) {
    cv.width = w
    cv.height = h
  }

  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  if (axis === 'y') ctx.setTransform(0, -dpr, dpr, 0, 0, h)

  const c = store.camera
  const origin = axis === 'x' ? c.x : c.y
  const raw = 64 / c.zoom
  const p = 10 ** Math.floor(Math.log10(raw))
  const lead = [1, 2, 5, 10].find((m) => m * p >= raw)!
  const step = lead * p
  const parts = lead === 2 ? 4 : 5
  const minor = step / parts
  const to = (length - origin) / c.zoom

  ctx.fillStyle = ink
  ctx.font = '9px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign = axis === 'x' ? 'left' : 'right'

  for (let i = Math.floor(-origin / c.zoom / minor); i * minor <= to; i++) {
    const v = i * minor
    const at = origin + v * c.zoom
    const s = Math.round(axis === 'x' ? at : length - at) + 0.5
    const major = i % parts === 0

    ctx.globalAlpha = major ? 0.6 : 0.35
    ctx.fillRect(s, major ? 0 : SIZE - 4, 1 / dpr, major ? SIZE : 4)

    if (major) {
      ctx.globalAlpha = 1
      ctx.fillText(String(Math.round(v * 100) / 100), axis === 'x' ? s + 3 : s - 3, 2)
    }
  }
}
