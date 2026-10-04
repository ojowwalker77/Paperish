import { createHash } from 'node:crypto'
import type { AuditFact, LintIssue, LintState, Op, StyleValue } from '../shared/types'
import { checkAccess } from './a11y'
import { px, readDesignMd, type DesignSystem } from './design-md'
import { engine } from './engine'
import { decide } from './jev'
import { wcagLevel } from './projects'
import { openRouterKey } from './settings'
import type { OpenFile } from './workspace'

// Design checks for a page, against the repo's DESIGN.md: tokens and contrast
// are measured in the layout engine; the prose "Do's and Don'ts" are judged by Jev.

async function lint(f: OpenFile, pageId = f.pageId): Promise<LintState> {
  let ds: DesignSystem | null = null
  let error: string | undefined

  try {
    ds = f.checkout ? readDesignMd(f.checkout) : null
  } catch (e) {
    // SAFETY: readDesignMd throws Error instances for missing files and bad YAML.
    error = (e as Error).message
  }

  const page = f.doc.pages.find((p) => p.id === pageId) ?? f.doc.pages[0]

  const boards = (page ? (f.doc.nodes[page.rootId]?.children ?? []) : []).filter(
    (id) => f.doc.nodes[id] && !f.doc.nodes[id].hidden,
  )

  const facts = boards.length
    ? await engine.call<Record<string, AuditFact[]>>(f, 'audit', { ids: boards }, page!.id)
    : {}

  const issues = boards.flatMap((id) => checkTokens(f, id, facts[id] ?? [], ds))

  let rules: LintState['rules'] = { count: ds?.rules.length ?? 0, status: 'none' }

  if (ds?.rules.length) {
    if (!openRouterKey()) rules.status = 'no-key'
    else
      try {
        const judged = await Promise.all(
          boards.map((id) => checkRules(f.doc.nodes[id].name, id, facts[id] ?? [], ds.rules)),
        )

        issues.push(...judged.flat())
        rules.status = 'checked'
      } catch (e) {
        // SAFETY: decide rejects with Error instances for transport and API failures.
        rules = { ...rules, status: 'error', error: (e as Error).message }
      }
  }

  return { designMd: ds?.path ?? null, issues, rules, error }
}

/** The measured checks for some artboards, without Jev: cheap enough to run after every agent edit. */
export async function checkBoards(f: OpenFile, boardIds: string[]): Promise<LintIssue[]> {
  let ds: DesignSystem | null = null

  try {
    ds = f.checkout ? readDesignMd(f.checkout) : null
  } catch {}

  const out: LintIssue[] = []

  for (const page of f.doc.pages) {
    const ids = boardIds.filter(
      (id) => f.doc.nodes[id]?.parent === page.rootId && !f.doc.nodes[id].hidden,
    )

    if (!ids.length) continue
    const facts = await engine.call<Record<string, AuditFact[]>>(f, 'audit', { ids }, page.id)
    out.push(...ids.flatMap((id) => checkTokens(f, id, facts[id] ?? [], ds)))
  }

  return out
}

const running = new Map<string, Promise<LintState>>()

/** One check at a time per file. */
export function lintFile(f: OpenFile, pageId?: string): Promise<LintState> {
  const next = (running.get(f.doc.id) ?? Promise.resolve())
    .catch(() => {})
    .then(() => lint(f, pageId))

  running.set(f.doc.id, next)
  void next
    .finally(() => running.get(f.doc.id) === next && running.delete(f.doc.id))
    .catch(() => {})

  return next
}

const onScale = (v: number, scale: number[]) => scale.some((s) => Math.abs(s - v) < 0.5)

const nearest = (v: number, scale: number[]) =>
  scale.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))

const pxList = (vs: number[]) =>
  [...new Set(vs.map((v) => Math.round(v * 10) / 10))]
    .toSorted((a, b) => a - b)
    .map((v) => `${v}px`)
    .join(', ')

/** The values themselves when there are a few, else how many. */
const offList = (vs: number[], what: string) => {
  const n = new Set(vs.map((v) => Math.round(v * 10) / 10)).size

  return n <= 3 ? pxList(vs) : `${n} ${what}`
}

const set = (id: string, styles: Record<string, StyleValue | null>): Op => ({
  t: 'styles',
  id,
  set: styles,
})

function checkTokens(
  f: OpenFile,
  boardId: string,
  facts: AuditFact[],
  ds: DesignSystem | null,
): LintIssue[] {
  const out: LintIssue[] = []
  const artboard = f.doc.nodes[boardId].name

  const add = (
    rule: string,
    title: string,
    detail: string,
    nodeIds: string[],
    severity: LintIssue['severity'],
    fix?: Op[],
  ) => {
    const issue: LintIssue = {
      id: `${rule}:${boardId}`,
      rule,
      title,
      detail,
      severity,
      artboard,
      nodeIds,
    }

    if (fix?.length) issue.fix = fix
    out.push(issue)
  }

  for (const i of checkAccess(f.doc.nodes, facts, f.checkout ? wcagLevel(f.checkout) : 'AA'))
    add(i.rule, i.title, i.detail, i.nodeIds, i.severity, i.fix)

  const texts = facts.filter((t) => t.contrast !== undefined)

  const typography = Object.values(ds?.typography ?? {})
  const sizes = typography.map((t) => px(t.fontSize)).filter((v): v is number => v !== null)

  if (sizes.length) {
    const off = texts.filter((t) => !onScale(t.fontSize!, sizes))

    if (off.length)
      add(
        'type/scale',
        'Text sizes off the type scale',
        `${offList(
          off.map((t) => t.fontSize!),
          'sizes',
        )} not in DESIGN.md (${pxList(sizes)})`,
        off.map((t) => t.id),
        'warning',
        off.map((t) => set(t.id, { fontSize: `${nearest(t.fontSize!, sizes)}px` })),
      )
  } else {
    const distinct = [...new Set(texts.map((t) => t.fontSize!))]

    if (distinct.length > 6)
      add(
        'type/scale',
        'Too many text sizes',
        `${distinct.length} sizes on one screen; most need 4 or 5`,
        texts.map((t) => t.id),
        'warning',
      )
  }

  const families = [...new Set(typography.map((t) => t.fontFamily).filter((v): v is string => !!v))]

  if (families.length) {
    const off = texts.filter(
      (t) => !families.some((fam) => fam.toLowerCase() === t.fontFamily!.toLowerCase()),
    )

    if (off.length)
      add(
        'type/family',
        'Fonts not in DESIGN.md',
        `${[...new Set(off.map((t) => t.fontFamily))].join(', ')} used; DESIGN.md has ${families.join(', ')}`,
        off.map((t) => t.id),
        'warning',
        families.length === 1 ? off.map((t) => set(t.id, { fontFamily: families[0] })) : undefined,
      )
  }

  const spacing = Object.values(ds?.spacing ?? {})
    .map(px)
    .filter((v): v is number => v !== null && v >= 0)

  const okSpace = (v: number) =>
    v <= 2 ||
    (spacing.length ? onScale(v, [0, ...spacing]) : Math.abs(v - Math.round(v / 4) * 4) < 0.5)

  const snapSpace = (v: number) =>
    okSpace(v) ? v : spacing.length ? nearest(v, [0, ...spacing]) : Math.round(v / 4) * 4

  const spaced = facts.filter((x) => [...x.padding, ...(x.gap ?? [])].some((v) => !okSpace(v)))

  if (spaced.length) {
    const bad = spaced.flatMap((x) => [...x.padding, ...(x.gap ?? [])].filter((v) => !okSpace(v)))

    const fix = spaced.map((x) => {
      const s: Record<string, StyleValue | null> = {}

      if (x.padding.some((v) => !okSpace(v))) {
        Object.assign(s, { padding: null, paddingBlock: null, paddingInline: null })
        ;['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(
          (k, i) => (s[k] = `${snapSpace(x.padding[i])}px`),
        )
      }

      if (x.gap?.some((v) => !okSpace(v)))
        Object.assign(s, {
          gap: null,
          rowGap: `${snapSpace(x.gap[0])}px`,
          columnGap: `${snapSpace(x.gap[1])}px`,
        })

      return set(x.id, s)
    })

    add(
      'spacing/scale',
      'Spacing off the scale',
      `${offList(bad, 'values')} ${spacing.length ? `not in DESIGN.md (${pxList(spacing)})` : 'not on the 4px grid'}`,
      spaced.map((x) => x.id),
      'warning',
      fix,
    )
  }

  const radii = Object.values(ds?.rounded ?? {})
    .map(px)
    .filter((v): v is number => v !== null)

  if (radii.length) {
    const pill = radii.some((v) => v >= 999)

    const okRadius = (x: AuditFact, v: number) =>
      onScale(v, [0, ...radii]) || (pill && v >= Math.min(x.width, x.height) / 2)

    const round = facts.filter((x) => x.radius.some((v) => !okRadius(x, v)))

    if (round.length) {
      const fix = round.flatMap((x) =>
        x.radius.every((v) => v === x.radius[0])
          ? [
              set(x.id, {
                borderRadius: `${nearest(x.radius[0], [0, ...radii])}px`,
                borderTopLeftRadius: null,
                borderTopRightRadius: null,
                borderBottomRightRadius: null,
                borderBottomLeftRadius: null,
              }),
            ]
          : [],
      )

      add(
        'rounded/scale',
        'Corners off the scale',
        `${offList(
          round.flatMap((x) => x.radius.filter((v) => !okRadius(x, v))),
          'radii',
        )} not in DESIGN.md (${pxList(radii)})`,
        round.map((x) => x.id),
        'warning',
        fix,
      )
    }
  }

  return out
}

const judged = new Map<string, LintIssue[]>()

async function checkRules(
  artboard: string,
  boardId: string,
  facts: AuditFact[],
  rules: string[],
): Promise<LintIssue[]> {
  const state = `Screen "${artboard}", as its rendered elements (indented by nesting):\n${outline(facts)}`
  const key = createHash('sha1').update(state).update(rules.join('\n')).digest('hex')
  const hit = judged.get(key)

  if (hit) return hit
  const asked = rules.slice(0, 64)

  const answers = await decide(
    state,
    Object.fromEntries(
      asked.map((rule, i) => [
        `r${i}`,
        {
          type: 'noul' as const,
          instructions: `Does this screen break the design guideline "${rule}"?`,
          criteria: {
            true: 'The screen clearly breaks the guideline.',
            false: 'The screen follows the guideline, or the guideline does not apply to it.',
          },
        },
      ]),
    ),
  )

  const out = asked.flatMap((rule, i): LintIssue[] => {
    const p = answers[`r${i}`]?.noul ?? 0

    return p < 0.7
      ? []
      : [
          {
            id: `rule/${i}:${boardId}`,
            rule: 'design-md/rule',
            title: rule,
            detail: `Do's and Don'ts · ${Math.round(p * 100)}% sure`,
            severity: 'warning',
            artboard,
            nodeIds: [boardId],
          },
        ]
  })

  if (judged.size > 200) judged.clear()
  judged.set(key, out)

  return out
}

/** A compact text rendering of an artboard for Jev: one line per element. */
function outline(facts: AuditFact[]): string {
  let s = ''

  for (const x of facts) {
    const bits = [`${x.width}x${x.height}`]

    if (x.background) bits.push(`bg ${x.background}`)

    if (x.border) bits.push(`border ${x.border}`)

    if (x.radius.some(Boolean)) bits.push(`radius ${x.radius[0]}`)

    if (x.padding.some(Boolean)) bits.push(`padding ${x.padding.join(' ')}`)

    if (x.gap?.some(Boolean)) bits.push(`gap ${x.gap[0]}`)

    if (x.text !== undefined)
      bits.push(`${x.fontSize}px ${x.fontWeight} ${x.fontFamily} ${x.color}`, `"${x.text}"`)
    s += `${'  '.repeat(x.depth)}<${x.tag}> ${x.name}: ${bits.join(', ')}\n`

    if (s.length > 60_000) break
  }

  return s
}
