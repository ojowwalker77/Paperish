import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Framework, IconSet, ProjectState } from '../shared/types'

interface IconLibrary {
  module: string
  framework: Framework
}

interface IconComponent {
  displayName?: string
}

interface IconModule {
  [name: string]: IconComponent
}

interface IconifySet {
  icons: { [name: string]: { body: string } }
}

interface IconMatch {
  name: string
  svg: string
}

const LIBRARIES: IconLibrary[] = [
  { module: 'lucide-react', framework: 'react' },
  { module: '@heroicons/react/24/outline', framework: 'react' },
  { module: '@tabler/icons-react', framework: 'react' },
  { module: '@phosphor-icons/react', framework: 'react' },
  { module: '@radix-ui/react-icons', framework: 'react' },
  { module: 'lucide-vue-next', framework: 'vue' },
  { module: '@heroicons/vue/24/outline', framework: 'vue' },
  { module: '@tabler/icons-vue', framework: 'vue' },
  { module: '@phosphor-icons/vue', framework: 'vue' },
]

const modules = new Map<string, Promise<IconModule>>()

function packageOf(module: string): string {
  return module
    .split('/')
    .slice(0, module.startsWith('@') ? 2 : 1)
    .join('/')
}

async function importFrom(root: string, module: string): Promise<IconModule> {
  const req = createRequire(path.join(root, 'package.json'))

  try {
    return req(module)
  } catch {
    let dir = path.dirname(req.resolve(module))

    while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))

    return import(pathToFileURL(path.join(dir, pkg.module)).href)
  }
}

function iconModule(root: string, module: string): Promise<IconModule> {
  const key = `${root}\0${module}`

  if (!modules.has(key)) modules.set(key, importFrom(root, module))

  return modules.get(key)!
}

function iconNames(mod: IconModule): string[] {
  const byValue = new Map<IconComponent, string>()

  for (const [name, value] of Object.entries(mod)) {
    if (!/^[A-Z]/.test(name) || !value) continue
    const prev = byValue.get(value)

    if (!prev || name.length < prev.length) byValue.set(value, name)
  }

  return [...byValue.values()].toSorted()
}

export async function loadIcons(
  root: string,
  frameworks: Framework[],
): Promise<IconSet | undefined> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const deps = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }

    const lib = LIBRARIES.find((l) => frameworks.includes(l.framework) && deps[packageOf(l.module)])

    if (!lib) return undefined

    return { ...lib, names: iconNames(await iconModule(root, lib.module)) }
  } catch (e) {
    console.warn(`[paperish] icon library in ${root} failed to load:`, e)

    return undefined
  }
}

function label(name: string): string {
  return name
    .replace(/^(Icon|Ph)(?=[A-Z])/, '')
    .replace(/Icon$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

function score(name: string, terms: string[]): number {
  const l = label(name)
  const parts = l.split('-')
  let s = 0

  for (const t of terms) {
    if (l === t) s += 10
    else if (parts.includes(t)) s += 4
    else if (parts.some((p) => p.startsWith(t))) s += 2
    else if (l.includes(t)) s += 1
  }

  return s
}

function rank(names: string[], query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,|]+/)
    .filter(Boolean)

  return names
    .flatMap((name) => {
      const s = score(name, terms)

      return s ? [{ name, s }] : []
    })
    .toSorted((a, b) => b.s - a.s || a.name.length - b.name.length)
    .map((m) => m.name)
}

function cleanSvg(svg: string): string {
  const out = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(class|aria-hidden|data-slot)="[^"]*"/g, '')

  const open = out.slice(0, out.indexOf('>'))

  if (/\swidth="\d+"/.test(open)) return out

  return (
    open.replace(/\s(width|height)="[^"]*"/g, '') +
    ' width="24" height="24"' +
    out.slice(open.length)
  )
}

async function renderIcon(root: string, icons: IconSet, name: string): Promise<string> {
  const req = createRequire(path.join(root, 'package.json'))
  const Icon = (await iconModule(root, icons.module))[name]

  if (icons.framework === 'react')
    return req('react-dom/server').renderToStaticMarkup(req('react').createElement(Icon))
  const { createSSRApp, h } = req('vue')

  return req('vue/server-renderer').renderToString(createSSRApp({ render: () => h(Icon) }))
}

async function fromCodebase(p: ProjectState, icons: IconSet, query: string, limit: number) {
  const matches: IconMatch[] = []

  for (const name of rank(icons.names, query)) {
    if (matches.length >= limit) break

    try {
      const svg = cleanSvg(await renderIcon(p.root, icons, name))

      if (svg.startsWith('<svg')) matches.push({ name, svg })
    } catch {}
  }

  const first = matches[0]?.name ?? 'Icon'

  return {
    library: icons.module,
    place: `Inside a real component's children, use the component: <Button><${first} /> Save</Button>. Elsewhere paste the svg into write_html (size with width/height, color with color); <${first} /> works there too, as its own live component. get_jsx imports components from ${icons.module}.`,
    icons: matches,
  }
}

async function fromLucide(query: string, limit: number) {
  const { default: set }: { default: IconifySet } = await import(
    '@iconify-json/lucide/icons.json',
    { with: { type: 'json' } }
  )

  return {
    library: 'lucide (built in)',
    place:
      'The codebase has no icon library, so these are Lucide icons: paste the svg into write_html, size it with width/height and color it with color (strokes use currentColor).',
    icons: rank(Object.keys(set.icons), query)
      .slice(0, limit)
      .map((name) => ({
        name,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${set.icons[name].body}</svg>`,
      })),
  }
}

export async function searchIcons(p: ProjectState | undefined, query: string, limit: number) {
  return p?.icons ? fromCodebase(p, p.icons, query, limit) : fromLucide(query, limit)
}
