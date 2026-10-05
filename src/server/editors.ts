import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDITORS = [
  { name: 'Cursor', app: 'Cursor', cli: 'cursor' },
  { name: 'VS Code', app: 'Visual Studio Code', cli: 'code' },
  { name: 'Zed', app: 'Zed', cli: 'zed' },
  { name: 'Windsurf', app: 'Windsurf', cli: 'windsurf' },
  { name: 'WebStorm', app: 'WebStorm', cli: 'webstorm' },
  { name: 'IntelliJ IDEA', app: 'IntelliJ IDEA', cli: 'idea' },
  { name: 'Sublime Text', app: 'Sublime Text', cli: 'subl' },
]

interface Editor {
  name: string
  command: string
  args: string[]
}

function find(): Editor | null {
  for (const e of EDITORS) {
    if (process.platform === 'darwin') {
      const app = [
        `/Applications/${e.app}.app`,
        path.join(os.homedir(), 'Applications', `${e.app}.app`),
      ].find((p) => fs.existsSync(p))

      if (app) return { name: e.name, command: 'open', args: ['-a', app] }
    } else {
      const bin = (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((dir) => path.join(dir, e.cli))
        .find((p) => fs.existsSync(p))

      if (bin) return { name: e.name, command: bin, args: [] }
    }
  }

  return null
}

const editor = find()

export const editorName = () => editor?.name ?? null

export function openInEditor(checkout: string, file: string) {
  const target = path.resolve(checkout, file)

  if (!editor || !target.startsWith(checkout + path.sep)) return
  execFile(editor.command, [...editor.args, checkout, target], () => {})
}
