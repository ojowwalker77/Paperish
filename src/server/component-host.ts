import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { iconComponents } from '../shared/icons'
import type { ProjectState } from '../shared/types'
import { CACHE_DIR } from './config'
import { css2Spec, googleFonts } from './fonts'
import { frameworkShims } from './framework-shims'
import { readAliases } from './project'

// The component host is a Vite dev server rooted in the linked project, using
// the project's own Vite and config when it has them (so its plugins, aliases
// and Tailwind setup apply). It serves /__paperish/host.html, a blank page that
// renders one component instance at a time on request from the canvas via
// postMessage, and reports its size back. HMR keeps instances live while the
// user edits their code.

export interface HostHandle {
  origin: string
  refresh(): void
  close(): Promise<void>
}

const HOST_BASE_PORT = 29990

const VIRTUAL = '\0paperish-host-entry'

type ViteModule = typeof import('vite')

async function loadVite(root: string): Promise<{ vite: ViteModule; own: boolean }> {
  try {
    const req = createRequire(path.join(root, 'package.json'))
    const entry = req.resolve('vite')

    // SAFETY: the resolved vite entry exports the Vite module namespace.
    return { vite: (await import(pathToFileURL(entry).href)) as ViteModule, own: true }
  } catch {
    return { vite: await import('vite'), own: false }
  }
}

function findViteConfig(root: string): string | false {
  for (const f of [
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
    'vite.config.cts',
  ]) {
    if (fs.existsSync(path.join(root, f))) return path.join(root, f)
  }

  return false
}

export async function startHost(root: string, getState: () => ProjectState): Promise<HostHandle> {
  const { vite } = await loadVite(root)
  const configFile = findViteConfig(root)
  const state = getState()
  const extraPlugins: unknown[] = []
  const alias: { find: RegExp; replacement: string }[] = []
  let define: Record<string, string> | undefined
  let postcss: { plugins: unknown[] } | undefined

  // Without a Vite config (Next.js, CRA, Nuxt…) bring our own framework plugins.
  if (!configFile) {
    const shims = await frameworkShims(vite, root, state.tailwind)
    extraPlugins.push(...shims.plugins)
    define = shims.define
    postcss = shims.postcss

    if (state.frameworks.includes('react'))
      extraPlugins.push((await import('@vitejs/plugin-react')).default())

    if (state.frameworks.includes('vue'))
      extraPlugins.push((await import('@vitejs/plugin-vue')).default())

    for (const [prefix, dir] of Object.entries(readAliases(root))) {
      alias.push({
        find: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`),
        replacement: path.join(root, dir) + '/',
      })
    }
  }

  let server: import('vite').ViteDevServer

  const hostPlugin = {
    name: 'paperish-host',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === '/__paperish/entry.js' || id === 'virtual:paperish-host') return VIRTUAL

      return null
    },
    load(id: string) {
      if (id === VIRTUAL) return entrySource(root, getState())

      return null
    },
    configureServer(s: import('vite').ViteDevServer) {
      const serveHostHtml = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: (err?: Error) => void,
      ) => {
        if (!req.url?.startsWith('/__paperish/host')) return next()

        try {
          const html = await s.transformIndexHtml(req.url, hostHtml(root))
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(html)
        } catch (e) {
          next(e instanceof Error ? e : new Error(String(e)))
        }
      }

      s.middlewares.use((req, res, next) => {
        serveHostHtml(req, res, next).catch(next)
      })
      s.middlewares.use((req, res, next) => {
        serveFonts(req, res, next).catch(next)
      })
    },
  }

  const options = {
    root,
    configFile,
    // Our own cache, never the project's node_modules/.vite: that belongs to the
    // app's dev server (which may be running at the same time), and a repo
    // without node_modules shouldn't grow one because Paperish looked at it.
    cacheDir: path.join(
      CACHE_DIR,
      'vite',
      createHash('sha1').update(root).digest('hex').slice(0, 12),
    ),
    mode: 'development',
    logLevel: 'warn',
    clearScreen: false,
    appType: 'custom',
    // SAFETY: plugin-react/plugin-vue instances are valid Vite plugins.
    plugins: [hostPlugin, ...(extraPlugins as never[])],
    resolve: alias.length ? { alias } : undefined,
    define,
    css: postcss ? { postcss } : undefined,
    server: {
      host: '127.0.0.1',
      port: HOST_BASE_PORT,
      strictPort: false,
      open: false,
      cors: true,
      hmr: { overlay: false },
    },
    optimizeDeps: {
      entries: state.components.map((c) => c.file),
      // SAFETY: filter(Boolean) removes the empty client entry used for legacy React.
      include: [
        ...(state.frameworks.includes('react')
          ? ['react', 'react-dom', reactClientEntry(root)]
          : []),
        ...(state.frameworks.includes('vue') ? ['vue'] : []),
        ...(state.icons ? [state.icons.module] : []),
      ].filter(Boolean) as string[],
    },
  }

  // The runner loader (Vite ≥ 6.1) reads the config without writing a bundled
  // copy into node_modules/.vite-temp; older Vite or configs it can't run use the default.
  try {
    // SAFETY: the runner configLoader is supported by Vite 6.1+ but missing from its bundled types.
    server = await vite.createServer({ ...options, configLoader: 'runner' } as never)
  } catch {
    // SAFETY: options matches createServer's accepted shape; never bridges the UserConfig mismatch.
    server = await vite.createServer(options as never)
  }

  await server.listen()
  const httpServer = server.httpServer
  const address = httpServer ? httpServer.address() : null

  // SAFETY: the host listens on TCP so address() returns an AddressInfo with a port.
  const fallbackPort = (address as { port: number }).port
  const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${fallbackPort}/`

  const origin = url.replace(/\/$/, '')
  console.log(`[paperish] component host for ${path.basename(root)} at ${origin}`)

  return {
    origin,
    refresh() {
      const mod = server.moduleGraph.getModuleById(VIRTUAL)

      if (mod) server.moduleGraph.invalidateModule(mod)
      server.ws.send({ type: 'full-reload' })
    },
    close: () => server.close(),
  }
}

function reactMajor(root: string): number {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules/react-dom/package.json'), 'utf8'),
    )

    return Number(String(pkg.version).split('.')[0]) || 18
  } catch {
    return 18
  }
}

function reactClientEntry(root: string): string {
  return reactMajor(root) >= 18 ? 'react-dom/client' : ''
}

/** <link> tags from the project's index.html (web fonts, global stylesheets). */
function projectHead(root: string): string {
  for (const f of ['index.html', 'public/index.html']) {
    try {
      const html = fs.readFileSync(path.join(root, f), 'utf8')

      return [...html.matchAll(/<link\b[^>]*>/gi)]
        .flatMap((m) => {
          const l = m[0]

          return /rel=["']?(stylesheet|preconnect)/i.test(l) && /https?:\/\//.test(l) ? [l] : []
        })
        .join('\n')
    } catch {}
  }

  return ''
}

/** Google Fonts for families a frame uses but has no faces for, as @nuxt/fonts' default provider would. */
async function serveFonts(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith('/__paperish/fonts.css')) return next()
  const index = await googleFonts()

  const specs = new URL(req.url, 'http://host').searchParams.getAll('family').flatMap((name) => {
    const f = index.get(name.toLowerCase())

    return f ? [css2Spec(f)] : []
  })

  res.setHeader('cache-control', 'no-store')

  if (!specs.length) {
    res.setHeader('content-type', 'text/css; charset=utf-8')

    return void res.end('')
  }

  res.statusCode = 302
  res.setHeader(
    'location',
    `https://fonts.googleapis.com/css2?${specs.map((f) => `family=${f}`).join('&')}&display=swap`,
  )
  res.end()
}

function usesNuxtFonts(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

    return Boolean(pkg.dependencies?.['@nuxt/fonts'] ?? pkg.devDependencies?.['@nuxt/fonts'])
  } catch {
    return false
  }
}

function hostHtml(root: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${projectHead(root)}
    <style>
      html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; min-height: 0 !important; height: auto !important; overflow: hidden !important; }
      :root { color-scheme: normal !important; }
      #pw-root { display: inline-block; vertical-align: top; width: max-content; }
      #pw-root.fill { display: block; width: auto; }
    </style>
  </head>
  <body>
    <div id="pw-root"></div>
    <script type="module" src="/__paperish/entry.js"></script>
  </body>
</html>`
}

function entrySource(root: string, state: ProjectState): string {
  const components = [...state.components, ...iconComponents(state.icons)]
  const specs = new Map(state.components.map((c) => [c.file, `/${c.file}`]))

  if (state.icons) specs.set(state.icons.module, state.icons.module)
  const hasReact = state.frameworks.includes('react')
  const hasVue = state.frameworks.includes('vue')
  const legacyReact = hasReact && reactMajor(root) < 18
  const lines: string[] = []

  // The Tailwind entry plus whatever global CSS the app's entry files import,
  // so components look the way they do in the app.
  const styles = [
    ...new Set([...state.cssEntries.slice(0, 1).map((f) => `/${f}`), ...state.globalCss]),
  ]

  for (const css of styles) lines.push(`import ${JSON.stringify(css)};`)

  if (hasReact) {
    lines.push(`import * as React from 'react';`)
    lines.push(
      legacyReact
        ? `import * as ReactDOM from 'react-dom';`
        : `import { createRoot } from 'react-dom/client';`,
    )
  }

  if (hasVue) lines.push(`import { createApp, h, reactive, markRaw, Suspense } from 'vue';`)
  lines.push(
    `const loaders = {${[...specs].map(([f, spec]) => `${JSON.stringify(f)}: () => import(${JSON.stringify(spec)})`).join(',\n')}};`,
  )
  lines.push(
    `const frameworks = ${JSON.stringify(Object.fromEntries(components.map((c) => [c.id, c.framework])))};`,
  )
  lines.push(RUNTIME_COMMON)

  if (hasReact)
    lines.push(
      legacyReact
        ? RUNTIME_REACT.replace(
            'createRoot(root)',
            '({ render: (el) => ReactDOM.render(el, root) })',
          )
        : RUNTIME_REACT,
    )

  if (hasVue) lines.push(RUNTIME_VUE)
  lines.push(usesNuxtFonts(root) ? RUNTIME_FONTS : 'const loadFonts = async () => {};')
  lines.push(RUNTIME_LISTEN)

  return lines.join('\n')
}

const RUNTIME_COMMON = `
const root = document.getElementById('pw-root');
const iid = new URLSearchParams(location.search).get('iid');
const post = (m) => parent.postMessage({ ...m, iid, __paperish: true }, '*');
let lastSize = '';
// Screen-like components (fixed overlays, 100vh layouts) size themselves from
// the viewport, which is this frame: measured alone they collapse to zero. Give
// anything that rendered visible elements but measures empty a desktop screen to fill.
const SCREEN = { w: 1440, h: 900 };
const visible = () => [...root.querySelectorAll('*')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
const report = () => {
  const r = root.getBoundingClientRect();
  let w = Math.ceil(r.width), hh = Math.ceil(r.height);
  if ((w < 2 || hh < 2) && visible()) {
    if (w < 2) w = SCREEN.w;
    if (hh < 2) hh = SCREEN.h;
  }
  const key = w + 'x' + hh;
  if (key !== lastSize) { lastSize = key; post({ type: 'pw:size', w, h: hh }); }
};
new ResizeObserver(report).observe(root);
const cache = new Map();
async function load(id) {
  if (cache.has(id)) return cache.get(id);
  const [file, name] = [id.slice(0, id.lastIndexOf('#')), id.slice(id.lastIndexOf('#') + 1)];
  const loader = loaders[file];
  if (!loader) throw new Error('Unknown component ' + id);
  const mod = await loader();
  const comp = mod[name];
  if (!comp) throw new Error(name + ' is not exported from ' + file);
  cache.set(id, comp);
  return comp;
}
let failed = false;
const unresolved = new Set();
const fail = (err) => { failed = true; post({ type: 'pw:error', message: String(err && err.message || err) }); };
window.addEventListener('error', (e) => fail(e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));
const styledClasses = () => {
  const out = new Set();
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText) for (const m of r.selectorText.matchAll(/\\.((?:\\\\.|[\\w-])+)/g)) out.add(m[1].replace(/\\\\(.)/g, '$1'));
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} }
  return out;
};
const check = () => {
  const issues = [];
  const els = [...root.querySelectorAll('*')];
  if (!visible() && !root.textContent.trim()) issues.push('Rendered nothing visible');
  if (unresolved.size) issues.push('Unresolved components: ' + [...unresolved].join(', '));
  const used = new Set(els.flatMap((e) => [...e.classList]));
  const styled = styledClasses();
  const bare = [...used].filter((c) => !styled.has(c));
  if (bare.length >= 3 && bare.length > used.size / 2)
    issues.push(bare.length + ' of ' + used.size + ' classes have no CSS (' + bare.slice(0, 4).join(', ') + (bare.length > 4 ? ', …' : '') + '): Tailwind or global stylesheets are not loaded');
  return issues;
};
`

const RUNTIME_REACT = `
class PwBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { fail(error); }
  render() { return this.state.error ? null : this.props.children; }
}
const asyncWrapped = new WeakMap();
const serverish = (C) => {
  if (!C || C.constructor?.name !== 'AsyncFunction') return C;
  if (!asyncWrapped.has(C)) asyncWrapped.set(C, function PwAsync(p) {
    const [el, setEl] = React.useState(null);
    React.useEffect(() => {
      let live = true;
      Promise.resolve(C(p)).then((v) => live && setEl(v), fail);
      return () => { live = false; };
    }, []);
    return el;
  });
  return asyncWrapped.get(C);
};
let reactRoot = null;
const reactProps = (p, key) => {
  const o = { key };
  for (const k in p) o[k === 'class' ? 'className' : k === 'for' ? 'htmlFor' : k === 'tabindex' ? 'tabIndex' : k] = p[k];
  return o;
};
const toReact = (nodes, comps) => nodes.map((n, i) => n.t === 'text' ? n.v
  : React.createElement(n.t === 'el' ? n.tag : (serverish(comps[n.ref]) || 'div'), reactProps(n.props, i), ...toReact(n.children, comps)));
function renderReact(Comp, props, tree, comps, done) {
  reactRoot = reactRoot || createRoot(root);
  const kids = tree.length ? toReact(tree, comps) : (props.children != null ? [props.children] : []);
  const { children, ...rest } = props;
  reactRoot.render(React.createElement(PwBoundary, { key: Math.random() },
    React.createElement(function PwDone() { React.useLayoutEffect(() => { done(); }); return null; }),
    React.createElement(serverish(Comp), reactProps(rest, 'c'), ...kids)));
}
`

const RUNTIME_VUE = `
const vstate = reactive({ comp: null, props: {}, tree: [], comps: {}, n: 0 });
let vueApp = null;
const toVue = (nodes) => nodes.map((n) => n.t === 'text' ? n.v
  : n.t === 'el' ? h(n.tag, n.props, n.children.length ? toVue(n.children) : undefined)
  : h(vstate.comps[n.ref] || 'div', n.props, n.children.length ? { default: () => toVue(n.children) } : undefined));
let vueDone = null;
// Suspense so components with an async setup (top-level await) render too.
function renderVue(Comp, props, tree, comps, done) {
  const { children, ...rest } = props;
  vueDone = done;
  vstate.comp = markRaw(Comp); vstate.props = rest; vstate.comps = markRaw(comps);
  vstate.tree = tree.length ? tree : (children != null ? [{ t: 'text', v: String(children) }] : []);
  vstate.n++;
  if (!vueApp) {
    const resolved = () => { const d = vueDone; vueDone = null; if (d) d(); };
    vueApp = createApp({ render: () => h(Suspense, { onResolve: resolved }, { default: () => vstate.comp ? h(vstate.comp, { ...vstate.props, key: vstate.n }, vstate.tree.length ? { default: () => toVue(vstate.tree) } : undefined) : null }) });
    vueApp.config.errorHandler = fail;
    vueApp.config.warnHandler = (msg) => { const m = /Failed to resolve component: ([\\w.-]+)/.exec(msg); if (m) unresolved.add(m[1]); };
    vueApp.mount(root);
  }
}
`

const RUNTIME_FONTS = `
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
const requested = new Set();
const familyOf = (stack) => stack.split(',')[0].replace(/['"]/g, '').trim();
const loadFonts = async () => {
  const loaded = new Set([...document.fonts].map((f) => familyOf(f.family)));
  const faces = new Set();
  const missing = new Set();
  for (const e of [root, ...root.querySelectorAll('*')]) {
    const cs = getComputedStyle(e);
    const fam = familyOf(cs.fontFamily);
    if (!fam || GENERIC.has(fam.toLowerCase())) continue;
    faces.add(cs.fontStyle + ' ' + cs.fontWeight + ' 16px "' + fam + '"');
    if (!loaded.has(fam) && !requested.has(fam)) missing.add(fam);
  }
  if (missing.size) {
    for (const f of missing) requested.add(f);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/__paperish/fonts.css?' + [...missing].map((f) => 'family=' + encodeURIComponent(f)).join('&');
    await new Promise((r) => { link.onload = link.onerror = r; document.head.append(link); });
  }
  await Promise.race([
    Promise.all([...faces].map((d) => document.fonts.load(d).catch(() => []))),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
};
`

const RUNTIME_LISTEN = `
window.addEventListener('message', async (e) => {
  const d = e.data;
  if (e.source !== parent || !d || d.type !== 'pw:render') return;
  root.className = d.fill ? 'fill' : '';
  failed = false;
  unresolved.clear();
  try {
    const Comp = await load(d.component);
    const comps = {};
    for (const id of d.refs || []) { try { comps[id] = await load(id); } catch {} }
    const done = () => requestAnimationFrame(async () => { await loadFonts(); report(); if (!failed) post({ type: 'pw:rendered', issues: check() }); });
    if (frameworks[d.component] === 'vue') renderVue(Comp, d.props || {}, d.tree || [], comps, done);
    else renderReact(Comp, d.props || {}, d.tree || [], comps, done);
  } catch (err) {
    fail(err);
  }
});
post({ type: 'pw:ready' });
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', () => requestAnimationFrame(report));
`
