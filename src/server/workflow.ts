import fs from 'node:fs'
import path from 'node:path'
import { ROOT_DIR } from './config'
import { hasGitHubRemote } from './git'
import type { Project, Projects } from './projects'

export const WORKFLOW = '.github/workflows/paperish-design-diff.yml'

const template = (version: string) => `name: Paperish design diff

on:
  pull_request:
    paths: ['**/*.paperish']

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: paperish-design-diff-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  design-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ojowwalker77/Paperish@v${version}
`

export const hasWorkflow = (checkout: string) => fs.existsSync(path.join(checkout, WORKFLOW))

export async function offersDesignDiffs(projects: Projects, p: Project, checkout: string) {
  return (
    !p.scratch &&
    !projects.designDiffsDismissed(p) &&
    !hasWorkflow(checkout) &&
    projects.files(p, checkout).length > 0 &&
    (await hasGitHubRemote(checkout))
  )
}

export function writeWorkflow(checkout: string): string {
  const file = path.join(checkout, WORKFLOW)

  if (fs.existsSync(file)) return file
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, template(version))

  return file
}
