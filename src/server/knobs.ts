import { randomBytes } from 'node:crypto'
import { subtreeIds } from '../shared/ops'
import type { Knob, KnobSet, Op, StyleValue } from '../shared/types'
import type { OpenFile } from './workspace'

const open = new Map<string, KnobSet>()

const sets = new Map<string, { fileId: string; set: KnobSet }>()

const done = new Set<string>()

const waiters = new Map<string, (() => void)[]>()

export function knobsFor(fileId: string): KnobSet | null {
  return open.get(fileId) ?? null
}

export function exposeKnobs(
  f: OpenFile,
  nodeId: string,
  knobs: (Knob & { value: string })[],
): KnobSet {
  const prev = open.get(f.doc.id)

  if (prev) closeKnobs(f, prev.id)

  const k: KnobSet = {
    id: randomBytes(4).toString('hex'),
    nodeId,
    knobs: knobs.map(({ value: _, ...knob }) => knob),
  }

  f.transact(
    [{ t: 'styles', id: nodeId, set: Object.fromEntries(knobs.map((x) => [x.name, x.value])) }],
    'agent',
    'expose_knobs',
  )
  open.set(f.doc.id, k)
  sets.set(k.id, { fileId: f.doc.id, set: k })
  f.broadcast({ t: 'knobs', knobs: k })

  return k
}

export function knobSet(knobsId: string) {
  const e = sets.get(knobsId)

  if (!e) throw new Error(`No knobs "${knobsId}".`)

  return e
}

export function knobValues(f: OpenFile, k: KnobSet): Record<string, string> {
  const n = f.doc.nodes[k.nodeId]

  if (!n) throw new Error('The artboard with these knobs was deleted.')

  return Object.fromEntries(k.knobs.map((x) => [x.name, String(n.styles[x.name] ?? '')]))
}

export const knobsDone = (knobsId: string) => done.has(knobsId)

export function turnKnob(f: OpenFile, knobsId: string, name: string, value: string) {
  const k = open.get(f.doc.id)

  if (!k || k.id !== knobsId) throw new Error('Those knobs are no longer open.')
  const knob = k.knobs.find((x) => x.name === name)

  if (!knob) throw new Error('Not one of the knobs.')
  f.transact([{ t: 'styles', id: k.nodeId, set: { [name]: value } }], 'user', `turn ${knob.label}`)
}

export function closeKnobs(f: OpenFile, knobsId: string) {
  if (open.get(f.doc.id)?.id === knobsId) {
    open.delete(f.doc.id)
    f.broadcast({ t: 'knobs', knobs: null })
  }

  done.add(knobsId)

  for (const w of waiters.get(knobsId) ?? []) w()
  waiters.delete(knobsId)
}

export function inlineKnobs(f: OpenFile, k: KnobSet) {
  const values = knobValues(f, k)
  const ops: Op[] = []

  for (const id of subtreeIds(f.doc.nodes, k.nodeId)) {
    const set: Record<string, StyleValue | null> = {}

    for (const [prop, raw] of Object.entries(f.doc.nodes[id].styles)) {
      const v = String(raw)

      if (!v.includes('var(')) continue

      const next = k.knobs.reduce(
        (s, x) =>
          s.replace(new RegExp(`var\\(\\s*${x.name}\\s*(?:,[^()]*)?\\)`, 'g'), values[x.name]),
        v,
      )

      if (next !== v) set[prop] = next
    }

    if (id === k.nodeId) for (const x of k.knobs) set[x.name] = null

    if (Object.keys(set).length) ops.push({ t: 'styles', id, set })
  }

  f.transact(ops, 'agent', 'commit_knobs')
}

export function waitForKnobs(knobsId: string, timeoutMs: number): Promise<boolean> {
  if (done.has(knobsId)) return Promise.resolve(true)

  return new Promise((resolve) => {
    const w = () => {
      clearTimeout(timer)
      resolve(true)
    }

    const timer = setTimeout(() => {
      waiters.set(
        knobsId,
        (waiters.get(knobsId) ?? []).filter((x) => x !== w),
      )
      resolve(false)
    }, timeoutMs)

    waiters.set(knobsId, [...(waiters.get(knobsId) ?? []), w])
  })
}
