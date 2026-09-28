import { z } from 'zod'
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

export async function decide(
  state: string,
  questions: Record<string, NoulQuestion>,
): Promise<Record<string, NoulAnswer>> {
  const key = openRouterKey()

  if (!key) throw new Error('No OpenRouter key')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-title': 'Paperish',
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) throw new Error(`Jev: ${res.status} ${(await res.text()).slice(0, 200)}`)

  const parsed = z
    .object({
      answers: z.record(z.string(), z.object({ type: z.literal('noul'), noul: z.number() })),
    })
    .safeParse(await res.json())

  if (!parsed.success) throw new Error('Jev: bad response shape', { cause: parsed.error })

  return parsed.data.answers
}
