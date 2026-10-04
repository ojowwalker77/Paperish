import type { AuditFact, LintIssue, Op, PNode } from '../shared/types'

type Finding = Omit<LintIssue, 'id' | 'artboard'>

const ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
])

const interactive = (n: PNode) =>
  n.tag === 'a' || n.tag === 'button' || n.tag === 'summary' || ROLES.has(n.attrs?.role ?? '')

const large = (t: AuditFact) => t.fontSize! >= 24 || (t.fontSize! >= 18.66 && t.fontWeight! >= 700)

const names = (xs: AuditFact[]) => {
  const all = [...new Set(xs.map((x) => `"${x.name}"`))]

  return all.length <= 3
    ? all.join(', ')
    : `${all.slice(0, 2).join(', ')} and ${all.length - 2} more`
}

const center = (x: AuditFact) => [x.x + x.width / 2, x.y + x.height / 2]

const toRect = ([cx, cy]: number[], b: AuditFact) =>
  Math.hypot(Math.max(b.x - cx, 0, cx - b.x - b.width), Math.max(b.y - cy, 0, cy - b.y - b.height))

const under = (x: AuditFact, px: number) => x.width < px || x.height < px

const above = (a: AuditFact, b: AuditFact) => b.y + b.height <= a.y

const before = (a: AuditFact, b: AuditFact) => above(a, b) || (!above(b, a) && b.x + b.width <= a.x)

export function checkAccess(
  nodes: Record<string, PNode>,
  facts: AuditFact[],
  level: 'AA' | 'AAA',
): Finding[] {
  const out: Finding[] = []
  const byId = new Map(facts.map((x) => [x.id, x]))

  const ancestors = (id: string) => {
    const list: PNode[] = []

    for (let p = nodes[id]?.parent; p && byId.has(p); p = nodes[p]?.parent) list.push(nodes[p])

    return list
  }

  const need = (t: AuditFact) => (level === 'AAA' ? (large(t) ? 4.5 : 7) : large(t) ? 3 : 4.5)
  const low = facts.filter((t) => t.contrast !== undefined && t.contrast < need(t))

  if (low.length) {
    const w = low.reduce((a, b) => (a.contrast! < b.contrast! ? a : b))

    out.push({
      rule: 'color/contrast',
      title: 'Low contrast',
      detail:
        low.length === 1
          ? `"${w.name}" ${w.color} on ${w.backdrop} is ${w.contrast}:1, needs ${need(w)}:1 for ${level}`
          : `${low.length} texts below ${level}, lowest "${w.name}" ${w.color} on ${w.backdrop} at ${w.contrast}:1`,
      nodeIds: low.map((t) => t.id),
      severity: low.some((t) => t.contrast! < (large(t) ? 3 : 4.5)) ? 'error' : 'warning',
    })
  }

  const min = level === 'AAA' || facts[0]?.width <= 1024 ? 44 : 24

  const targets = facts.filter(
    (x) =>
      x.depth > 0 && nodes[x.id] && interactive(nodes[x.id]) && !ancestors(x.id).some(interactive),
  )

  const spaced = (a: AuditFact) =>
    targets.every(
      (b) =>
        b === a ||
        (under(b, 24)
          ? Math.hypot(center(a)[0] - center(b)[0], center(a)[1] - center(b)[1]) >= 24
          : toRect(center(a), b) >= 12),
    )

  const small = targets.filter((x) => under(x, min) && !(min === 24 && spaced(x)))

  if (small.length)
    out.push({
      rule: 'a11y/target',
      title: 'Small tap targets',
      detail:
        small.length === 1
          ? `"${small[0].name}" is ${small[0].width}×${small[0].height}px, needs ${min}×${min}px`
          : `${small.length} targets under ${min}×${min}px: ${names(small)}`,
      nodeIds: small.map((x) => x.id),
      severity: 'warning',
    })

  const silent = (id: string) =>
    [nodes[id], ...ancestors(id)].some(
      (n) =>
        n?.attrs?.['aria-hidden'] === 'true' ||
        n?.attrs?.role === 'presentation' ||
        n?.attrs?.role === 'none',
    )

  const bare = facts.filter(
    (x) => x.type === 'Image' && nodes[x.id]?.attrs?.alt === undefined && !silent(x.id),
  )

  if (bare.length)
    out.push({
      rule: 'a11y/alt',
      title: 'Images without alt text',
      detail:
        bare.length === 1
          ? `${names(bare)} has no alt; describe it, or set alt="" if decorative`
          : `${bare.length} images have no alt: ${names(bare)}; describe each, or set alt="" if decorative`,
      nodeIds: bare.map((x) => x.id),
      severity: 'warning',
    })

  const headingLevel = (x: AuditFact) => {
    const tag = /^h([1-6])$/.exec(x.tag)

    if (tag) return Number(tag[1])
    const n = nodes[x.id]

    return n?.attrs?.role === 'heading' ? Number(n.attrs['aria-level']) || 2 : 0
  }

  const skips: { x: AuditFact; from: number; to: number }[] = []
  let prev = 0

  for (const x of facts) {
    const h = headingLevel(x)

    if (!h) continue

    if (prev && h > prev + 1) {
      skips.push({ x, from: prev, to: prev + 1 })
      prev += 1
    } else prev = h
  }

  if (skips.length) {
    const fix = skips.flatMap(({ x, to }): Op[] =>
      /^h[1-6]$/.test(x.tag) ? [{ t: 'patch', id: x.id, patch: { tag: `h${to}` } }] : [],
    )

    const finding: Finding = {
      rule: 'a11y/headings',
      title: 'Heading levels skipped',
      detail:
        skips.length === 1
          ? `"${skips[0].x.name}" is h${headingLevel(skips[0].x)} after h${skips[0].from}`
          : `${skips.length} headings skip levels: ${names(skips.map((s) => s.x))}`,
      nodeIds: skips.map((s) => s.x.id),
      severity: 'warning',
    }

    if (fix.length) finding.fix = fix
    out.push(finding)
  }

  const reordered = facts.filter((x) => {
    if (!x.reorder) return false
    const kids = (nodes[x.id]?.children ?? []).flatMap((c) => byId.get(c) ?? [])

    return kids.some((k, i) => i > 0 && before(kids[i - 1], k))
  })

  if (reordered.length)
    out.push({
      rule: 'a11y/order',
      title: 'Reading order differs from layout',
      detail: `${reordered.length === 1 ? `${names(reordered)} uses ${reordered[0].reorder}` : `${reordered.length} layers reorder content with CSS`}, so Tab and screen readers don't follow what's on screen`,
      nodeIds: reordered.map((x) => x.id),
      severity: 'warning',
    })

  return out
}
