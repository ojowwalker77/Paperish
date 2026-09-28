import fs from 'node:fs'
import path from 'node:path'
import type { ComponentInfo, ComponentProp, Doc, Framework, ProjectState } from '../shared/types'
import { startHost, type HostHandle } from './component-host'

// Linked codebases: detect frameworks and Tailwind, discover components and
// their props, and run a component host (a Vite dev server inside the project)
// so components render on the canvas with the project's own toolchain.

interface Runtime {
  state: ProjectState
  host?: HostHandle
  starting?: Promise<void>
  watcher?: fs.FSWatcher
}

const projects = new Map<string, Runtime>()
const listeners = new Set<(s: ProjectState) => void>()

export function onProjectChange(fn: (s: ProjectState) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(rt: Runtime) {
  for (const fn of listeners) fn(rt.state)
}

export function projectState(root: string | undefined): ProjectState | undefined {
  return root ? projects.get(path.resolve(root))?.state : undefined
}

export function projectFor(doc: Doc): ProjectState | undefined {
  return projectState(doc.project?.root)
}

export function componentsFor(doc: Doc): ComponentInfo[] {
  return projectFor(doc)?.components ?? []
}

/** The linked codebase's Tailwind v4 CSS entry, so write_html uses its theme. */
export function tailwindEntryFor(doc: Doc): string | undefined {
  const p = projectFor(doc)
  if (!p || !p.tailwind || !/^4/.test(p.tailwind) || !p.cssEntries[0]) return undefined
  return path.join(p.root, p.cssEntries[0])
}

export function validateRoot(input: string): string {
  const root = path.resolve(input.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`)
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error(`No package.json in ${root} — link the folder that contains your app's package.json.`)
  return root
}

/** Analyze a project (once) and start its component host. Resolves when ready or failed. */
export async function ensureProject(input: string): Promise<ProjectState> {
  const root = validateRoot(input)
  let rt = projects.get(root)
  if (!rt) {
    rt = { state: { ...analyze(root), status: 'starting' } }
    projects.set(root, rt)
    emit(rt)
    const r = rt
    r.starting = (async () => {
      try {
        r.host = await startHost(root, () => r.state)
        r.state = { ...r.state, status: 'ready', hostOrigin: r.host.origin }
      } catch (e) {
        r.state = { ...r.state, status: 'error', error: (e as Error).message.split('\n')[0] }
        console.warn(`[paperish] component host for ${root} failed:`, e)
      }
      emit(r)
      watch(r)
    })()
  }
  await rt.starting
  return rt.state
}

function watch(rt: Runtime) {
  let timer: NodeJS.Timeout | null = null
  try {
    rt.watcher = fs.watch(rt.state.root, { recursive: true }, (_e, file) => {
      if (!file || !/\.(tsx|jsx|vue|css)$/.test(file) || SKIP_PATH.test(file)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const next = analyze(rt.state.root)
        const changed =
          JSON.stringify(next.components) !== JSON.stringify(rt.state.components) ||
          next.cssEntries.join() !== rt.state.cssEntries.join() ||
          next.globalCss.join() !== rt.state.globalCss.join()
        if (!changed) return
        rt.state = { ...rt.state, ...next }
        rt.host?.refresh()
        emit(rt)
      }, 400)
    })
  } catch {}
}

export async function closeProjects() {
  for (const rt of projects.values()) {
    rt.watcher?.close()
    await rt.host?.close().catch(() => {})
  }
}

// ---- analysis -----------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', 'coverage', 'out', 'public', '.turbo', '.vercel', '.svelte-kit', 'storybook-static', '.cache', 'vendor', 'tmp'])
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|\.next|\.nuxt|coverage|out)\//
const SKIP_FILE = /\.(test|spec|stories|story|d)\.[jt]sx?$|(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware|main|_app|_document)\.[jt]sx?$/

function analyze(root: string): Omit<ProjectState, 'status' | 'hostOrigin' | 'error'> {
  const pkg = readJson(path.join(root, 'package.json')) ?? {}
  const deps: Record<string, string> = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  const frameworks: Framework[] = []
  if (deps.react) frameworks.push('react')
  if (deps.vue) frameworks.push('vue')
  const installedTw = readJson(path.join(root, 'node_modules/tailwindcss/package.json'))?.version as string | undefined
  const tailwind = installedTw ?? (deps.tailwindcss ? deps.tailwindcss.replace(/^[^\d]*/, '') : null)
  const files = listFiles(root)
  const cssEntries = files
    .filter((f) => f.endsWith('.css'))
    .filter((f) => /@import\s+["']tailwindcss["']|@tailwind\s+base|@import\s+["']tailwindcss\/(?!theme|utilities|preflight)/.test(readSmall(path.join(root, f))))
    .sort((a, b) => cssRank(a) - cssRank(b))
  const aliases = readAliases(root)
  const components: ComponentInfo[] = []
  for (const f of files) {
    if (!/\.(tsx|jsx|vue)$/.test(f) || SKIP_FILE.test(f)) continue
    const src = readSmall(path.join(root, f))
    if (!src) continue
    if (f.endsWith('.vue')) {
      if (!frameworks.includes('vue')) continue
      const name = pascal(path.basename(f, '.vue'))
      components.push({
        id: `${f}#default`,
        name,
        file: f,
        export: 'default',
        framework: 'vue',
        importPath: importPathFor(f, aliases),
        props: vueProps(src),
        slot: /<slot\b/.test(src),
      })
    } else {
      if (!frameworks.includes('react') || !/<[A-Za-z][\w.]*[\s/>]/.test(src)) continue
      const cva = cvaVariants(src)
      for (const ex of reactExports(src, f)) {
        components.push({
          id: `${f}#${ex.export}`,
          name: ex.name,
          file: f,
          export: ex.export,
          framework: 'react',
          importPath: importPathFor(f, aliases),
          props: reactProps(src, ex.name, cva),
          slot: /\bchildren\b|\{\s*\.\.\.props\s*\}|\.\.\.rest/.test(src),
        })
      }
    }
  }
  // Names must be unique for PascalCase tags; later duplicates get a folder prefix.
  const seen = new Map<string, number>()
  for (const c of components) {
    const n = seen.get(c.name) ?? 0
    seen.set(c.name, n + 1)
    if (n > 0) c.name = pascal(path.basename(path.dirname(c.file))) + c.name
  }
  return {
    root,
    name: (pkg.name as string) || path.basename(root),
    frameworks,
    tailwind,
    cssEntries,
    globalCss: globalStylesheets(root, aliases),
    components: components.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

// Files that set an app up; whatever CSS they import applies to every screen.
const ENTRY_FILES = [
  'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
  'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  'src/App.tsx', 'src/App.jsx', 'src/App.vue',
  'app/layout.tsx', 'app/layout.jsx', 'src/app/layout.tsx', 'src/app/layout.jsx',
  'pages/_app.tsx', 'pages/_app.jsx', 'src/pages/_app.tsx', 'src/pages/_app.jsx',
  'app/root.tsx', 'app/root.jsx',
]

/**
 * Global stylesheets, in the order the app loads them: side-effect CSS imports
 * (`import './index.css'`, `import '@fontsource/inter'`-style packages ending
 * in .css) from the app's entry files, including the module index.html loads.
 * Returned as import specifiers: `/path` for project files, bare for packages.
 */
function globalStylesheets(root: string, aliases: Record<string, string>): string[] {
  const entries: string[] = []
  const html = readSmall(path.join(root, 'index.html'))
  for (const m of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"'?]+)["']/g)) entries.push(m[1].replace(/^\.?\//, ''))
  entries.push(...ENTRY_FILES)
  const out: string[] = []
  for (const entry of [...new Set(entries)]) {
    const src = readSmall(path.join(root, entry))
    if (!src) continue
    for (const m of src.matchAll(/^\s*import\s+["']([^"'?]+\.(?:css|scss|sass|less|styl|pcss))["']/gm)) {
      const spec = m[1]
      if (/\.module\.\w+$/.test(spec)) continue
      let file: string | null = null
      if (spec.startsWith('.')) file = path.posix.normalize(path.posix.join(path.posix.dirname(entry), spec))
      else if (spec.startsWith('/')) file = spec.slice(1)
      else {
        const alias = Object.keys(aliases).find((a) => spec.startsWith(a))
        if (alias) file = path.posix.normalize(aliases[alias] + (aliases[alias].endsWith('/') ? '' : '/') + spec.slice(alias.length))
      }
      const resolved = file === null ? spec : fs.existsSync(path.join(root, file)) ? `/${file}` : null
      if (resolved && !out.includes(resolved)) out.push(resolved)
    }
  }
  return out
}

function cssRank(f: string): number {
  const preferred = ['src/index.css', 'src/main.css', 'src/app.css', 'app/globals.css', 'src/app/globals.css', 'src/styles/globals.css', 'styles/globals.css', 'src/assets/main.css']
  const i = preferred.indexOf(f)
  return i < 0 ? 100 + f.split('/').length : i
}

function listFiles(root: string, max = 3000): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= max) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.storybook') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1)
      } else if (/\.(tsx|jsx|vue|css)$/.test(e.name)) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root, 0)
  return out
}

function readSmall(file: string): string {
  try {
    const st = fs.statSync(file)
    return st.size > 256 * 1024 ? '' : fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function stripJsonComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')
}

/** tsconfig/jsconfig `paths`: alias prefix -> project-relative directory. */
export function readAliases(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const cfg = readJson(path.join(root, name))
    const opts = cfg?.compilerOptions
    if (!opts?.paths) continue
    const base = opts.baseUrl ?? '.'
    for (const [k, v] of Object.entries(opts.paths as Record<string, string[]>)) {
      if (!k.endsWith('/*') || !v[0]?.endsWith('/*')) continue
      out[k.slice(0, -1)] = path.posix.normalize(path.posix.join(base, v[0].slice(0, -1))).replace(/^\.\//, '')
    }
  }
  if (!Object.keys(out).length && fs.existsSync(path.join(root, 'src'))) out['@/'] = 'src/'
  return out
}

function importPathFor(file: string, aliases: Record<string, string>): string {
  let spec = file.replace(/\.(tsx|jsx)$/, '').replace(/\/index$/, '')
  for (const [alias, dir] of Object.entries(aliases)) {
    const d = dir.endsWith('/') ? dir : `${dir}/`
    if (spec.startsWith(d)) return alias + spec.slice(d.length)
  }
  return `./${spec}`
}

function pascal(s: string): string {
  return s.replace(/(^|[-_ .]+)(\w)/g, (_m, _s, c: string) => c.toUpperCase())
}

// ---- React --------------------------------------------------------------------------

const IS_COMPONENT_NAME = /^[A-Z][a-z0-9]\w*$|^[A-Z]$/

function reactExports(src: string, file: string): { name: string; export: string }[] {
  const out = new Map<string, { name: string; export: string }>()
  const add = (name: string, exp: string) => IS_COMPONENT_NAME.test(name) && !out.has(exp) && out.set(exp, { name, export: exp })
  for (const m of src.matchAll(/export\s+default\s+(?:async\s+)?function\s+([A-Z]\w*)/g)) add(m[1], 'default')
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]\w*)/g)) add(m[1], m[1])
  for (const m of src.matchAll(/export\s+(?:const|let)\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*([^;\n]{0,60})/g)) {
    if (/^\s*(\(|async|function|React\.|forwardRef|memo|styled|\w+\s*=>)/.test(m[2]) || /forwardRef|memo|=>/.test(m[2])) add(m[1], m[1])
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}(?!\s*from)/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim()
      if (!p || p.startsWith('type ')) continue
      const [local, alias] = p.split(/\s+as\s+/).map((x) => x.trim())
      if (alias === 'default') add(local, 'default')
      else add(alias ?? local, alias ?? local)
    }
  }
  const def = src.match(/export\s+default\s+(?:React\.)?(?:memo|forwardRef)?\(?\s*([A-Z]\w*)\s*\)?\s*;?\s*$/m)
  if (def) add(def[1], 'default')
  if (!out.has('default') && /export\s+default\s+(?:React\.)?(?:memo|forwardRef)\(/.test(src)) add(pascal(path.basename(file).replace(/\.[jt]sx$/, '')), 'default')
  return [...out.values()]
}

interface Cva {
  variants: Record<string, string[]>
  defaults: Record<string, string>
}

function cvaVariants(src: string): Map<string, Cva> {
  const out = new Map<string, Cva>()
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*cva\s*\(/g)) {
    const start = m.index! + m[0].length
    const body = balanced(src, src.indexOf('{', src.indexOf(',', start)))
    if (!body) continue
    const variants: Record<string, string[]> = {}
    const vBlock = blockAfter(body, /variants\s*:\s*\{/)
    if (vBlock) for (const [key, inner] of objectEntries(vBlock)) variants[key] = objectEntries(inner).map(([k]) => k)
    const defaults: Record<string, string> = {}
    const dBlock = blockAfter(body, /defaultVariants\s*:\s*\{/)
    if (dBlock) for (const m2 of dBlock.matchAll(/(\w+)\s*:\s*["']([^"']+)["']/g)) defaults[m2[1]] = m2[2]
    out.set(m[1], { variants, defaults })
  }
  return out
}

function reactProps(src: string, name: string, cva: Map<string, Cva>): ComponentProp[] {
  const props = new Map<string, ComponentProp>()
  const add = (p: ComponentProp) => !props.has(p.name) && props.set(p.name, p)

  // Parameter annotation of the component.
  let annotation: string | null = null
  let destructure = ''
  const fnRe = new RegExp(`(?:function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(|(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:React\\.)?(?:forwardRef|memo)?\\s*(?:<[^(]*>)?\\s*\\(?\\s*(?:function\\s*\\w*\\s*)?\\()`)
  const fm = src.match(fnRe)
  if (fm) {
    const param = paramText(src, fm.index! + fm[0].length)
    const colon = topLevelIndex(param, ':')
    if (param.trim().startsWith('{')) destructure = balanced(param, param.indexOf('{')) ?? ''
    if (colon >= 0) annotation = param.slice(colon + 1).trim()
  }
  const fwd = src.match(new RegExp(`${name}\\s*=\\s*(?:React\\.)?forwardRef\\s*<[^,]+,\\s*([^>]+)>`))
  if (fwd) annotation = fwd[1].trim()
  if (!annotation && new RegExp(`(?:interface|type)\\s+${name}Props\\b`).test(src)) annotation = `${name}Props`

  if (annotation) for (const p of typeProps(src, annotation, cva, 0)) add(p)

  // Defaults from `{ size = 'md' }` destructuring.
  for (const m of destructure.matchAll(/(\w+)\s*=\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)/g)) {
    const p = props.get(m[1])
    if (p) p.default = m[2].replace(/^['"]|['"]$/g, '')
  }
  if (!props.has('children')) {
    // children are handled as content; don't list them as a prop.
  }
  props.delete('children')
  props.delete('className')
  props.delete('asChild')
  return [...props.values()]
}

function typeProps(src: string, annotation: string, cva: Map<string, Cva>, depth: number): ComponentProp[] {
  if (depth > 4) return []
  const out: ComponentProp[] = []
  for (const part of splitTopLevel(annotation, '&')) {
    const t = part.trim()
    const vp = t.match(/VariantProps\s*<\s*typeof\s+(\w+)\s*>/)
    if (vp) {
      const c = cva.get(vp[1])
      if (c) for (const [k, opts] of Object.entries(c.variants)) out.push({ name: k, type: 'enum', options: opts, default: c.defaults[k] })
      continue
    }
    if (t.startsWith('{')) {
      out.push(...members(balanced(t, 0) ?? ''))
      continue
    }
    const ident = t.match(/^([A-Z]\w*)/)?.[1]
    if (!ident || /HTMLAttributes|Props<|ComponentProps|PropsWithChildren|ComponentPropsWithoutRef/.test(t)) {
      const inner = t.match(/PropsWithChildren<\s*(\w+)\s*>/)?.[1]
      if (inner) out.push(...typeProps(src, inner, cva, depth + 1))
      continue
    }
    const iface = src.match(new RegExp(`interface\\s+${ident}\\s*(?:<[^>]*>)?\\s*(?:extends\\s+([^{]+))?\\{`))
    if (iface) {
      out.push(...members(balanced(src, iface.index! + iface[0].length - 1) ?? ''))
      if (iface[1]) for (const e of splitTopLevel(iface[1], ',')) out.push(...typeProps(src, e.trim(), cva, depth + 1))
      continue
    }
    const alias = src.match(new RegExp(`type\\s+${ident}\\s*(?:<[^>]*>)?\\s*=\\s*`))
    if (alias) {
      const rest = src.slice(alias.index! + alias[0].length)
      out.push(...typeProps(src, typeExpr(rest), cva, depth + 1))
    }
  }
  return out
}

/** Members of a `{ a: string; b?: 'x' | 'y' }` type literal body. */
function members(body: string): ComponentProp[] {
  const out: ComponentProp[] = []
  const inner = body.replace(/^\{|\}$/g, '').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  for (const raw of splitTopLevel(inner, ';', true)) {
    const m = raw.trim().match(/^(?:readonly\s+)?["']?([A-Za-z_$][\w$-]*)["']?(\?)?\s*:\s*([\s\S]+)$/)
    if (!m) continue
    const type = m[3].trim().replace(/,$/, '')
    if (/=>/.test(type) || /^\(/.test(type)) continue // callbacks can't be set from the canvas
    out.push({ name: m[1], required: !m[2], ...classifyType(type) })
  }
  return out
}

function classifyType(type: string): Pick<ComponentProp, 'type' | 'options'> {
  const t = type.replace(/\s+/g, ' ').trim()
  const lits = t.split('|').map((x) => x.trim())
  if (lits.length && lits.every((x) => /^(['"]).*\1$/.test(x) || x === 'undefined' || x === 'null')) {
    return { type: 'enum', options: lits.filter((x) => /^['"]/.test(x)).map((x) => x.slice(1, -1)) }
  }
  const base = lits.filter((x) => x !== 'undefined' && x !== 'null')
  if (base.length === 1) {
    const b = base[0]
    if (b === 'string') return { type: 'string' }
    if (b === 'number') return { type: 'number' }
    if (b === 'boolean' || b === 'true' || b === 'false') return { type: 'boolean' }
    if (/ReactNode|ReactElement|JSX\.Element/.test(b)) return { type: 'node' }
    if (/\[\]$|^Array<|^Record<|^\{/.test(b)) return { type: 'object' }
  }
  return { type: 'unknown' }
}

// ---- Vue --------------------------------------------------------------------------------

function vueProps(src: string): ComponentProp[] {
  const script = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  let props: ComponentProp[] = []
  const typed = script.match(/defineProps\s*<\s*/)
  if (typed) {
    const start = typed.index! + typed[0].length
    const arg = angleArg(script, start)
    if (arg.trim().startsWith('{')) props = members(arg.trim())
    else {
      const ident = arg.trim().match(/^\w+/)?.[0]
      const iface = ident && script.match(new RegExp(`interface\\s+${ident}\\s*(?:extends[^{]+)?\\{`))
      if (iface) props = members(balanced(script, iface.index! + iface[0].length - 1) ?? '')
      else if (ident) {
        const alias = script.match(new RegExp(`type\\s+${ident}\\s*=\\s*`))
        if (alias) props = members(balanced(script, script.indexOf('{', alias.index!)) ?? '')
      }
    }
    const wd = script.match(/withDefaults\s*\(\s*defineProps[\s\S]*?\)\s*,\s*\{/)
    if (wd) {
      const block = balanced(script, wd.index! + wd[0].length - 1) ?? ''
      for (const m of block.matchAll(/(\w+)\s*:\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)/g)) {
        const p = props.find((x) => x.name === m[1])
        if (p) {
          p.default = m[2].replace(/^['"]|['"]$/g, '')
          p.required = false
        }
      }
    }
    return props
  }
  const runtime = script.match(/defineProps\s*\(\s*(\{|\[)/) ?? script.match(/\bprops\s*:\s*(\{|\[)/)
  if (!runtime) return []
  const open = runtime.index! + runtime[0].length - 1
  if (runtime[1] === '[') {
    const arr = script.slice(open, script.indexOf(']', open))
    return [...arr.matchAll(/['"](\w+)['"]/g)].map((m) => ({ name: m[1], type: 'unknown' as const }))
  }
  for (const [key, value] of objectEntries(balanced(script, open) ?? '')) {
    const v = value.trim()
    const typeName = v.startsWith('{') ? v.match(/type\s*:\s*(\w+)/)?.[1] : v.match(/^(\w+)/)?.[1]
    const def = v.match(/default\s*:\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)/)?.[1]
    const map: Record<string, ComponentProp['type']> = { String: 'string', Number: 'number', Boolean: 'boolean', Array: 'object', Object: 'object' }
    props.push({
      name: key,
      type: map[typeName ?? ''] ?? 'unknown',
      required: /required\s*:\s*true/.test(v),
      default: def?.replace(/^['"]|['"]$/g, ''),
    })
  }
  return props
}

// ---- tiny source helpers ---------------------------------------------------------------

/** Text of a balanced {...} (or [...]) block starting at `open`. */
function balanced(s: string, open: number): string | null {
  if (open < 0 || open >= s.length) return null
  const o = s[open]
  const c = o === '{' ? '}' : o === '[' ? ']' : o === '(' ? ')' : o === '<' ? '>' : null
  if (!c) return null
  let d = 0
  let q: string | null = null
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\') i++
      else if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch
    else if (ch === o) d++
    else if (ch === c && --d === 0) return s.slice(open, i + 1)
  }
  return null
}

function blockAfter(s: string, re: RegExp): string | null {
  const m = s.match(re)
  return m ? balanced(s, m.index! + m[0].length - 1) : null
}

/** Top-level `key: value` pairs of an object literal. */
function objectEntries(block: string): [string, string][] {
  const inner = block.replace(/^\{/, '').replace(/\}$/, '')
  const out: [string, string][] = []
  for (const part of splitTopLevel(inner, ',')) {
    const m = part.trim().match(/^["']?([\w$-]+)["']?\s*:\s*([\s\S]*)$/)
    if (m) out.push([m[1], m[2]])
  }
  return out
}

function splitTopLevel(s: string, sep: string, newlines = false): string[] {
  const out: string[] = []
  let d = 0
  let q: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      cur += ch
      if (ch === '\\') cur += s[++i] ?? ''
      else if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch
    else if ('{[(<'.includes(ch)) d++
    else if ('}])>'.includes(ch) && !(ch === '>' && s[i - 1] === '=')) d--
    if (d === 0 && (ch === sep || (newlines && ch === '\n' && !/[|&,:]\s*$/.test(cur) && !/^\s*[|&]/.test(s.slice(i + 1))))) {
      if (cur.trim()) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function topLevelIndex(s: string, ch: string): number {
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if ('{[(<'.includes(s[i])) d++
    else if ('}])>'.includes(s[i])) d--
    else if (s[i] === ch && d === 0) return i
  }
  return -1
}

/** Text inside the parentheses that start at `from` (just after the `(`). */
function paramText(s: string, from: number): string {
  let d = 1
  for (let i = from; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')' && --d === 0) return s.slice(from, i)
  }
  return ''
}

function angleArg(s: string, from: number): string {
  let d = 1
  for (let i = from; i < s.length; i++) {
    if (s[i] === '<') d++
    else if (s[i] === '>' && s[i - 1] !== '=' && --d === 0) return s.slice(from, i)
  }
  return ''
}

/** A type alias right-hand side, up to the end of the statement. */
function typeExpr(rest: string): string {
  let d = 0
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if ('{[(<'.includes(ch)) d++
    else if ('}])>'.includes(ch) && !(ch === '>' && rest[i - 1] === '=')) d--
    else if (d === 0 && (ch === ';' || (ch === '\n' && !/^\s*[|&]/.test(rest.slice(i + 1)) && !/[|&=]\s*$/.test(rest.slice(0, i))))) return rest.slice(0, i)
  }
  return rest
}
