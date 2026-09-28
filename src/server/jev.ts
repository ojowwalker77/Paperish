import { openRouterKey } from './settings'

// Jev (TypeSafe's System One model) through OpenRouter's Decisions API: typed
// answers with probabilities, for judgments code can't make.

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

export interface NoulAnswer {
  type: 'noul'
  noul: number
}

export async function decide(state: string, questions: Record<string, NoulQuestion>): Promise<Record<string, NoulAnswer>> {
  const key = openRouterKey()
  if (!key) throw new Error('No OpenRouter key')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Paperish' },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Jev: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { answers: Record<string, NoulAnswer> }).answers
}
