import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import {
  McpServer,
  type CallToolRequestParams,
  type CallToolResult,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { applyOps, artboardOf, canHaveChildren, pageOf, subtreeIds } from '../shared/ops'
import { fontFamiliesOf, normalizeStyles } from '../shared/styles'
import {
  TOKEN_TYPES,
  type Doc,
  type JsonValue,
  type LintIssue,
  type LintState,
  type Op,
  type PNode,
  type Styles,
  type StyleValue,
  type Token,
} from '../shared/types'
import { fontFaceCss } from '../shared/fontfaces'
import { canvasResetCss } from '../shared/reset'
import { assetPath, EXT_MIME } from './assets'
import { EXPORTS_DIR, ORIGIN } from './config'
import { engine, type Rect } from './engine'
import { css2Spec, describeGoogle, googleFonts } from './fonts'
import { GUIDES, SERVER_INSTRUCTIONS } from './guide'
import { cloneSubtree, parseHtml } from './html'
import { classTokens, tailwindColorNames, tailwindResolver } from './tailwind'
import { componentsFor, projectFor, tailwindEntryFor } from './project'
import { linkProject } from './commands'
import { compareFiles, openRevision } from './history'
import { checkBoards, lintFile } from './lint'
import { agentNamed, createThread, reply, setStatus } from './comments'
import { propose, waitForPick } from './proposals'
import { runImport } from './tasks'
import { toJSX, toStaticHTML } from './serialize'
import { ARTBOARD_GAP, findPlacement } from './placement'
import { newPage, type OpenFile, type Workspace } from './workspace'

type Result = CallToolResult

const json = <T>(value: T): Result => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
})

const text = (value: string): Result => ({ content: [{ type: 'text', text: value }] })

const fail = (message: string): Result => ({
  isError: true,
  content: [{ type: 'text', text: message }],
})

const fileIdArg = z
  .string()
  .optional()
  .describe(
    'File id to act on. Omit to use the current file of your checkout; in a repo with git worktrees, pass it on every call.',
  )

const cwdArg = z
  .string()
  .optional()
  .describe(
    "Your working directory (absolute). In a git worktree, pass it so this acts on that worktree's design/ folder.",
  )

const whyArg = z
  .string()
  .optional()
  .describe(
    "A few words on why, shown in the user's agent step timeline. Pass the same text on every call of one step.",
  )

const styleRecord = z.record(z.string(), z.union([z.string(), z.number()]))

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const tokenType = z.enum(
  // SAFETY: TOKEN_TYPES is a non-empty tuple of token type names.
  TOKEN_TYPES as [string, ...string[]],
)

/** Per MCP request: the directory the agent's client says it works in (the X-Paperish-Dir header). */
export const mcpRequest = new AsyncLocalStorage<{ dir?: string }>()

interface NodeSummary {
  id: string
  name: string
  component: PNode['type']
  tag: string
  width?: number
  height?: number
  x?: number
  y?: number
  worldX?: number
  worldY?: number
  text?: string
  childCount: number
}

interface NodeInfo extends NodeSummary {
  visible: boolean
  locked: boolean
  parentId: string | null
  artboard: { id: string; name: string } | null
  childIds: string[]
  styles: Styles
  src?: string
}

interface ComponentPropSummary {
  name: string
  type: string | undefined
  required?: boolean
  default?: string
}

interface BasicFileInfo {
  id: string
  name: string
  path: string
  readOnly?: string
}

interface TokenUpdateResult {
  name: string
  result: string
  newName?: string
}

/** The checkout calls without a fileId act on, per request (shared by the file tools below). */
async function layout(f: OpenFile, ids: string[]): Promise<Record<string, Rect>> {
  const byPage = new Map<string, string[]>()

  for (const id of ids) {
    const p = pageOf(f.doc, id)?.id ?? f.pageId
    byPage.set(p, [...(byPage.get(p) ?? []), id])
  }

  const out: Record<string, Rect> = {}

  for (const [pageId, list] of byPage) Object.assign(out, await engine.layout(f, list, pageId))

  return out
}

function summary(_f: OpenFile, n: PNode, r?: Rect): NodeSummary {
  const out: NodeSummary = {
    id: n.id,
    name: n.name,
    component: n.type,
    tag: n.tag,
    childCount: n.children.length,
  }

  if (r) {
    out.width = round(r.width)
    out.height = round(r.height)
    out.x = round(r.x)
    out.y = round(r.y)
    out.worldX = round(r.worldX)
    out.worldY = round(r.worldY)
  }

  if (n.type === 'Text') out.text = truncate(n.text ?? '', 200)

  return out
}

function placement(f: OpenFile, _width: number) {
  return findPlacement(f)
}

function nodeInfo(f: OpenFile, n: PNode, r?: Rect): NodeInfo {
  const ab = artboardOf(f.doc.nodes, n.id)

  const info: NodeInfo = {
    ...summary(f, n, r),
    visible: !n.hidden,
    locked: !!n.locked,
    parentId: n.parent && f.doc.nodes[n.parent]?.type === 'Root' ? 'root' : n.parent,
    artboard: ab ? { id: ab.id, name: ab.name } : null,
    childIds: n.children,
    styles: n.styles,
  }

  if (n.type === 'Text') info.text = n.text

  if (n.type === 'Image') info.src = n.src

  return info
}

function treeLines(
  f: OpenFile,
  rootId: string,
  rects: Record<string, Rect>,
  maxDepth: number,
  limit = 400,
): string[] {
  const lines: string[] = []

  const walk = (id: string, depth: number) => {
    if (lines.length >= limit) return
    const n = f.doc.nodes[id]

    if (!n) return
    const r = rects[id]
    const size = r ? ` ${round(r.width)}×${round(r.height)}` : ''

    const txt =
      n.type === 'Text' && n.text && n.text !== n.name
        ? ` "${truncate(n.text.replace(/\n/g, '⏎'), 60)}"`
        : ''

    const flags = `${n.hidden ? ' [hidden]' : ''}${n.locked ? ' [locked]' : ''}${layoutHint(n.styles)}`
    lines.push(
      `${'  '.repeat(depth)}${n.type} "${truncate(n.name, 50)}" (${n.id})${size}${txt}${flags}`,
    )

    if (depth >= maxDepth) {
      if (n.children.length)
        lines.push(
          `${'  '.repeat(depth + 1)}… ${n.children.length} children (${countDesc(f.doc, id)} descendants)`,
        )

      return
    }

    for (const c of n.children) walk(c, depth + 1)
  }

  walk(rootId, 0)

  if (lines.length >= limit) lines.push('… truncated; request a deeper node or lower depth')

  return lines
}

async function overflowWarnings(f: OpenFile, artboardIds: string[]): Promise<string[]> {
  if (!artboardIds.length) return []

  const res = await engine.call<Record<string, { x: number; y: number }>>(f, 'overflow', {
    ids: artboardIds,
  })

  const out: string[] = []

  for (const [id, o] of Object.entries(res)) {
    const n = f.doc.nodes[id]

    if (o.y > 1)
      out.push(
        `Content overflows artboard "${n?.name}" vertically by ${Math.round(o.y)}px and is clipped. Consider update_styles height:"fit-content".`,
      )

    if (o.x > 1)
      out.push(`Content overflows artboard "${n?.name}" horizontally by ${Math.round(o.x)}px.`)
  }

  return out
}

async function designNotes(f: OpenFile, artboardIds: string[]): Promise<string[]> {
  return (await checkBoards(f, artboardIds)).map(
    (i) =>
      `Design check on "${i.artboard}": ${i.title.toLowerCase()}, ${i.detail}${i.fix ? ' (lint_design fix:true snaps it)' : ''}.`,
  )
}

/** Real components under these nodes that failed to render, rendered blank or unstyled. */
async function componentWarnings(f: OpenFile, ids: string[], pageId?: string): Promise<string[]> {
  if (!f.doc.project || !ids.length) return []
  const res = await engine.call<Record<string, string>>(f, 'components', { ids }, pageId)

  return Object.entries(res).map(
    ([id, problem]) =>
      `Component ${f.doc.nodes[id]?.name ?? id} (${id}) did not render cleanly: ${problem}`,
  )
}

function componentSummary(c: import('../shared/types').ComponentInfo) {
  return {
    name: c.name,
    framework: c.framework,
    import: `${c.export === 'default' ? c.name : `{ ${c.export} }`} from '${c.importPath}'`,
    children: c.slot,
    props: c.props.map((p) => {
      const prop: ComponentPropSummary = {
        name: p.name,
        type: p.type === 'enum' ? p.options?.map((o) => JSON.stringify(o)).join(' | ') : p.type,
      }

      if (p.required) prop.required = true

      if (p.default !== undefined) prop.default = p.default

      return prop
    }),
  }
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`
}

function isStyleString(v: StyleValue): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

/** Runs a tool in the app instead of here: the stdio proxy. */
export type Forward = (name: string, args: CallToolRequestParams['arguments']) => Promise<Result>

/** Tools for one project: the /mcp/<project id> endpoint, or the stdio proxy's tools when `forward` is given. */
export function createMcpServer(ws: Workspace, projectId: string, forward?: Forward): McpServer {
  const server = new McpServer(
    { name: 'paperish', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  )

  /** The checkout calls without a fileId act on: `cwd` if given, else the request's directory header (when it's in this project), else the only one. */
  const currentCheckout = (cwd?: string) => {
    if (cwd) return ws.checkoutFor(projectId, cwd)
    const dir = mcpRequest.getStore()?.dir
    const inProject = dir && ws.projects.locateSync(dir)?.project.id === projectId

    return ws.checkoutFor(projectId, inProject ? dir : undefined)
  }

  const resolve = (fileId?: string): OpenFile => {
    const f = fileId ? ws.get(fileId) : ws.fileIn(projectId, currentCheckout())

    if (f.projectId !== projectId) throw new Error(`File "${f.doc.id}" belongs to another project.`)

    return f
  }

  const tool = <S extends { [k: string]: z.ZodTypeAny }>(
    name: string,
    description: string,
    fields: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) => {
    // SAFETY: registerTool's callback type differs from the inferred handler; never bridges the gap.
    server.registerTool(name, { description, inputSchema: z.object(fields) }, (async (
      args: z.infer<z.ZodObject<S>>,
    ) => {
      try {
        return await (forward ? forward(name, args) : handler(args))
      } catch (e) {
        // SAFETY: tool handlers throw Error instances.
        return fail((e as Error).message ?? String(e))
      }
    }) as never)
  }

  // ---------------------------------------------------------------- helpers

  // ---------------------------------------------------------------- files

  tool(
    'list_files',
    "List the design files (the .paperish files in design/) of a checkout of the project, most recently updated first, plus the project's checkouts (main and git worktrees).",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max files to return (default 50).'),
      cwd: cwdArg,
    },
    async ({ limit, cwd }) => {
      const p = ws.project(projectId)
      const checkouts = await ws.projects.checkouts(p, true)
      const checkout = currentCheckout(cwd)

      return json({
        project: { id: p.id, name: p.name, root: p.root },
        checkout: checkouts.find((c) => c.path === checkout) ?? { path: checkout },
        checkouts,
        files: ws
          .listFiles(p.id, checkout)
          .slice(0, limit ?? 50)
          .map(({ projectId: _, checkout: __, ...s }) => s),
      })
    },
  )

  tool(
    'open_file',
    "Open a file (by id, or the absolute path of its .paperish file, e.g. in your git worktree's design/ folder) and make it the target of later calls that omit fileId. Optionally switch page. Returns the same as get_basic_info.",
    {
      fileId: z
        .string()
        .min(1)
        .describe(
          'File id, or the absolute path of a .paperish file in a checkout of the project.',
        ),
      pageId: z
        .string()
        .min(1)
        .optional()
        .describe('Page to switch to. Omit to keep the current page.'),
    },
    async ({ fileId, pageId }) => {
      const f = fileId.trim().endsWith('.paperish')
        ? await ws.openPath(fileId.trim())
        : resolve(fileId)

      if (f.projectId !== projectId) throw new Error(`${f.doc.source} belongs to another project.`)
      ws.setActive(f)

      if (pageId) f.setPage(pageId)

      return json(await basicInfo(f))
    },
  )

  tool(
    'create_file',
    "Create a new file in a checkout's design/ folder (optionally a copy of another) and return its id. Call open_file to start working in it.",
    {
      name: z.string().optional().describe('Display name.'),
      cloneFileId: z.string().optional().describe('File id to copy.'),
      cwd: cwdArg,
    },
    ({ name, cloneFileId, cwd }) => {
      const clone = cloneFileId ? resolve(cloneFileId).doc : undefined
      const f = ws.create(projectId, name, clone, currentCheckout(cwd))

      return json({ fileId: f.doc.id, name: f.doc.name, path: f.doc.source })
    },
  )

  tool(
    'create_page',
    'Create a new page in a file and return its id. Does not switch to it — call open_file with pageId for that.',
    {
      name: z.string().optional().describe('Page name (default "Page N").'),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ name, fileId, why }) => {
      const f = resolve(fileId)
      const { page, root } = newPage(f, name?.trim() || `Page ${f.doc.pages.length + 1}`)
      f.transact([{ t: 'page:add', page, root }], 'agent', 'create_page', { why })

      return json({ pageId: page.id, name: page.name, rootNodeId: root.id })
    },
  )

  // ---------------------------------------------------------------- read

  const basicInfo = async (f: OpenFile) => {
    const root = f.doc.nodes[f.page.rootId]
    const rects = root.children.length ? await engine.layout(f, root.children, f.pageId) : {}
    const fonts = new Set<string>()

    for (const id of subtreeIds(f.doc.nodes, root.id))
      for (const fam of fontFamiliesOf(f.doc.nodes[id].styles.fontFamily)) fonts.add(fam)
    const file: BasicFileInfo = { id: f.doc.id, name: f.doc.name, path: f.doc.source }

    if (f.ref) file.readOnly = `${f.ref.branch} as committed`

    return {
      file,
      checkout: f.checkout,
      project: (({ id, name, root: projectRoot }) => ({ id, name, root: projectRoot }))(
        ws.project(f.projectId),
      ),
      page: { id: f.page.id, name: f.page.name },
      pages: f.doc.pages.map((p) => ({ id: p.id, name: p.name })),
      rootNodeId: root.id,
      nodeCount: subtreeIds(f.doc.nodes, root.id).length - 1,
      artboards: root.children.map((id) => {
        const n = f.doc.nodes[id]
        const r = rects[id]

        return {
          id,
          name: n.name,
          component: n.type,
          width: r ? round(r.width) : undefined,
          height: r ? round(r.height) : undefined,
          worldX: r ? round(r.worldX) : undefined,
          worldY: r ? round(r.worldY) : undefined,
          childCount: n.children.length,
        }
      }),
      fonts: [...fonts],
      tokens: f.doc.tokens.map((t) => `${t.name}: ${t.value}`),
      selection: f.selection.pageId === f.pageId ? f.selection.ids : [],
      openComments: f.doc.comments.filter((t) => t.status === 'open').length,
      codebase: (() => {
        const p = projectFor(f.doc)

        if (!p) return f.doc.project ? { root: f.doc.project.root, status: 'starting' } : null

        return {
          name: p.name,
          root: p.root,
          status: p.status,
          error: p.error,
          frameworks: p.frameworks,
          tailwind: p.tailwind,
          components: p.components.length,
        }
      })(),
      repo: f.repo
        ? {
            path: f.repo.state.path,
            branch: f.repo.state.branch,
            git: f.repo.state.state,
            problem: f.repo.state.problem,
          }
        : null,
      working: [...f.working],
      notes: ['worldX/worldY are canvas positions; x/y are relative to the parent.'],
    }
  }

  tool(
    'get_basic_info',
    "Essential context for the current file and page: pages, artboards with sizes and canvas positions, node count, fonts in use, design tokens, and the user's selection. Call this first.",
    { fileId: fileIdArg },
    async ({ fileId }) => json(await basicInfo(resolve(fileId))),
  )

  tool(
    'get_selection',
    'The nodes the user currently has selected in the editor, with size, component type and containing artboard.',
    { fileId: fileIdArg },
    async ({ fileId }) => {
      const f = resolve(fileId)
      const ids = f.selection.ids.filter((id) => f.doc.nodes[id])

      if (!ids.length) return json({ selection: [], note: 'Nothing is selected in the editor.' })
      const rects = await layout(f, ids)

      return json({ selection: ids.map((id) => nodeInfo(f, f.doc.nodes[id], rects[id])) })
    },
  )

  tool(
    'get_node_info',
    'Details for one node: size, canvas (worldX/worldY) and parent-relative (x/y) position, visibility, lock state, parent, children, authored styles and text.',
    { nodeId: z.string().describe('Node id.'), fileId: fileIdArg },
    async ({ nodeId, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)
      const rects = n.type === 'Root' ? {} : await layout(f, [n.id])

      return json(nodeInfo(f, n, rects[n.id]))
    },
  )

  tool(
    'get_children',
    'Direct children of a node with ids, names, component types, child counts, sizes and positions.',
    {
      nodeId: z.string().describe('Parent node id ("root" for the page root).'),
      fileId: fileIdArg,
    },
    async ({ nodeId, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)
      const rects = n.children.length ? await layout(f, n.children) : {}

      return json({
        parentId: n.id,
        children: n.children.map((c) => summary(f, f.doc.nodes[c], rects[c])),
      })
    },
  )

  tool(
    'get_tree_summary',
    'Compact indented outline of a subtree: component type, name, id and size per node. Much cheaper than get_jsx; use it to orient.',
    {
      nodeId: z.string().describe('Root of the summary ("root" for the whole page).'),
      depth: z.number().min(0).max(10).optional().describe('Max depth (default 3, max 10).'),
      fileId: fileIdArg,
    },
    async ({ nodeId, depth, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)
      const ids = subtreeIds(f.doc.nodes, n.id).filter((id) => f.doc.nodes[id].type !== 'Root')
      const rects = ids.length ? await layout(f, ids) : {}

      return text(treeLines(f, n.id, rects, depth ?? 3).join('\n'))
    },
  )

  tool(
    'get_screenshot',
    'Screenshot a node as rendered by Chromium. 1x is enough for layout checks; use scale 2 for small text. Large nodes are scaled down to fit image limits — screenshot a child for more detail.',
    {
      nodeId: z.string().describe('Node to capture.'),
      scale: z.number().min(0.1).max(4).optional().describe('Render scale (default 1).'),
      transparent: z
        .boolean()
        .optional()
        .describe('PNG with transparent page background instead of JPEG.'),
      fileId: fileIdArg,
    },
    async ({ nodeId, scale, transparent, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)

      if (n.type === 'Root') return fail('Screenshot an artboard or node, not the page root.')
      const pageId = pageOf(f.doc, n.id)?.id
      const shot = await engine.screenshot(f, n.id, { scale, transparent }, pageId)
      const notes = await componentWarnings(f, [n.id], pageId)

      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          {
            type: 'text',
            text: `${n.name} — ${shot.width}×${shot.height}px at ${round(shot.scale, 2)}x${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
          },
        ],
      }
    },
  )

  tool(
    'get_jsx',
    'JSX for a node and its descendants, styled with Tailwind classes (default, arbitrary values where needed) or inline styles.',
    {
      nodeId: z.string().describe('Node to export.'),
      format: z
        .enum(['tailwind', 'inline-styles'])
        .optional()
        .describe('"tailwind" (default) or "inline-styles".'),
      fileId: fileIdArg,
    },
    ({ nodeId, format, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)

      return text(
        toJSX(
          f.doc.nodes,
          n.id,
          format ?? 'tailwind',
          componentsFor(f.doc),
          tailwindColorNames(tailwindEntryFor(f.doc)),
        ),
      )
    },
  )

  tool(
    'get_computed_styles',
    'Computed CSS (from the live renderer) for one or more nodes, as camelCase properties. Defaults are omitted.',
    { nodeIds: z.array(z.string()).describe('Node ids.'), fileId: fileIdArg },
    async ({ nodeIds, fileId }) => {
      const f = resolve(fileId)
      const ids = nodeIds.map((id) => f.node(id).id)

      return json(await engine.call(f, 'computed', { ids }, pageOf(f.doc, ids[0])?.id))
    },
  )

  tool(
    'get_fill_image',
    'Image data (JPEG/PNG, downscaled if large) for an Image node or a node with a background-image. Includes the original URL.',
    { nodeId: z.string().describe('Node with an image.'), fileId: fileIdArg },
    async ({ nodeId, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)

      const url =
        n.type === 'Image'
          ? n.src
          : String(n.styles.backgroundImage ?? n.styles.background ?? '').match(
              /url\(\s*['"]?(.*?)['"]?\s*\)/,
            )?.[1]

      if (!url) return text(`Node "${n.name}" has no image fill.`)
      const img = await loadImage(url)

      if (img.bytes.length > 3_500_000 || !/^image\/(png|jpeg|webp|gif)$/.test(img.mime)) {
        const dataUrl = `data:${img.mime};base64,${img.bytes.toString('base64')}`

        const small = await engine.call<{ data: string; width: number; height: number }>(
          f,
          'downscale',
          { src: dataUrl, max: 1568 },
        )

        return {
          content: [
            { type: 'image', data: small.data, mimeType: 'image/jpeg' },
            { type: 'text', text: JSON.stringify({ url, resized: [small.width, small.height] }) },
          ],
        }
      }

      return {
        content: [
          { type: 'image', data: img.bytes.toString('base64'), mimeType: img.mime },
          { type: 'text', text: JSON.stringify({ url }) },
        ],
      }
    },
  )

  tool(
    'find_nodes',
    'Find nodes by computed style and/or text. `filters` ({styleName, styleValue}) are AND-ed; "*" wildcards work in both. Colors match by equivalence and literal colors also find token-bound usages. `textValue` matches Text content case-insensitively with "*" wildcards. Scope with nodeId.',
    {
      nodeId: z.string().optional().describe('Search only this subtree.'),
      textValue: z.string().optional().describe('Text content pattern, e.g. "Get *".'),
      filters: z
        .array(z.object({ styleName: z.string().optional(), styleValue: z.string().optional() }))
        .min(1)
        .optional()
        .describe('Style matchers, all must match.'),
      fileId: fileIdArg,
    },
    async ({ nodeId, textValue, filters, fileId }) => {
      const f = resolve(fileId)

      if (!textValue && !filters?.length) return fail('Pass textValue, filters, or both.')
      const scope = nodeId ? f.node(nodeId).id : f.page.rootId

      const res = await engine.call<unknown[]>(
        f,
        'find',
        { scope, textValue, filters },
        pageOf(f.doc, scope)?.id,
      )

      return json({ count: res.length, results: res })
    },
  )

  tool(
    'get_font_family_info',
    'Check whether font families are available (installed locally or on Google Fonts) and list their weights and styles. Call before choosing typography.',
    { familyNames: z.array(z.string()).describe('Family names, e.g. ["Inter", "Fraunces"].') },
    async ({ familyNames }) => {
      const google = await googleFonts()
      const f = resolve()

      // SAFETY: fontCheck resolves a family->installed map; the fallback is an empty map.
      const local = await engine
        .call<Record<string, boolean>>(f, 'fontCheck', { families: familyNames })
        .catch(() => ({}) as Record<string, boolean>)

      return json(
        familyNames.map((name) => {
          const g = google.get(name.toLowerCase())

          if (g) return { ...describeGoogle(g), available: true, installedLocally: !!local[name] }

          if (local[name])
            return {
              family: name,
              available: true,
              source: 'local',
              weights: 'unknown (installed on this machine)',
            }

          return { family: name, available: false, note: 'Not found locally or on Google Fonts.' }
        }),
      )
    },
  )

  tool(
    'get_guide',
    `Read a guide. Topics:\n${Object.entries(GUIDES)
      .map(([k, v]) => `"${k}" — ${v.summary}`)
      .join('\n')}`,
    { topic: z.string().describe('Guide topic.') },
    ({ topic }) => {
      const g = GUIDES[topic]

      if (!g) return fail(`Unknown topic "${topic}". Available: ${Object.keys(GUIDES).join(', ')}`)

      return text(g.body)
    },
  )

  // ---------------------------------------------------------------- comments

  tool(
    'list_comment_threads',
    'List comment threads (open by default) pinned to nodes in the file, as compact summaries.',
    {
      pageId: z.string().optional(),
      currentPageOnly: z.boolean().optional(),
      nodeId: z.string().optional(),
      status: z.enum(['open', 'resolved', 'all']).optional(),
      search: z.string().optional(),
      participantUserId: z.string().optional(),
      threadAuthorUserId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      fileId: fileIdArg,
    },
    (a) => {
      const f = resolve(a.fileId)
      const status = a.status ?? 'open'
      const pageId = a.pageId ?? (a.currentPageOnly ? f.pageId : undefined)
      const q = a.search?.toLowerCase()

      const threads = f.doc.comments.filter(
        (t) =>
          (status === 'all' || t.status === status) &&
          (!pageId || t.pageId === pageId) &&
          (!a.nodeId || t.nodeId === a.nodeId) &&
          (!a.threadAuthorUserId || t.messages[0]?.authorId === a.threadAuthorUserId) &&
          (!a.participantUserId || t.messages.some((m) => m.authorId === a.participantUserId)) &&
          (!q ||
            t.messages.some(
              (m) => m.text.toLowerCase().includes(q) || m.authorName.toLowerCase().includes(q),
            )),
      )

      const offset = a.offset ?? 0

      return json({
        total: threads.length,
        threads: threads.slice(offset, offset + (a.limit ?? 50)).map((t) => ({
          id: t.id,
          status: t.status,
          pageId: t.pageId,
          nodeId: t.nodeId,
          author: t.messages[0]?.authorName,
          firstMessage: truncate(t.messages[0]?.text ?? '', 200),
          replies: t.messages.length - 1,
          createdAt: t.createdAt,
        })),
      })
    },
  )

  tool(
    'get_comment_thread',
    'Full comment thread: status, all messages, page and pinned node.',
    { commentThreadId: z.string().min(1), fileId: fileIdArg },
    ({ commentThreadId, fileId }) => {
      const f = resolve(fileId)
      const t = f.doc.comments.find((c) => c.id === commentThreadId)

      if (!t) return fail(`Comment thread "${commentThreadId}" not found.`)
      const n = t.nodeId ? f.doc.nodes[t.nodeId] : undefined

      return json({ ...t, node: n ? { id: n.id, name: n.name, component: n.type } : null })
    },
  )

  tool(
    'list_comment_thread_authors',
    'Everyone who started or replied to a comment thread, with message counts.',
    { pageId: z.string().optional(), fileId: fileIdArg },
    ({ pageId, fileId }) => {
      const f = resolve(fileId)

      const authors = new Map<
        string,
        { userId: string; name: string; threads: number; messages: number; lastActivity: string }
      >()

      for (const t of f.doc.comments) {
        if (pageId && t.pageId !== pageId) continue
        t.messages.forEach((m, i) => {
          const a = authors.get(m.authorId) ?? {
            userId: m.authorId,
            name: m.authorName,
            threads: 0,
            messages: 0,
            lastActivity: m.createdAt,
          }

          a.messages++

          if (i === 0) a.threads++

          if (m.createdAt > a.lastActivity) a.lastActivity = m.createdAt
          authors.set(m.authorId, a)
        })
      }

      return json([...authors.values()])
    },
  )

  tool(
    'set_comment_thread_status',
    'Mark a comment thread "resolved" once its feedback is addressed, or reopen it.',
    { commentThreadId: z.string().min(1), status: z.enum(['open', 'resolved']), fileId: fileIdArg },
    ({ commentThreadId, status, fileId }) => {
      const f = resolve(fileId)

      setStatus(f, commentThreadId, status, 'agent')

      return json({ commentThreadId, status })
    },
  )

  const authorName = z
    .string()
    .max(40)
    .optional()
    .describe('Your name as the user should see it, e.g. "Claude". Defaults to "Agent".')

  tool(
    'reply_to_comment_thread',
    'Reply in a comment thread, e.g. to say what you changed for it or to ask a question. After addressing a thread, reply with what changed, then set_comment_thread_status to "resolved".',
    { commentThreadId: z.string().min(1), text: z.string().min(1), authorName, fileId: fileIdArg },
    ({ commentThreadId, text: body, authorName: name, fileId }) => {
      const f = resolve(fileId)
      const m = reply(f, agentNamed(name), commentThreadId, body, 'agent')

      return json({ commentThreadId, messageId: m.id })
    },
  )

  tool(
    'create_comment_thread',
    'Leave a comment pinned to a node, for something the user should look at or decide later (a question, a trade-off you made, a follow-up). Not for choices you need answered now: use propose_options for those.',
    {
      nodeId: z.string().min(1),
      text: z.string().min(1),
      x: z.number().optional().describe("Pin position in px from the node's top-left (default 0)."),
      y: z.number().optional(),
      authorName,
      fileId: fileIdArg,
    },
    ({ nodeId, text: body, x, y, authorName: name, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)
      const page = pageOf(f.doc, n.id)

      if (!page) return fail(`Node "${nodeId}" isn't on a page.`)

      const t = createThread(
        f,
        agentNamed(name),
        { pageId: page.id, nodeId: n.id, x: x ?? 0, y: y ?? 0 },
        body,
        'agent',
      )

      return json({ commentThreadId: t.id, pageId: t.pageId, nodeId: t.nodeId })
    },
  )

  // ---------------------------------------------------------------- export

  const exportSetting = z.object({
    format: z.enum(['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webp']),
    scale: z
      .string()
      .regex(/^\d+(\.\d+)?(x|w|h|p)$/)
      .describe('"2x", "720p" (shortest side), "512w", "512h".'),
    durationSeconds: z.number().min(1).max(300).optional(),
    pdfQuality: z.enum(['low', 'medium', 'high']).optional(),
    pdfResampling: z.enum(['detailed', 'basic']).optional(),
  })

  tool(
    'export',
    'Export nodes to image files (png, jpg, webp, pdf, svg). Files are written to the Paperish exports folder; paths and URLs are returned.',
    {
      type: z.enum(['image', 'video']).optional(),
      nodes: z
        .union([z.literal('nodes-with-exports-only'), z.record(z.string(), z.array(exportSetting))])
        .describe('Map of nodeId -> export settings.'),
      fileId: fileIdArg,
    },
    async ({ type, nodes, fileId }) => {
      const f = resolve(fileId)

      if (type === 'video') return fail('Video export is not supported yet.')

      if (nodes === 'nodes-with-exports-only')
        return fail(
          'No nodes have saved export settings. Pass a map of nodeId -> [{format, scale}].',
        )
      fs.mkdirSync(EXPORTS_DIR, { recursive: true })

      const files: {
        nodeId: string
        format: string
        path: string
        url: string
        width?: number
        height?: number
      }[] = []

      const errors: string[] = []

      for (const [nodeId, settings] of Object.entries(nodes)) {
        const n = f.node(nodeId)
        const pageId = pageOf(f.doc, n.id)?.id
        const r = (await engine.layout(f, [n.id], pageId))[n.id]

        for (const s of settings) {
          const base = `${slug(n.name)}-${n.id}@${s.scale}`

          try {
            if (s.format === 'pdf') {
              const buf = await engine.pdf(
                [{ html: toStaticHTML(f.doc.nodes, n.id, r), width: r.width, height: r.height }],
                await fontHead(f.doc),
              )

              files.push(writeExport(`${base}.pdf`, buf, n.id, s.format))
            } else if (s.format === 'svg') {
              const html = toStaticHTML(f.doc.nodes, n.id, r)
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${canvasResetCss('div')}</style>${html}</div></foreignObject></svg>`
              files.push(writeExport(`${base}.svg`, Buffer.from(svg), n.id, s.format))
            } else if (s.format === 'png' || s.format === 'jpg' || s.format === 'webp') {
              const scale = resolveScale(s.scale, r)

              const shot = await engine.screenshot(
                f,
                n.id,
                { scale, format: s.format === 'jpg' ? 'jpeg' : s.format, quality: 92, cap: false },
                pageId,
              )

              files.push({
                ...writeExport(
                  `${base}.${s.format}`,
                  Buffer.from(shot.data, 'base64'),
                  n.id,
                  s.format,
                ),
                width: shot.width,
                height: shot.height,
              })
            } else errors.push(`${n.name}: ${s.format} export is not supported yet.`)
          } catch (e) {
            // SAFETY: engine.pdf, engine.screenshot and toStaticHTML throw Error instances.
            errors.push(`${n.name} (${s.format}): ${(e as Error).message}`)
          }
        }
      }

      return json({ files, errors: errors.length ? errors : undefined })
    },
  )

  tool(
    'export_combined_pdf',
    'Export several nodes into one PDF, one page per node, ordered top-to-bottom then left-to-right on the canvas.',
    { nodeIds: z.array(z.string()).min(1), fileId: fileIdArg },
    async ({ nodeIds, fileId }) => {
      const f = resolve(fileId)
      const ids = nodeIds.map((id) => f.node(id).id)
      const rects = await layout(f, ids)
      ids.sort((a, b) => rects[a].worldY - rects[b].worldY || rects[a].worldX - rects[b].worldX)

      const buf = await engine.pdf(
        ids.map((id) => ({
          html: toStaticHTML(f.doc.nodes, id, rects[id]),
          width: rects[id].width,
          height: rects[id].height,
        })),
        await fontHead(f.doc),
      )

      fs.mkdirSync(EXPORTS_DIR, { recursive: true })

      return json(writeExport(`${slug(f.doc.name)}-${Date.now()}.pdf`, buf, ids.join(','), 'pdf'))
    },
  )

  // ---------------------------------------------------------------- codebase

  tool(
    'link_project',
    `Link the user's codebase (React or Vue, with or without Tailwind) to this file. Paperish discovers its components and props and runs them on the canvas with the project's own Vite config, so designs use the real components. Afterwards: place components in write_html with their PascalCase name as the tag, e.g. <Button variant="outline">Save</Button>; the project's Tailwind theme is used for class="..." too. Pass an absolute path to the folder containing package.json.`,
    {
      path: z
        .string()
        .min(1)
        .describe('Absolute path of the project folder (contains package.json).'),
      fileId: fileIdArg,
    },
    async ({ path: root, fileId }) => {
      const f = resolve(fileId)
      const p = await linkProject(f, root, 'agent')

      if (!p) return text('Unlinked.')

      return json({
        name: p.name,
        root: p.root,
        status: p.status,
        error: p.error,
        frameworks: p.frameworks,
        tailwind: p.tailwind,
        cssEntries: p.cssEntries,
        globalCss: p.globalCss,
        components: p.components.map(
          (c) => `${c.name}${c.props.length ? ` (${c.props.map((x) => x.name).join(', ')})` : ''}`,
        ),
        next: 'Call list_components for props, then write_html with <ComponentName prop="value">children</ComponentName>.',
      })
    },
  )

  tool(
    'list_components',
    'Components available from the linked codebase, with their props (types, options, defaults), import path and whether they take children. Use the name as a tag in write_html.',
    {
      query: z.string().optional().describe('Filter by name (case-insensitive substring).'),
      fileId: fileIdArg,
    },
    ({ query, fileId }) => {
      const f = resolve(fileId)
      const p = projectFor(f.doc)

      if (!p)
        return fail(
          f.doc.project
            ? 'The linked codebase is still starting; try again in a moment.'
            : 'No codebase linked. Use link_project first.',
        )
      const q = query?.toLowerCase()

      const list = p.components.filter(
        (c) => !q || c.name.toLowerCase().includes(q) || c.file.toLowerCase().includes(q),
      )

      return json({
        status: p.status,
        error: p.error,
        count: list.length,
        components: list.map(componentSummary),
      })
    },
  )

  tool(
    'set_component_props',
    'Update props (and/or children markup) of Component nodes. Props merge into the existing ones; pass null to remove a prop.',
    {
      updates: z
        .array(
          z.object({
            nodeId: z.string(),
            props: z.record(z.string(), jsonValueSchema).optional(),
            content: z
              .string()
              .optional()
              .describe('Children markup, e.g. "Save changes" or "<CardTitle>Plan</CardTitle>".'),
          }),
        )
        .min(1),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ updates, fileId, why }) => {
      const f = resolve(fileId)
      const ops: Op[] = []

      for (const u of updates) {
        const n = f.node(u.nodeId)

        if (n.type !== 'Component') throw new Error(`"${n.name}" is a ${n.type}, not a Component.`)
        const patch: import('../shared/types').NodePatch = {}

        if (u.props) {
          const next = { ...n.props }

          for (const [k, v] of Object.entries(u.props)) {
            if (v === null) delete next[k]
            else next[k] = v
          }

          patch.props = next
        }

        if (u.content !== undefined) patch.content = u.content || null
        ops.push({ t: 'patch', id: n.id, patch })
      }

      f.transact(ops, 'agent', 'set_component_props', { why })

      const notes = await componentWarnings(
        f,
        updates.map((u) => u.nodeId),
        pageOf(f.doc, updates[0].nodeId)?.id,
      )

      return json({ updated: ops.length, notes: notes.length ? notes : undefined })
    },
  )

  // ---------------------------------------------------------------- import

  tool(
    'import_url',
    `Import a live web page as editable design layers: Paperish loads the URL in a hidden browser window, walks the rendered DOM and rebuilds it as Frame/Text/Image/SVG nodes with real CSS. Authored sizing (%, max-width, fr, auto margins) is recovered from the site's stylesheets so the layout stays fluid; images and web fonts are downloaded locally. Creates a new artboard. Use it to start from an existing site, redesign a page, or match a reference.`,
    {
      url: z.string().min(1).describe('Page URL (https:// is assumed if missing).'),
      width: z
        .number()
        .int()
        .min(320)
        .max(2560)
        .optional()
        .describe('Viewport width to capture at (default 1440; 390 for mobile).'),
      name: z.string().optional().describe('Artboard name (defaults to the page title).'),
      fileId: fileIdArg,
    },
    async ({ url, width, name, fileId }) => {
      const f = resolve(fileId)
      const { rootId, result } = await runImport(f, { url, width, name }, 'agent')
      const ids = subtreeIds(f.doc.nodes, rootId).filter((id) => f.doc.nodes[id].type !== 'Root')
      const rects = await layout(f, ids.slice(0, 400))
      const s = result.stats

      return text(
        `Imported "${f.doc.nodes[rootId].name}" as artboard ${rootId}: ${s.layers} layers, ${s.images} images${s.imagesFailed ? ` (${s.imagesFailed} left remote)` : ''}, ${s.fonts} font files, ${Math.round(s.ms / 100) / 10}s.\n\n${treeLines(f, rootId, rects, 2, 80).join('\n')}${result.warnings.length ? `\n\nNotes:\n- ${result.warnings.join('\n- ')}` : ''}`,
      )
    },
  )

  // ---------------------------------------------------------------- repo

  tool(
    'compare_revision',
    `What changed in a repo-backed file since a git revision, artboard by artboard: added, removed, changed (with a content-match score, the largest differing regions, and a design | before | heatmap image) or unchanged. Use it to review your own edits against HEAD, or to summarize a branch's design changes against main for a PR.`,
    {
      revision: z
        .string()
        .optional()
        .describe(
          'Git revision to compare against: "HEAD" (default, i.e. uncommitted changes), "main", "HEAD~3", a sha.',
        ),
      images: z
        .number()
        .int()
        .min(0)
        .max(8)
        .optional()
        .describe('How many changed artboards get an image (default 4, largest changes first).'),
      fileId: fileIdArg,
    },
    async ({ revision, images, fileId }) => {
      const f = resolve(fileId)
      const rev = revision ?? 'HEAD'
      const { file: old, sha } = await openRevision(ws, f, rev)
      const { changes, notes } = await compareFiles(old, f, { agent: true })

      const lines = [
        `${f.doc.name} vs ${rev} (${sha.slice(0, 7)})${old ? '' : ': the file did not exist there, so everything is new'}.`,
      ]

      const counts = (['changed', 'added', 'removed', 'unchanged'] as const).map(
        (st) => `${changes.filter((c) => c.status === st).length} ${st}`,
      )

      lines.push(counts.join(' · '), '')

      for (const c of changes) {
        if (c.status === 'unchanged') {
          if (c.moved) lines.push(`- ${c.name} (${c.id}): moved on the canvas only`)
          continue
        }

        const score = c.contentScore !== undefined ? ` — content match ${pct(c.contentScore)}` : ''
        lines.push(`- ${c.status.toUpperCase()} ${c.name} (${c.id}) on ${c.pageName}${score}`)

        for (const r of c.regions?.slice(0, 3) ?? [])
          lines.push(`    region ${r.x},${r.y} ${r.width}×${r.height}`)
      }

      if (notes.length) lines.push('', ...notes.map((x) => `Note: ${x}`))

      const shown = changes
        .filter((c) => c.composite)
        .toSorted((a, b) => (a.contentScore ?? 1) - (b.contentScore ?? 1))
        .slice(0, images ?? 4)

      if (shown.length)
        lines.push(
          '',
          `Images (${shown.map((c) => c.name).join(', ')}): now | ${rev} | heatmap (red = different).`,
        )

      return {
        content: [
          { type: 'text', text: lines.join('\n') },
          ...shown.map((c) => ({
            type: 'image' as const,
            data: c.composite!,
            mimeType: 'image/jpeg',
          })),
        ],
      }
    },
  )

  // ---------------------------------------------------------------- visual diff

  tool(
    'visual_diff',
    `Measure how closely a design matches a reference, pixel by pixel. Compare a node against a live URL (captured at the node's width), a local image file, or another node (before/after). Returns a similarity score, one image with design | reference | heatmap side by side (red = different, blue boxes = biggest regions), and the largest differing regions mapped to the layers underneath — so you can fix specific layers and re-run until the score is where it should be.`,
    {
      nodeId: z.string().describe('The design node to check.'),
      reference: z
        .object({
          url: z
            .string()
            .optional()
            .describe('Live page to compare against (captured full-page at the node width).'),
          imagePath: z
            .string()
            .optional()
            .describe('Absolute path of a PNG/JPEG/WebP reference image.'),
          nodeId: z
            .string()
            .optional()
            .describe('Another node on the canvas (e.g. the version before your edits).'),
          revision: z
            .string()
            .optional()
            .describe(
              'A git revision ("HEAD", "main", a sha): the same node as committed there. The file must be saved in a repo.',
            ),
        })
        .describe('Exactly one of url, imagePath, nodeId or revision.'),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Per-pixel color tolerance, 0–1 (default 0.1).'),
      tolerance: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe(
          'Spatial tolerance in px (default 1): a pixel matches if the same colour is within this distance, which ignores anti-aliasing and sub-pixel jitter. 0 = strict.',
        ),
      fit: z
        .enum(['width', 'none'])
        .optional()
        .describe(
          '"width" (default) scales the reference to the design width; "none" compares 1:1 from the top-left.',
        ),
      fileId: fileIdArg,
    },
    async ({ nodeId, reference, threshold, tolerance, fit, fileId }) => {
      const f = resolve(fileId)
      const n = f.node(nodeId)

      const refs = [
        reference.url,
        reference.imagePath,
        reference.nodeId,
        reference.revision,
      ].filter(Boolean)

      if (refs.length !== 1)
        return fail(
          'Pass exactly one of reference.url, reference.imagePath, reference.nodeId or reference.revision.',
        )
      const pageId = pageOf(f.doc, n.id)?.id

      const shot = await engine.screenshot(f, n.id, { scale: 1, format: 'png', cap: false }, pageId)

      let refData: string
      let refLabel: string

      if (reference.revision) {
        const { file: old, sha } = await openRevision(ws, f, reference.revision)

        if (!old) return fail(`The file didn't exist at ${reference.revision}.`)

        if (!old.doc.nodes[n.id])
          return fail(`"${n.name}" didn't exist at ${reference.revision} (${sha.slice(0, 7)}).`)

        const s = await engine.screenshot(
          old,
          n.id,
          { scale: 1, format: 'png', cap: false },
          pageOf(old.doc, n.id)?.id,
        )

        refData = `data:image/png;base64,${s.data}`
        refLabel = `${reference.revision} (${sha.slice(0, 7)})`
      } else if (reference.nodeId) {
        const other = f.node(reference.nodeId)

        const s = await engine.screenshot(
          f,
          other.id,
          { scale: 1, format: 'png', cap: false },
          pageOf(f.doc, other.id)?.id,
        )

        refData = `data:image/png;base64,${s.data}`
        refLabel = `node "${other.name}"`
      } else if (reference.imagePath) {
        const p = reference.imagePath

        if (!fs.existsSync(p)) return fail(`Image not found: ${p}`)
        const ext = path.extname(p).slice(1).toLowerCase()
        const mime = EXT_MIME[ext] ?? 'image/png'
        refData = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
        refLabel = path.basename(p)
      } else {
        const buf = await engine.captureUrl(reference.url!, shot.width)
        refData = `data:image/png;base64,${buf.toString('base64')}`
        refLabel = reference.url!
      }

      const res = await engine.call<{
        compared: { width: number; height: number; from: number }
        design: { width: number; height: number }
        reference: { width: number; height: number; scaledTo: [number, number] }
        shift: number
        diffPixels: number
        score: number
        contentPixels: number
        contentScore: number
        regions: { x: number; y: number; width: number; height: number; pixels: number }[]
        composite: string
      }>(
        f,
        'diff',
        {
          a: `data:image/png;base64,${shot.data}`,
          b: refData,
          threshold: threshold ?? 0.1,
          tolerance: tolerance ?? 1,
          fit: fit ?? 'width',
        },
        pageId,
      )

      // Map regions to the layers they cover.
      const ids = subtreeIds(f.doc.nodes, n.id).slice(0, 3000)
      const rects = await layout(f, ids)
      const origin = rects[n.id]

      const describe = (r: { x: number; y: number; width: number; height: number }) => {
        if (!origin) return ''
        const rx1 = origin.worldX + r.x
        const ry1 = origin.worldY + r.y
        const area = r.width * r.height
        let best: { id: string; size: number } | null = null

        for (const id of ids) {
          if (id === n.id) continue
          const q = rects[id]

          if (!q) continue

          const ix = Math.max(
            0,
            Math.min(rx1 + r.width, q.worldX + q.width) - Math.max(rx1, q.worldX),
          )

          const iy = Math.max(
            0,
            Math.min(ry1 + r.height, q.worldY + q.height) - Math.max(ry1, q.worldY),
          )

          const size = q.width * q.height

          if ((ix * iy) / area >= 0.5 && (!best || size < best.size)) best = { id, size }
        }

        if (!best) return ''
        const chain = [best.id]
        let cur = f.doc.nodes[best.id]?.parent

        while (cur && cur !== n.id && chain.length < 3) {
          chain.unshift(cur)
          cur = f.doc.nodes[cur]?.parent ?? null
        }

        return (
          ' → ' +
          chain
            .map((id) => `${f.doc.nodes[id].type} "${truncate(f.doc.nodes[id].name, 32)}" (${id})`)
            .join(' › ')
        )
      }

      const lines = [
        `Content match ${pct(res.contentScore)} (pixels that aren't background) · overall ${pct(res.score)} — ${res.diffPixels.toLocaleString('en-US')} px differ.`,
        `Design ${res.design.width}×${res.design.height} vs reference ${refLabel} ${res.reference.width}×${res.reference.height}${res.reference.scaledTo[0] !== res.reference.width ? ` (scaled to ${res.reference.scaledTo.join('×')})` : ''}; compared ${res.compared.width}×${res.compared.height}.`,
      ]

      if (res.shift)
        lines.push(
          `Alignment: the design's content sits ${Math.abs(res.shift)}px ${res.shift > 0 ? 'higher' : 'lower'} than the reference; scores are after aligning. Fix the spacing above the first differing region first.`,
        )
      const dh = res.reference.scaledTo[1] - res.shift - res.design.height

      if (Math.abs(dh) > 2)
        lines.push(
          `Heights differ by ${Math.abs(dh)}px: the ${dh > 0 ? 'reference' : 'design'} is taller, so the extra part wasn't compared.`,
        )

      if (res.regions.length) {
        lines.push('', 'Largest differences (x, y relative to the node):')
        res.regions.forEach((r, i) =>
          lines.push(
            `${i + 1}. ${r.x},${r.y} ${r.width}×${r.height} (${pct(r.pixels / Math.max(1, res.diffPixels))} of diff)${describe(r)}`,
          ),
        )
      }

      lines.push(
        '',
        'Image: design | reference | heatmap (red = different, blue boxes = regions above).',
      )

      return {
        content: [
          { type: 'image', data: res.composite, mimeType: 'image/jpeg' },
          { type: 'text', text: lines.join('\n') },
        ],
      }
    },
  )

  // ---------------------------------------------------------------- write

  tool(
    'write_html',
    `Parse HTML into design layers, live on the canvas.
Write incrementally: one visual group per call (a header, one list row, a card body) so the user sees progress.
Reuse existing layers with <x-paper-clone node-id="ID" style="overrides" /> instead of rewriting them.

HTML/CSS rules:
- Inline styles (style="...") or Tailwind classes (class="flex gap-4 p-6 bg-white"). Classes are compiled to inline styles — with the linked codebase's Tailwind theme when there is one. Responsive variants (sm:/md:/lg:) apply by the artboard's width; hover:/focus:/dark: can't be inlined and are skipped. Tokens are available as var(--token-name).
- Layout with flex, padding and gap. Grid also renders (real CSS) but flex is easier to edit. Avoid margin.
- Assume box-sizing: border-box. UA styles are reset (headings don't have default size/margins).
- Any Google Font or locally installed font works in font-family.
- One style per text element (nested inline formatting is flattened). Use <pre> or white-space:pre for code.
- SVG icons (stroke="currentColor"), never emoji icons.
- layer-name="..." names layers. Local images: <img src="paper-asset:///absolute/path.png">.
- Absolute positioning is fine for decoration; don't cover the whole artboard with an absolute layer.`,
    {
      html: z.string().describe('HTML to convert into design nodes.'),
      targetNodeId: z
        .string()
        .describe(
          '"insert-children": parent to append into. "replace": node to replace. "root" targets the page canvas.',
        ),
      mode: z
        .enum(['insert-children', 'replace'])
        .describe('Append as children, or replace the target node.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ html, targetNodeId, mode, fileId, why }) => {
      const f = resolve(fileId)
      const target = f.node(targetNodeId)

      if (mode === 'replace' && target.type === 'Root')
        return fail('Cannot replace the page root. Use insert-children.')
      const parent = mode === 'insert-children' ? target : f.node(target.parent!)

      if (!canHaveChildren(parent))
        return fail(`"${parent.name}" is a ${parent.type} node and cannot have children.`)

      const tokens = classTokens(html)

      const tailwind = tokens.length
        ? await tailwindResolver(tokens, tailwindEntryFor(f.doc))
        : undefined

      const ab = parent.type === 'Root' ? undefined : artboardOf(f.doc.nodes, parent.id)

      const width = ab
        ? ((await engine.layout(f, [ab.id]))[ab.id]?.width ?? num(ab.styles.width))
        : num(target.styles.width) || 1440

      const { subtrees, warnings } = parseHtml(html, {
        mint: () => f.mint(),
        cloneSource: (id) =>
          f.doc.nodes[id] ? subtreeIds(f.doc.nodes, id).map((i) => f.doc.nodes[i]) : null,
        tailwind,
        width,
        components: componentsFor(f.doc),
      })

      if (!subtrees.length)
        return fail(
          `No design nodes were produced from the HTML.${warnings.length ? ' ' + warnings.join(' ') : ''}`,
        )

      const ops: Op[] = []
      let index = parent.children.length

      if (mode === 'replace') {
        index = parent.children.indexOf(target.id)
        ops.push({ t: 'delete', ids: [target.id] })
      }

      if (parent.type === 'Root') {
        let next =
          mode === 'replace'
            ? { left: num(target.styles.left), top: num(target.styles.top) }
            : await placement(f, 0)

        for (const sub of subtrees) {
          const s = sub[0].styles

          if (s.left === undefined && s.top === undefined) {
            sub[0] = { ...sub[0], styles: { ...s, left: `${next.left}px`, top: `${next.top}px` } }
            next = { left: next.left + (num(s.width) || 400) + ARTBOARD_GAP, top: next.top }
          }
        }
      }

      subtrees.forEach((sub, i) =>
        ops.push({ t: 'insert', parentId: parent.id, index: index + i, nodes: sub }),
      )
      f.transact(ops, 'agent', 'write_html', { why })

      if (parent.type === 'Root') f.broadcast({ t: 'reveal', ids: subtrees.map((s) => s[0].id) })

      const createdIds = subtrees.flatMap((s) => s.map((n) => n.id))
      const rects = await layout(f, createdIds)
      const lines = subtrees.flatMap((s) => treeLines(f, s[0].id, rects, 10, 120))

      const touched = new Set(
        subtrees.map((s) => artboardOf(f.doc.nodes, s[0].id)?.id).filter((x): x is string => !!x),
      )

      const zero = createdIds.filter(
        (id) =>
          rects[id] &&
          (rects[id].width < 0.5 || rects[id].height < 0.5) &&
          f.doc.nodes[id].type !== 'Text',
      )

      const notes = [
        ...warnings,
        ...(await overflowWarnings(f, [...touched])),
        ...(await designNotes(f, [...touched])),
        ...(await componentWarnings(
          f,
          subtrees.map((sub) => sub[0].id),
        )),
      ]

      if (zero.length)
        notes.push(
          `${zero.length} new node(s) render at zero size: ${zero.slice(0, 8).join(', ')}.`,
        )

      return text(
        `Created ${createdIds.length} node(s):\n${lines.join('\n')}${notes.length ? `\n\nNotes:\n- ${notes.join('\n- ')}` : ''}`,
      )
    },
  )

  tool(
    'create_artboard',
    `Create an artboard (top-level frame) on the canvas and return its id; then fill it with write_html (insert-children).
- styles needs width and height in whole px. Artboards default to display:flex, flexDirection:column, white background, and clip overflow.
- It is placed in free space to the right of existing artboards unless you pass left/top.
- Default sizes: desktop 1440×900, tablet 768×1024, mobile 390×844 (add a status bar: get_guide "mobile-status-bar").
- The height is a starting point. If content ends up clipped, switch to height:"fit-content" with update_styles.`,
    {
      name: z.string().describe('Artboard name.'),
      styles: z
        .object({
          width: z.string().describe('e.g. "1440px"'),
          height: z.string().describe('e.g. "900px"'),
        })
        .catchall(z.union([z.string(), z.number()]))
        .describe(
          'camelCase CSS, e.g. {"width":"1440px","height":"900px","backgroundColor":"#FAFAF7"}.',
        ),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ name, styles, fileId, why }) => {
      const f = resolve(fileId)

      const s: Styles = {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#FFFFFF',
        ...normalizeStyles(styles),
      }

      if (s.left === undefined || s.top === undefined) {
        const p = await placement(f, num(s.width))
        s.left ??= `${p.left}px`
        s.top ??= `${p.top}px`
      }

      delete s.position

      const node: PNode = {
        id: f.mint(),
        type: 'Frame',
        name: name.slice(0, 50),
        tag: 'div',
        styles: s,
        parent: f.page.rootId,
        children: [],
      }

      const root = f.doc.nodes[f.page.rootId]
      f.transact(
        [{ t: 'insert', parentId: root.id, index: root.children.length, nodes: [node] }],
        'agent',
        'create_artboard',
        { why },
      )
      f.broadcast({ t: 'reveal', ids: [node.id] })
      const r = (await engine.layout(f, [node.id]))[node.id]

      return json({
        id: node.id,
        name: node.name,
        width: round(r?.width),
        height: round(r?.height),
        worldX: round(r?.worldX),
        worldY: round(r?.worldY),
      })
    },
  )

  tool(
    'delete_nodes',
    'Delete nodes and all their descendants. Check a node with get_node_info first if unsure about its parent.',
    {
      nodeIds: z.array(z.string()).describe('Node ids to delete.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ nodeIds, fileId, why }) => {
      const f = resolve(fileId)

      const ids = nodeIds
        .map((id) => f.node(id))
        .filter((n) => n.type !== 'Root')
        .map((n) => n.id)

      f.transact([{ t: 'delete', ids }], 'agent', 'delete_nodes', { why })

      return json({ deleted: ids })
    },
  )

  tool(
    'set_text_content',
    'Change the text of one or more Text nodes (batched). Prefer this over write_html replace for copy edits.',
    {
      updates: z
        .array(z.object({ nodeId: z.string(), textContent: z.string() }))
        .describe('Text updates.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ updates, fileId, why }) => {
      const f = resolve(fileId)
      const ops: Op[] = []
      const errors: string[] = []

      for (const u of updates) {
        const n = f.doc.nodes[u.nodeId]

        if (!n) errors.push(`${u.nodeId}: not found`)
        else if (n.type !== 'Text') errors.push(`${u.nodeId}: is a ${n.type}, not Text`)
        else ops.push({ t: 'patch', id: n.id, patch: { text: u.textContent } })
      }

      f.transact(ops, 'agent', 'set_text_content', { why })

      return json({ updated: ops.length, errors: errors.length ? errors : undefined })
    },
  )

  tool(
    'rename_nodes',
    'Rename layers (max 50 characters each), batched.',
    {
      updates: z.array(z.object({ nodeId: z.string(), name: z.string() })).describe('Renames.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ updates, fileId, why }) => {
      const f = resolve(fileId)

      const ops: Op[] = updates.map((u) => ({
        t: 'patch',
        id: f.node(u.nodeId).id,
        patch: { name: u.name.slice(0, 50) },
      }))

      f.transact(ops, 'agent', 'rename_nodes', { why })

      return json({ renamed: ops.length })
    },
  )

  tool(
    'update_styles',
    'Set styles on nodes (camelCase CSS like React.CSSProperties), batched. Tokens work as var(--name). An empty string removes a property. Setting left/top on an artboard moves it on the canvas.',
    {
      updates: z
        .array(z.object({ nodeIds: z.array(z.string()), styles: styleRecord }))
        .describe('Each entry applies styles to all listed nodes.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ updates, fileId, why }) => {
      const f = resolve(fileId)
      const ops: Op[] = []
      const ignored: Record<string, string[]> = {}

      for (const u of updates) {
        const styles = normalizeStyles(u.styles)

        for (const id of u.nodeIds) {
          const n = f.node(id)

          if (n.type === 'Root') continue
          const set: Record<string, string | number | null> = {}

          for (const [k, v] of Object.entries(styles)) {
            if (k === 'position' && f.doc.nodes[n.parent!]?.type === 'Root') {
              ;(ignored[n.id] ??= []).push(k)
              continue
            }

            set[k] = v === '' ? null : v
          }

          ops.push({ t: 'styles', id: n.id, set })
        }
      }

      f.transact(ops, 'agent', 'update_styles', { why })

      const abs = [
        ...new Set(
          ops.flatMap((o) => {
            const id = o.t === 'styles' ? artboardOf(f.doc.nodes, o.id)?.id : undefined

            return id ? [id] : []
          }),
        ),
      ]

      const notes = [
        ...(await overflowWarnings(f, abs.slice(0, 10))),
        ...(await designNotes(f, abs.slice(0, 10))),
      ]

      return json({
        updated: ops.length,
        ignoredStyles: Object.keys(ignored).length ? ignored : undefined,
        notes: notes.length ? notes : undefined,
      })
    },
  )

  tool(
    'duplicate_nodes',
    'Deep-duplicate nodes. Each copy goes right after its source (or under parentId). Duplicated artboards are placed in free space. Returns new ids plus a descendantIdMap (source id -> copy id) for immediate edits.',
    {
      nodes: z
        .array(z.object({ id: z.string(), parentId: z.string().optional() }))
        .describe('Nodes to duplicate.'),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ nodes, fileId, why }) => {
      const f = resolve(fileId)
      const ops: Op[] = []

      const results: {
        sourceId: string
        newId: string
        descendantIdMap: Record<string, string>
      }[] = []

      let place: { left: number; top: number } | null = null

      for (const item of nodes) {
        const src = f.node(item.id)

        if (src.type === 'Root') continue
        const idMap: Record<string, string> = {}

        const copy = cloneSubtree(
          subtreeIds(f.doc.nodes, src.id).map((i) => f.doc.nodes[i]),
          () => f.mint(),
          idMap,
        )

        const parent = item.parentId ? f.node(item.parentId) : f.doc.nodes[src.parent!]

        if (!canHaveChildren(parent)) throw new Error(`"${parent.name}" cannot have children.`)
        const index = item.parentId ? parent.children.length : parent.children.indexOf(src.id) + 1

        if (parent.type === 'Root') {
          place ??= await placement(f, 0)
          copy[0] = {
            ...copy[0],
            styles: { ...copy[0].styles, left: `${place.left}px`, top: `${place.top}px` },
          }
          const r = (await engine.layout(f, [src.id]))[src.id]
          place = { left: place.left + Math.round(r?.width ?? 400) + ARTBOARD_GAP, top: place.top }
        }

        ops.push({ t: 'insert', parentId: parent.id, index, nodes: copy })
        const { [src.id]: newId, ...descendantIdMap } = idMap
        results.push({ sourceId: src.id, newId, descendantIdMap })
      }

      f.transact(ops, 'agent', 'duplicate_nodes', { why })

      const topLevel = results.flatMap((r) =>
        f.doc.nodes[f.doc.nodes[r.newId]?.parent ?? '']?.type === 'Root' ? [r.newId] : [],
      )

      if (topLevel.length) f.broadcast({ t: 'reveal', ids: topLevel })

      return json(results)
    },
  )

  tool(
    'move_nodes',
    `Move or reparent nodes while keeping their ids. Each move is either {nodeId, before: siblingId}, {nodeId, after: siblingId}, or {nodeId, parentId, index?} (parentId "root" = page canvas; index clamps, omit to append).
Moves apply in order. In flex parents this changes visual order; moving onto the canvas keeps the node's world position. Returns each resolved parent/index plus affectedParents (final child lists).`,
    {
      moves: z
        .array(
          z.union([
            z.object({ nodeId: z.string(), before: z.string() }),
            z.object({ nodeId: z.string(), after: z.string() }),
            z.object({
              nodeId: z.string(),
              parentId: z.string(),
              index: z.number().int().min(0).optional(),
            }),
          ]),
        )
        .min(1),
      fileId: fileIdArg,
      why: whyArg,
    },
    async ({ moves, fileId, why }) => {
      const f = resolve(fileId)
      let doc: Doc = { ...f.doc, nodes: { ...f.doc.nodes } }
      const ops: Op[] = []
      const results: { nodeId: string; parentId: string; index: number }[] = []
      const affected = new Set<string>()

      const worldRects = await layout(
        f,
        moves.map((m) => f.node(m.nodeId).id),
      )

      for (const m of moves) {
        const n = doc.nodes[f.resolveId(m.nodeId)]

        if (!n || n.type === 'Root') throw new Error(`Cannot move "${m.nodeId}".`)
        let parentId: string
        let index: number

        if ('before' in m || 'after' in m) {
          const sibId = 'before' in m ? m.before : m.after
          const sib = doc.nodes[sibId]

          if (!sib?.parent) throw new Error(`Sibling "${sibId}" not found.`)

          if (sib.id === n.id) throw new Error('A node cannot be placed relative to itself.')
          parentId = sib.parent
          const siblings = doc.nodes[parentId].children.filter((c) => c !== n.id)
          index = siblings.indexOf(sib.id) + ('after' in m ? 1 : 0)
        } else {
          parentId = f.resolveId(m.parentId)
          const p = doc.nodes[parentId]

          if (!p) throw new Error(`Parent "${m.parentId}" not found.`)
          index = m.index ?? p.children.filter((c) => c !== n.id).length
        }

        const parent = doc.nodes[parentId]

        if (!canHaveChildren(parent)) throw new Error(`"${parent.name}" cannot have children.`)

        if (subtreeIds(doc.nodes, n.id).includes(parentId))
          throw new Error(`Cannot move "${n.name}" into itself.`)
        const step: Op[] = [{ t: 'move', id: n.id, parentId, index }]
        const wasTop = doc.nodes[n.parent!]?.type === 'Root'
        const toTop = parent.type === 'Root'
        const r = worldRects[n.id]

        if (toTop && !wasTop && r)
          step.push({
            t: 'styles',
            id: n.id,
            set: {
              left: `${Math.round(r.worldX)}px`,
              top: `${Math.round(r.worldY)}px`,
              position: null,
              width: n.styles.width ?? `${Math.round(r.width)}px`,
              height: n.styles.height ?? `${Math.round(r.height)}px`,
            },
          })

        if (wasTop && !toTop) step.push({ t: 'styles', id: n.id, set: { left: null, top: null } })
        affected.add(n.parent!)
        affected.add(parentId)
        doc = applyOps(doc, step).doc
        ops.push(...step)
        results.push({
          nodeId: n.id,
          parentId: parent.type === 'Root' ? 'root' : parentId,
          index: doc.nodes[parentId].children.indexOf(n.id),
        })
      }

      f.transact(ops, 'agent', 'move_nodes', { why })

      return json({
        moves: results,
        affectedParents: Object.fromEntries(
          [...affected].map((id) => [
            f.doc.nodes[id]?.type === 'Root' ? 'root' : id,
            f.doc.nodes[id]?.children ?? [],
          ]),
        ),
      })
    },
  )

  tool(
    'lint_design',
    "Check a page against the repo's DESIGN.md: contrast, type scale, fonts, spacing and corners (measured in the renderer), plus its Do's and Don'ts (judged by Jev when an OpenRouter key is set). Run it before finish_working_on_nodes. fix:true applies the unambiguous fixes first.",
    {
      nodeId: z
        .string()
        .optional()
        .describe('Only report issues in this artboard (and check its page).'),
      fix: z.boolean().optional().describe('Apply the available fixes, then report what is left.'),
      fileId: fileIdArg,
    },
    async ({ nodeId, fix, fileId }) => {
      const f = resolve(fileId)

      const board = nodeId
        ? (artboardOf(f.doc.nodes, f.node(nodeId).id) ?? f.node(nodeId))
        : undefined

      const pageId = board ? pageOf(f.doc, board.id)?.id : undefined

      const only = (issues: LintIssue[]) =>
        board
          ? issues.filter((i) =>
              i.nodeIds.some(
                (id) => id === board.id || artboardOf(f.doc.nodes, id)?.id === board.id,
              ),
            )
          : issues

      let lint = await lintFile(f, pageId)
      let fixed = 0

      if (fix) {
        const ops = only(lint.issues).flatMap((i) => i.fix ?? [])

        if (ops.length) {
          f.transact(ops, 'agent', 'lint_design fix')
          fixed = ops.length
          lint = await lintFile(f, pageId)
        }
      }

      interface LintResult {
        designMd: string | null
        rules: LintState['rules']
        issues: unknown[]
        error?: string
        fixedNodes?: number
      }

      const result: LintResult = {
        designMd: lint.designMd,
        rules: lint.rules,
        issues: only(lint.issues).map((issue) => {
          const { fix: fixOps, ...rest } = issue

          return Object.assign(rest, { fixable: !!fixOps })
        }),
      }

      if (lint.error) result.error = lint.error

      if (fix) result.fixedNodes = fixed

      return json(result)
    },
  )

  tool(
    'propose_options',
    "Let the user choose instead of guessing. When a decision is a matter of taste or product judgment (layout, density, hierarchy, emphasis, tone, color), build 2 to 4 alternatives as separate artboards side by side, then call this with a short question. Paperish frames them, labels them A to D, and the user picks with a key or a click, optionally with a note. Then call wait_for_pick. Make the options differ only in what's being decided, give each a 1 to 3 word label, and prefer this to asking in chat or picking yourself. Not for things with a right answer (bugs, the spec, DESIGN.md rules).",
    {
      question: z
        .string()
        .describe('What the user is deciding, e.g. "Which density fits the billing page?"'),
      options: z
        .array(
          z.object({
            nodeId: z.string().describe('A top-level artboard.'),
            label: z.string().max(40).describe('1 to 3 words, e.g. "Compact".'),
            note: z.string().max(200).optional().describe('One line on the trade-off.'),
          }),
        )
        .min(2)
        .max(4),
      fileId: fileIdArg,
    },
    ({ question, options, fileId }) => {
      const f = resolve(fileId)
      const ids = options.map((o) => f.node(o.nodeId).id)

      if (new Set(ids).size !== ids.length) throw new Error('Each option needs its own artboard.')
      const pages = new Set(ids.map((id) => pageOf(f.doc, id)?.id))

      if (ids.some((id) => f.doc.nodes[f.doc.nodes[id].parent ?? '']?.type !== 'Root'))
        throw new Error(
          'Options must be top-level artboards (duplicate the artboard and change the copy).',
        )

      if (pages.size > 1) throw new Error('Put the options on one page.')
      const p = propose(f, question, options)

      return json({
        proposalId: p.id,
        options: p.options,
        next: 'Call wait_for_pick with this proposalId.',
      })
    },
  )

  tool(
    'wait_for_pick',
    'Wait for the user to answer a proposal from propose_options. Returns the picked option (the other options are then removed from the canvas) and any note, or "none" with a note when nothing fit. If the user has not answered within the timeout it returns "waiting": call it again, or carry on with other work and check back.',
    {
      proposalId: z.string(),
      timeoutSeconds: z.number().int().min(5).max(600).optional().describe('Default 300.'),
    },
    async ({ proposalId, timeoutSeconds }) => {
      const r = await waitForPick(proposalId, (timeoutSeconds ?? 300) * 1000)

      if (!r) return json({ status: 'waiting', proposalId })

      if (!r.picked)
        return json({
          status: 'none',
          note: r.note ?? null,
          next: 'None of the options fit. Read the note, then propose again or ask.',
        })

      return json({
        status: 'picked',
        picked: r.picked,
        note: r.note ?? null,
        removed: r.removed,
        next: `Continue from artboard ${r.picked.nodeId}${r.note ? ', taking the note into account' : ''}. If this settles a design-system choice (a token or a rule), record it in DESIGN.md.`,
      })
    },
  )

  tool(
    'finish_working_on_nodes',
    'Call when you are done: clears the "agent working" indicator from artboards (no arguments clears all) and returns the design checks still failing on them, with what to offer the user next.',
    { nodeIds: z.array(z.string()).optional(), fileId: fileIdArg },
    async ({ nodeIds, fileId }) => {
      const f = resolve(fileId)

      const boards = nodeIds?.length
        ? nodeIds.map((id) => artboardOf(f.doc.nodes, id)?.id ?? id)
        : [...f.working]

      const issues = await checkBoards(f, [...new Set(boards)])
      f.finishWorking(nodeIds)

      if (!boards.length) return json({ working: [...f.working] })

      return json({
        working: [...f.working],
        designIssues: issues.map(({ fix, nodeIds: _, ...i }) => ({ ...i, fixable: !!fix })),
        next: issues.length
          ? "Tell the user which design checks still fail and offer to fix them in the design. Once they're happy with the design, offer to bring it into the app's code."
          : "Design checks pass. Offer to bring the design into the app's code.",
      })
    },
  )

  // ---------------------------------------------------------------- tokens

  tool(
    'get_tokens',
    'List design tokens, optionally filtered by type or name glob, as JSON, a :root CSS block, or a Tailwind v4 @theme block.',
    {
      types: z.array(tokenType).optional(),
      namePattern: z
        .string()
        .optional()
        .describe('Glob on the CSS variable name, e.g. "--color-*".'),
      format: z.enum(['json', 'css', 'tailwind']).optional(),
      fileId: fileIdArg,
    },
    ({ types, namePattern, format, fileId }) => {
      const f = resolve(fileId)
      const re = namePattern ? globToRegExp(namePattern) : null

      const tokens = f.doc.tokens.filter(
        (t) => (!types?.length || types.includes(t.type)) && (!re || re.test(t.name)),
      )

      if (format === 'css')
        return text(`:root {\n${tokens.map((t) => `  ${t.name}: ${t.value};`).join('\n')}\n}`)

      if (format === 'tailwind')
        return text(
          `@theme {\n${tokens.map((t) => `  ${tailwindTokenName(t)}: ${t.value};`).join('\n')}\n}`,
        )

      return json(tokens)
    },
  )

  tool(
    'create_tokens',
    'Create design tokens ({type, name: "--color-primary", value, description?}). Alias with var(--other). Reuse existing tokens where possible. Colors: semantic first (neutrals, then primary, secondary, accent); other types smallest value first. Opacity is a unitless 0 to 1 (or a percentage), not a px length.',
    {
      tokens: z
        .array(
          z.object({
            type: tokenType,
            name: z.string().regex(/^--[a-zA-Z0-9_-]+$/),
            value: z.union([z.string(), z.number()]),
            description: z.string().max(1024).optional(),
          }),
        )
        .min(1),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ tokens, fileId, why }) => {
      const f = resolve(fileId)
      // SAFETY: token inputs match the Token shape after the zod type/name/value validation above.
      const next = [...f.doc.tokens, ...tokens.map((t) => ({ ...t }) as Token)]
      f.transact([{ t: 'tokens', tokens: next }], 'agent', 'create_tokens', { why })

      return json(tokens.map((t) => ({ name: t.name, result: 'created' })))
    },
  )

  tool(
    'set_tokens',
    'Update, rename (usages are rewritten) or delete design tokens by name.',
    {
      tokens: z
        .array(
          z.object({
            name: z.string().regex(/^--[a-zA-Z0-9_-]+$/),
            newName: z
              .string()
              .regex(/^--[a-zA-Z0-9_-]+$/)
              .optional(),
            value: z.union([z.string(), z.number()]).optional(),
            description: z.string().max(1024).optional(),
            delete: z.boolean().optional(),
          }),
        )
        .min(1),
      fileId: fileIdArg,
      why: whyArg,
    },
    ({ tokens, fileId, why }) => {
      const f = resolve(fileId)
      let list = f.doc.tokens.slice()
      const ops: Op[] = []

      const results = tokens.map((u) => {
        const i = list.findIndex((t) => t.name === u.name)

        if (i < 0) return { name: u.name, result: 'error', message: 'Token not found' }

        if (u.delete) {
          list.splice(i, 1)

          return { name: u.name, result: 'deleted' }
        }

        const t = { ...list[i] }

        if (u.value !== undefined) t.value = u.value

        if (u.description !== undefined) t.description = u.description || undefined

        if (u.newName && u.newName !== u.name) {
          t.name = u.newName
          const pattern = `var\\(\\s*${escapeRe(u.name)}\\s*([,)])`
          const from = new RegExp(pattern, 'g')
          const uses = new RegExp(pattern)

          for (const n of Object.values(f.doc.nodes)) {
            const set: Record<string, string> = {}

            for (const [k, v] of Object.entries(n.styles))
              if (isStyleString(v) && uses.test(v)) set[k] = v.replace(from, `var(${u.newName}$1`)

            if (Object.keys(set).length) ops.push({ t: 'styles', id: n.id, set })
          }

          list = list.map((x) =>
            isStyleString(x.value)
              ? { ...x, value: x.value.replace(from, `var(${u.newName}$1`) }
              : x,
          )
        }

        list[list.findIndex((x) => x.name === u.name)] = t
        const updated: TokenUpdateResult = { name: u.name, result: 'updated' }

        if (u.newName) updated.newName = u.newName

        return updated
      })

      ops.push({ t: 'tokens', tokens: list })
      f.transact(ops, 'agent', 'set_tokens', { why })

      return json(results)
    },
  )

  return server
}

// ---------------------------------------------------------------- utils

function round(v: number | undefined, digits = 0): number | undefined {
  if (v === undefined || !isFinite(v)) return undefined
  const m = 10 ** digits

  return Math.round(v * m) / m
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function num(v: StyleValue | undefined): number {
  const n = parseFloat(String(v ?? ''))

  return isFinite(n) ? n : 0
}

function countDesc(doc: Doc, id: string) {
  return subtreeIds(doc.nodes, id).length - 1
}

function layoutHint(s: Styles): string {
  const d = String(s.display ?? '')

  if (d.includes('flex'))
    return ` [flex ${String(s.flexDirection ?? 'row').startsWith('column') ? 'col' : 'row'}${s.gap ? ` gap ${s.gap}` : ''}]`

  if (d.includes('grid')) return ' [grid]'

  if (s.position === 'absolute') return ' [absolute]'

  return ''
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map(escapeRe).join('.*') + '$', 'i')
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'export'
  )
}

function writeExport(name: string, buf: Buffer, nodeId: string, format: string) {
  const file = path.join(EXPORTS_DIR, name)
  fs.writeFileSync(file, buf)

  return { nodeId, format, path: file, url: `${ORIGIN}/exports/${encodeURIComponent(name)}` }
}

function resolveScale(spec: string, r: { width: number; height: number }): number {
  const m = spec.match(/^(\d+(?:\.\d+)?)(x|w|h|p)$/)!
  const v = Number(m[1])

  switch (m[2]) {
    case 'x':
      return v
    case 'w':
      return v / r.width
    case 'h':
      return v / r.height
    default:
      return v / Math.min(r.width, r.height)
  }
}

interface TokenNamespaceMap {
  [tokenType: string]: string
}

const TW_NS: TokenNamespaceMap = {
  color: 'color',
  opacity: 'opacity',
  spacing: 'spacing',
  radius: 'radius',
  fontSize: 'text',
  fontFamily: 'font',
  fontWeight: 'font-weight',
  lineHeight: 'leading',
  letterSpacing: 'tracking',
  breakpoint: 'breakpoint',
  container: 'container',
}

function tailwindTokenName(t: Token): string {
  const ns = TW_NS[t.type]
  const bare = t.name.replace(/^--/, '')

  if (bare.startsWith(ns + '-')) return t.name

  const stripped = bare.replace(
    /^(color|colors|opacity|space|spacing|radius|rounded|font-size|text|font|font-weight|weight|leading|line-height|tracking|letter-spacing|breakpoint|bp|container)-/,
    '',
  )

  return `--${ns}-${stripped}`
}

async function loadImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const local = assetPath(url)

  if (local) {
    const ext = path.extname(local).slice(1)

    return { bytes: fs.readFileSync(local), mime: EXT_MIME[ext] ?? 'application/octet-stream' }
  }

  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s)

    if (!m) throw new Error('Malformed data URL')

    return {
      bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])),
      mime: m[1],
    }
  }

  const res = await fetch(url)

  if (!res.ok) throw new Error(`Fetching image failed: HTTP ${res.status}`)

  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg',
  }
}

/** <link> tags for the Google Fonts used in a document (for PDF export pages). */
async function fontHead(doc: Doc): Promise<string> {
  const google = await googleFonts()
  const specs = new Set<string>()
  specs.add(
    css2Spec(
      google.get('inter') ?? {
        family: 'Inter',
        category: '',
        styles: ['400'],
        axes: [{ tag: 'wght', min: 100, max: 900 }],
      },
    ),
  )

  for (const n of Object.values(doc.nodes))
    for (const fam of fontFamiliesOf(n.styles.fontFamily)) {
      const g = google.get(fam.toLowerCase())

      if (g) specs.add(css2Spec(g))
    }

  const tokens = doc.tokens.length
    ? `<style>:root{${doc.tokens.map((t) => `${t.name}:${t.value}`).join(';')}}</style>`
    : ''

  const faces = doc.fontFaces?.length ? `<style>${fontFaceCss(doc.fontFaces)}</style>` : ''

  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...specs].map((s) => `family=${s}`).join('&')}&display=block">${tokens}${faces}`
}
