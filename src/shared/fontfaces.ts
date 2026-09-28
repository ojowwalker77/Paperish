import type { FontFaceDef } from './types'

/** @font-face rules for fonts bundled with a document. */
export function fontFaceCss(faces: FontFaceDef[] | undefined): string {
  return (faces ?? [])
    .map(
      (f) =>
        `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(f.src)});font-display:block;${f.weight ? `font-weight:${f.weight};` : ''}${f.style ? `font-style:${f.style};` : ''}${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}}`,
    )
    .join('\n')
}

export function mergeFontFaces(a: FontFaceDef[] | undefined, b: FontFaceDef[]): FontFaceDef[] {
  const seen = new Set<string>()
  const out: FontFaceDef[] = []

  for (const f of [...(a ?? []), ...b]) {
    const key = `${f.family}|${f.weight ?? ''}|${f.style ?? ''}|${f.unicodeRange ?? ''}`

    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }

  return out
}
