import fs from 'node:fs'
import path from 'node:path'
import type { SettingsState, ThemeSetting } from '../shared/types'
import { DATA_DIR } from './config'
import { call } from './host'

// App-wide settings, kept in the data folder next to the project list. The
// OpenRouter key and Figma token never leave this process: editors only learn whether one is set.

const FILE = path.join(DATA_DIR, 'settings.json')

interface Settings {
  openRouterKey?: string
  figmaToken?: string
  theme?: ThemeSetting
}

const THEMES = new Set<ThemeSetting>(['system', 'light', 'dark'])

let current: Settings = read()

void call('setTheme', theme())

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

export function figmaToken(): string | undefined {
  return current.figmaToken || process.env.FIGMA_TOKEN || undefined
}

function theme(): ThemeSetting {
  return current.theme && THEMES.has(current.theme) ? current.theme : 'system'
}

export function settingsState(): SettingsState {
  return { openRouter: !!openRouterKey(), figma: !!figmaToken(), theme: theme() }
}

export function updateSettings(patch: {
  openRouterKey?: string
  figmaToken?: string
  theme?: ThemeSetting
}) {
  const next = { ...current }

  for (const k of ['openRouterKey', 'figmaToken'] as const) {
    if (patch[k] === undefined) continue
    const key = String(patch[k]).trim()

    if (key) next[k] = key
    else delete next[k]
  }

  if (patch.theme && THEMES.has(patch.theme)) next.theme = patch.theme
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  current = next
  void call('setTheme', theme())
}
