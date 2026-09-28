import fs from 'node:fs'
import path from 'node:path'
import type { SettingsState } from '../shared/types'
import { DATA_DIR } from './config'

// App-wide settings, kept in the data folder next to the project list. The
// OpenRouter key never leaves this process: editors only learn whether one is set.

const FILE = path.join(DATA_DIR, 'settings.json')

interface Settings {
  openRouterKey?: string
}

let current: Settings = read()

function read(): Settings {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function openRouterKey(): string | undefined {
  return current.openRouterKey || process.env.OPENROUTER_API_KEY || undefined
}

export function settingsState(): SettingsState {
  return { openRouter: !!openRouterKey() }
}

export function updateSettings(patch: { openRouterKey: string }) {
  const next = { ...current }
  const key = String(patch.openRouterKey ?? '').trim()
  if (key) next.openRouterKey = key
  else delete next.openRouterKey
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  current = next
}
