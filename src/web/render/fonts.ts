import { fontFamiliesOf } from '../../shared/styles'
import { DEFAULT_FONT } from '../../shared/reset'
import type { Doc } from '../../shared/types'

// Loads every Google Font family referenced by the document with one
// stylesheet per family, so text renders with the real font on the canvas.

let index: Record<string, string> | null = null

let indexLower: Map<string, string> | null = null

const loaded = new Map<string, Promise<void>>()

export async function loadIndex() {
  if (index) return

  try {
    // SAFETY: /api/fonts/google returns a JSON object mapping family names to URL-encoded families.
    index = (await (await fetch('/api/fonts/google')).json()) as Record<string, string>
  } catch {
    index = {}
  }

  indexLower = new Map(Object.keys(index).map((k) => [k.toLowerCase(), k]))
}

const parsed = new Map<string, string[]>()

/** Runs on every document change, so each distinct font-family string is parsed once. */
export function familiesIn(doc: Doc): Set<string> {
  const out = new Set<string>([DEFAULT_FONT])
  const seen = new Set<unknown>()

  for (const id in doc.nodes) {
    const v = doc.nodes[id].styles.fontFamily

    if (v === undefined || seen.has(v)) continue
    seen.add(v)
    const key = String(v)
    let fams = parsed.get(key)

    if (!fams) parsed.set(key, (fams = fontFamiliesOf(v)))

    for (const f of fams) out.add(f)
  }

  for (const t of doc.tokens)
    if (t.type === 'fontFamily') for (const f of fontFamiliesOf(String(t.value))) out.add(f)

  return out
}

export function ensureFonts(families: Iterable<string>): Promise<void> {
  if (!index || !indexLower) return Promise.resolve()
  const pending: Promise<void>[] = []

  for (const fam of families) {
    const key = indexLower.get(fam.toLowerCase())

    if (!key) continue
    let p = loaded.get(key)

    if (!p) {
      p = new Promise<void>((resolve) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = `https://fonts.googleapis.com/css2?family=${index![key]}&display=block`
        link.addEventListener('load', () => resolve(), { once: true })
        link.addEventListener('error', () => resolve(), { once: true })
        document.head.appendChild(link)
      })
      loaded.set(key, p)
    }

    pending.push(p)
  }

  return Promise.all(pending).then(() => undefined)
}

export function isWebFont(family: string): boolean {
  return (
    !!indexLower?.has(family.toLowerCase()) && loaded.has(indexLower.get(family.toLowerCase())!)
  )
}
