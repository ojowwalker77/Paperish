import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config'

// Google Fonts metadata (public, no API key) cached on disk for a week.

export interface GoogleFamily {
  family: string
  category: string
  /** Static style keys like "400", "700i". */
  styles: string[]
  axes: { tag: string; min: number; max: number }[]
}

const CACHE_FILE = path.join(CACHE_DIR, 'google-fonts.json')
const WEEK = 7 * 24 * 3600 * 1000
let index: Promise<Map<string, GoogleFamily>> | null = null

export function googleFonts(): Promise<Map<string, GoogleFamily>> {
  if (!index) index = load().catch((e) => {
    console.warn('[paperish] Google Fonts index unavailable:', (e as Error).message)
    index = null
    return new Map()
  })
  return index
}

async function load(): Promise<Map<string, GoogleFamily>> {
  let list: GoogleFamily[] | null = null
  try {
    const stat = fs.statSync(CACHE_FILE)
    if (Date.now() - stat.mtimeMs < WEEK) list = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch {}
  if (!list) {
    const res = await fetch('https://fonts.google.com/metadata/fonts')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = (await res.text()).replace(/^\)\]\}'\s*/, '')
    const json = JSON.parse(text) as {
      familyMetadataList: { family: string; category: string; fonts: Record<string, unknown>; axes?: { tag: string; min: number; max: number }[] }[]
    }
    list = json.familyMetadataList.map((f) => ({
      family: f.family,
      category: f.category,
      styles: Object.keys(f.fonts),
      axes: (f.axes ?? []).map((a) => ({ tag: a.tag, min: a.min, max: a.max })),
    }))
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list))
  }
  return new Map(list.map((f) => [f.family.toLowerCase(), f]))
}

/** Compact index for the editor: family -> css2 axis spec. */
export async function googleFontIndex(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of (await googleFonts()).values()) out[f.family] = css2Spec(f)
  return out
}

/** Build the `family=` value for the css2 API covering every weight/style. */
export function css2Spec(f: GoogleFamily): string {
  const name = f.family.replace(/ /g, '+')
  const hasItalic = f.styles.some((s) => s.endsWith('i'))
  const wght = f.axes.find((a) => a.tag === 'wght')
  if (wght) {
    const range = `${wght.min}..${wght.max}`
    return hasItalic ? `${name}:ital,wght@0,${range};1,${range}` : `${name}:wght@${range}`
  }
  const weights = [...new Set(f.styles.map((s) => s.replace('i', '')))].sort((a, b) => Number(a) - Number(b))
  if (weights.length === 1 && weights[0] === '400' && !hasItalic) return name
  if (hasItalic) {
    const pairs = f.styles
      .map((s) => (s.endsWith('i') ? `1,${s.slice(0, -1)}` : `0,${s}`))
      .sort()
    return `${name}:ital,wght@${pairs.join(';')}`
  }
  return `${name}:wght@${weights.join(';')}`
}

export function describeGoogle(f: GoogleFamily) {
  const wght = f.axes.find((a) => a.tag === 'wght')
  const weights = wght
    ? Array.from({ length: 9 }, (_, i) => (i + 1) * 100).filter((w) => w >= wght.min && w <= wght.max)
    : [...new Set(f.styles.map((s) => Number(s.replace('i', ''))))].sort((a, b) => a - b)
  return {
    family: f.family,
    source: 'google-fonts',
    category: f.category,
    weights,
    italic: f.styles.some((s) => s.endsWith('i')),
    variableAxes: f.axes.length ? f.axes : undefined,
  }
}
