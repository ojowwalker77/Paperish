import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ASSETS_DIR } from './config'

interface MimeExtMap {
  [mime: string]: string
}

const MIME_EXT: MimeExtMap = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

export const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m]),
)

EXT_MIME.jpeg = 'image/jpeg'

EXT_MIME.woff2 = 'font/woff2'

EXT_MIME.woff = 'font/woff'

EXT_MIME.ttf = 'font/ttf'

EXT_MIME.otf = 'font/otf'

/** Extension for a downloaded file from its content type or URL. */
export function extFor(contentType: string | undefined, url: string): string | null {
  const ct = contentType?.split(';')[0].trim().toLowerCase()

  if (ct && MIME_EXT[ct]) return MIME_EXT[ct]
  const m = new URL(url, 'http://x').pathname.match(/\.([a-z0-9]{2,5})$/i)
  const ext = m?.[1].toLowerCase()

  if (ext && (EXT_MIME[ext] || ext === 'jpeg')) return ext === 'jpeg' ? 'jpg' : ext

  return null
}

export function storeBuffer(buf: Buffer, ext: string): string {
  return store(buf, ext)
}

function store(buf: Buffer, ext: string): string {
  fs.mkdirSync(ASSETS_DIR, { recursive: true })
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 20)
  const name = `${hash}.${ext}`
  const file = path.join(ASSETS_DIR, name)

  if (!fs.existsSync(file)) fs.writeFileSync(file, buf)

  return `/media/${name}`
}

/**
 * Rewrite local image references into content-addressed copies under
 * data/assets so documents never point at arbitrary paths on disk.
 * Accepts paper-asset:///abs, file:///abs and data: URLs.
 */
export function importAssetUrl(url: string): string {
  const trimmed = url.trim()
  const local = trimmed.match(/^(?:paper-asset|paperish-asset|asset|file):\/\/(\/.*)$/i)

  if (local) {
    const p = decodeURIComponent(local[1])

    if (!fs.existsSync(p)) throw new Error(`Local asset not found: ${p}`)
    const ext = path.extname(p).slice(1).toLowerCase() || 'bin'

    return store(fs.readFileSync(p), ext === 'jpeg' ? 'jpg' : ext)
  }

  const data = trimmed.match(/^data:([^;,]+)(;base64)?,(.*)$/s)

  if (data && data[3].length > 2048) {
    const ext = MIME_EXT[data[1].toLowerCase()]

    if (ext) {
      const buf = data[2]
        ? Buffer.from(data[3], 'base64')
        : Buffer.from(decodeURIComponent(data[3]))

      return store(buf, ext)
    }
  }

  return trimmed
}

/** Rewrite url(...) references inside a CSS value. */
export function importCssUrls(value: string): string {
  if (!/url\(/i.test(value)) return value

  return value.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_m, q: string, u: string) => `url(${q}${importAssetUrl(u)}${q})`,
  )
}

export function assetPath(publicPath: string): string | null {
  const m = publicPath.match(/^\/media\/([a-f0-9]+\.[a-z0-9]+)$/)

  return m ? path.join(ASSETS_DIR, m[1]) : null
}
