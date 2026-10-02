import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { ClientMsg, RepoCommit, RepoCompare, RepoState, ServerMsg } from '../shared/types'
import { assetPath, EXT_MIME } from './assets'
import { EXPORTS_DIR, HOST, IS_PROD, ORIGIN, PORT, ROOT_DIR } from './config'
import { engine } from './engine'
import { googleFontIndex } from './fonts'
import { toJSX } from './serialize'
import { createMcpServer, mcpRequest } from './tools'
import { call, onMain } from './host'
import { duplicate, insertHtml } from './commands'
import { compareCommit, fileHistory } from './history'
import {
  closeProjects,
  componentsFor,
  ensureProject,
  onProjectChange,
  projectState,
  tailwindEntryFor,
} from './project'
import { tailwindColorNames } from './tailwind'
import { lintFile } from './lint'
import { setDesignMdPath } from './projects'
import {
  createThread,
  deleteThread,
  personFor,
  reply as replyToThread,
  setStatus,
} from './comments'
import { pick, proposalFor } from './proposals'
import { settingsState, updateSettings } from './settings'
import { runImport } from './tasks'
import { newPage, Workspace, type Client, type OpenFile } from './workspace'

const workspace = new Workspace()

// Only local pages may talk to the server: our editor windows (and Vite's dev
// client). DNS rebinding still fails: its Host/Origin hostname isn't loopback.
const LOOPBACK = [HOST, 'localhost', '127.0.0.1', '[::1]']

const loopback = (hostname: string) =>
  LOOPBACK.includes(hostname) || hostname.endsWith('.localhost')

const localHost = (host: string | undefined) => {
  try {
    return !!host && loopback(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

const localOrigin = (origin: string) => {
  try {
    return loopback(new URL(origin).hostname)
  } catch {
    return false
  }
}

interface StaticMimeMap {
  [ext: string]: string
}

function isStringValue(v: string | string[] | undefined): v is string {
  return Object.prototype.toString.call(v) === '[object String]'
}

type RepoApiReply =
  | { repo: RepoState | null; commits: RepoCommit[] }
  | RepoCompare
  | { error: string }

const server = http.createServer()

// ---- Static / dev frontend ----------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void

let frontend: Handler

if (IS_PROD) {
  const dist = path.join(ROOT_DIR, 'dist')
  frontend = (req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN)
    let file = path.join(dist, decodeURIComponent(url.pathname))

    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(dist, 'index.html')
    const ext = path.extname(file).slice(1)

    const types: StaticMimeMap = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      svg: 'image/svg+xml',
      png: 'image/png',
      woff2: 'font/woff2',
    }

    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }
} else {
  const { createServer } = await import('vite')

  const vite = await createServer({
    root: ROOT_DIR,
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  })

  // SAFETY: vite exposes its middleware stack as a (req, res, next) handler.
  frontend = vite.middlewares as Handler
}

// ---- HTTP routes -----------------------------------------------------------------

server.on('request', async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN)

  try {
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' })

      return void res.end(JSON.stringify({ paperish: true, origin: ORIGIN }))
    }

    if (url.pathname.startsWith('/mcp/'))
      return await handleMcp(req, res, url.pathname.slice('/mcp/'.length))

    if (url.pathname === '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' })

      return void res.end(
        'Each project has its own endpoint: /mcp/<project id> (see the project’s .mcp.json).',
      )
    }

    if (url.pathname.startsWith('/media/')) {
      const file = assetPath(url.pathname)

      if (!file || !fs.existsSync(file)) return notFound(res)
      res.writeHead(200, {
        'content-type': EXT_MIME[path.extname(file).slice(1)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      })

      return void fs.createReadStream(file).pipe(res)
    }

    if (url.pathname.startsWith('/exports/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/exports/'.length)))
      const file = path.join(EXPORTS_DIR, name)

      if (!fs.existsSync(file)) return notFound(res)
      const ext = path.extname(file).slice(1)

      const mime =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'svg'
            ? 'image/svg+xml'
            : (EXT_MIME[ext] ?? 'application/octet-stream')

      res.writeHead(200, { 'content-type': mime })

      return void fs.createReadStream(file).pipe(res)
    }

    if (url.pathname.startsWith('/api/repo/')) {
      // Reads local folders and git history: our own editor only.
      const origin = req.headers.origin

      if (!localHost(req.headers.host) || (origin && !localOrigin(origin))) {
        res.writeHead(403, { 'content-type': 'text/plain' })

        return void res.end('Forbidden')
      }

      const reply = (body: RepoApiReply, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }

      try {
        const f = workspace.get(url.searchParams.get('file') ?? '')

        if (url.pathname === '/api/repo/history') {
          f.repo?.refreshStatus()

          return reply({ repo: f.repo?.state ?? null, commits: await fileHistory(f) })
        }

        if (url.pathname === '/api/repo/compare')
          return reply(
            await compareCommit(workspace, f, url.searchParams.get('commit') || 'working'),
          )
      } catch (e) {
        // SAFETY: workspace, history and repo helpers throw Error instances.
        return reply({ error: (e as Error).message }, 400)
      }

      return notFound(res)
    }

    if (url.pathname === '/api/jsx') {
      const f = workspace.get(url.searchParams.get('file') ?? '')

      const format =
        url.searchParams.get('format') === 'inline-styles' ? 'inline-styles' : 'tailwind'

      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })

      return void res.end(
        toJSX(
          f.doc.nodes,
          f.node(url.searchParams.get('node') ?? '').id,
          format,
          componentsFor(f.doc),
          tailwindColorNames(tailwindEntryFor(f.doc)),
        ),
      )
    }

    if (url.pathname === '/api/fonts/google') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' })

      return void res.end(JSON.stringify(await googleFontIndex()))
    }

    frontend(req, res, () => notFound(res))
  } catch (e) {
    console.error('[paperish] request failed', e)

    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    // SAFETY: route handlers throw Error instances.
    res.end(String((e as Error).message ?? e))
  }
})

function notFound(res: http.ServerResponse) {
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
}

// MCP over streamable HTTP. Serves the 2026-07-28 revision (stateless, a
// per-request envelope) and falls back to stateless 2025-era serving for
// clients that still use the initialize handshake; one factory backs both.
// Host and Origin guards keep other sites and DNS rebinding out; MCP clients
// that aren't browsers send no Origin and pass.
const validateHost = hostHeaderValidation(LOOPBACK)

const validateOrigin = originValidation(LOOPBACK)

// Each project has its own endpoint, /mcp/<project id>: what a repo's .mcp.json points at.
const mcpHandlers = new Map<string, ReturnType<typeof toNodeHandler>>()

function mcpFor(projectId: string) {
  let h = mcpHandlers.get(projectId)

  if (!h) {
    h = toNodeHandler(
      createMcpHandler(() => createMcpServer(workspace, projectId), {
        onerror: (e) => console.warn('[paperish] mcp:', e.message),
      }),
    )
    mcpHandlers.set(projectId, h)
  }

  return h
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, projectId: string) {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return
  let project

  try {
    project = workspace.project(projectId)
  } catch (e) {
    res.writeHead(404, { 'content-type': 'application/json' })

    // SAFETY: workspace.project throws Error for unknown projects.
    return void res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: (e as Error).message },
      }),
    )
  }

  await workspace.projects.checkouts(project) // briefly cached; keeps the checkout list current for routing
  const header = req.headers['x-paperish-dir']
  const dir = isStringValue(header) && header.startsWith('/') ? header : undefined

  // A worktree made since git was last asked isn't known yet.
  if (dir && !workspace.projects.locateSync(dir)) await workspace.projects.locate(dir)
  await mcpRequest.run({ dir }, () => mcpFor(projectId)(req, res))
}

// ---- WebSocket sync --------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', ORIGIN)

  if (url.pathname !== '/ws') return // Vite HMR handles its own upgrades
  const origin = req.headers.origin

  if (origin && !localOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')

    return socket.destroy()
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

/** A downloaded update, offered to every editor until the app restarts into it. */
let update: string | null = null

onMain((msg) => {
  if (msg.t !== 'update') return
  update = msg.version
  const data = JSON.stringify({ t: 'update', version: update } satisfies ServerMsg)

  for (const c of workspace.clients)
    if (c.role === 'editor' && c.ws.readyState === 1) c.ws.send(data)
})

wss.on('connection', (socket) => {
  const client: Client = { ws: socket, role: 'editor', fileId: null }
  workspace.clients.add(client)
  const send = (msg: ServerMsg) => socket.readyState === 1 && socket.send(JSON.stringify(msg))

  const failed = (e: Error) => send({ t: 'error', message: e.message })

  const sendLint = (f: OpenFile) =>
    lintFile(f).then(
      (lint) => send({ t: 'lint', fileId: f.doc.id, lint }),
      (e) => {
        // SAFETY: lintFile rejects with Error instances for engine failures.
        const error = (e as Error).message

        send({
          t: 'lint',
          fileId: f.doc.id,
          lint: { designMd: null, issues: [], rules: { count: 0, status: 'none' }, error },
        })
      },
    )

  const attach = (fileId: string) => {
    const f = workspace.get(fileId)
    client.fileId = f.doc.id
    send(f.snapshot())
    send({ t: 'working', ids: [...f.working] })
    send({ t: 'repo', repo: f.repo?.state ?? null })
    send({ t: 'proposal', proposal: proposalFor(f.doc.id) })
    f.repo?.refreshStatus()
    const root = f.doc.project?.root
    const st = projectState(root)
    send({ t: 'project', project: st ?? null })

    if (root && !st) {
      // SAFETY: ensureProject rejects with Error for unreadable folders.
      ensureProject(root).catch((e) =>
        send({ t: 'error', message: `Linked codebase: ${(e as Error).message}` }),
      )
    }

    if (client.role === 'editor') {
      void workspace.filesMsg(f).then((m) => client.fileId === f.doc.id && send(m))
      workspace.setActive(f)
    }

    return f
  }

  const fail = (e: Error) => send({ t: 'error', message: e.message })
  client.open = (id) => void attach(id)

  const home = () => {
    client.fileId = null
    send({ t: 'closed' })
    send({ t: 'projects', projects: workspace.projectInfos() })
  }

  client.home = home

  send({ t: 'settings', settings: settingsState() })

  if (update) send({ t: 'update', version: update })

  /** A project opens on the checkout an agent worked in last (else the one with the newest design), at its last-used file. */
  const openProject = async (projectId: string) =>
    attach(workspace.fileIn(projectId, await workspace.defaultCheckout(projectId)).doc.id)

  /** The file the editor shows, as a path relative to its checkout, to find its counterpart elsewhere. */
  const currentRel = () => {
    const f = client.fileId ? workspace.get(client.fileId) : null

    if (!f) return undefined

    return f.ref ? f.ref.rel : f.checkout ? path.relative(f.checkout, f.doc.source) : undefined
  }

  socket.on('message', (raw) => {
    let msg: ClientMsg

    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }

    try {
      switch (msg.t) {
        case 'hello':
          client.role = msg.role

          if (msg.fileId && workspace.has(msg.fileId)) attach(msg.fileId)
          else home()
          break
        case 'home':
          home()
          break
        case 'open':
          attach(msg.fileId)
          break
        case 'projects':
          send({ t: 'projects', projects: workspace.projectInfos() })
          break
        case 'openProject':
          openProject(msg.projectId).catch(fail)
          break
        case 'openCheckout': {
          if (!client.fileId) return
          const f = workspace.get(client.fileId)
          attach(workspace.fileIn(f.projectId, msg.checkout, currentRel()).doc.id)
          break
        }

        case 'openBranch': {
          if (!client.fileId) return
          const f = workspace.get(client.fileId)
          workspace
            .openBranch(f.projectId, msg.branch, msg.rel ?? currentRel())
            .then((b) => attach(b.doc.id))
            .catch(fail)
          break
        }

        case 'addProject': {
          // SAFETY: workspace.projects.add rejects with Error for invalid folders.
          void call('openDialog', {
            title: 'Add a project',
            buttonLabel: 'Add Project',
            properties: ['openDirectory', 'createDirectory'],
          })
            .then(async (dir) => {
              if (!dir) return
              const p = await workspace.projects.add(dir)
              workspace.broadcastProjects()
              await openProject(p.id)
            })
            .catch((e) => send({ t: 'error', message: (e as Error).message }))
          break
        }

        case 'settings': {
          updateSettings(msg)

          const data = JSON.stringify({
            t: 'settings',
            settings: settingsState(),
          } satisfies ServerMsg)

          for (const c of workspace.clients)
            if (c.role === 'editor' && c.ws.readyState === 1) c.ws.send(data)
          break
        }

        case 'installUpdate':
          void call('installUpdate')
          break
        case 'removeProject':
          workspace.projects.remove(msg.projectId)
          workspace.broadcastProjects()
          break
        case 'renameProject':
          workspace.projects.rename(msg.projectId, msg.name.trim())
          workspace.broadcastProjects()
          break
        case 'createFile': {
          if (!client.fileId) return
          const f = workspace.get(client.fileId)
          attach(workspace.create(f.projectId, msg.name, undefined, f.checkout ?? undefined).doc.id)
          break
        }

        case 'deleteFile': {
          const id = msg.fileId
          const { projectId, checkout } = workspace.get(id)

          if (!checkout) throw new Error('Files of a branch viewed as committed can’t be deleted.')
          void engine.forget(id)
          void workspace.remove(id).then(
            () => {
              // Editors looking at it move to the checkout's most recent other file, or home.
              const next = workspace.listFiles(projectId, checkout)[0]?.id

              for (const c of workspace.clients) {
                if (c.fileId !== id || c.role !== 'editor') continue

                if (next) c.open?.(next)
                else c.home?.()
              }
            },
            // SAFETY: workspace.remove rejects with Error for missing files.
            (e) => send({ t: 'error', message: (e as Error).message }),
          )
          break
        }

        default: {
          if (!client.fileId) return
          const f = workspace.get(client.fileId)

          if (msg.t === 'tx') f.transact(msg.ops, 'user', msg.label)
          else if (msg.t === 'undo') f.undo()
          else if (msg.t === 'redo') f.redo()
          else if (msg.t === 'selection') {
            f.selection = { pageId: msg.pageId, ids: msg.ids }
            workspace.setActive(f)
          } else if (msg.t === 'page') f.setPage(msg.pageId)
          else if (msg.t === 'insertHtml')
            insertHtml(f, msg.parentId, msg.html, msg.index, msg.styles).then(
              (ids) => send({ t: 'created', ids }),
              (e) => {
                send({ t: 'created', ids: [] })
                // SAFETY: insertHtml rejects with Error for invalid markup.
                send({ t: 'error', message: (e as Error).message })
              },
            )
          else if (msg.t === 'duplicate')
            send({ t: 'created', ids: duplicate(f, msg.ids, msg.name) })
          else if (msg.t === 'importUrl')
            runImport(f, { url: msg.url, width: msg.width }, 'user', msg.token).catch((e) =>
              // SAFETY: runImport rejects with Error for failed imports.
              console.warn('[paperish] import failed:', (e as Error).message),
            )
          else if (msg.t === 'lint') sendLint(f)
          else if (msg.t === 'pickDesignMd') {
            const checkout = f.checkout

            if (!checkout)
              throw new Error('A branch viewed as committed can’t change its DESIGN.md.')

            // SAFETY: setDesignMdPath throws Error for files outside the checkout.
            void call('openDialog', {
              title: 'Choose DESIGN.md',
              buttonLabel: 'Use This File',
              defaultPath: checkout,
              properties: ['openFile'],
              filters: [{ name: 'Markdown', extensions: ['md'] }],
            })
              .then((file) => {
                if (!file) return
                setDesignMdPath(checkout, file)
                sendLint(f)
              })
              .catch((e) => send({ t: 'error', message: (e as Error).message }))
          } else if (msg.t === 'pick') pick(f, msg.proposalId, msg.nodeId, msg.note)
          else if (msg.t === 'comment:create')
            personFor(f)
              .then((me) => {
                const t = createThread(f, me, msg, msg.text, 'user')
                send({ t: 'comment:created', threadId: t.id })
              })
              .catch(failed)
          else if (msg.t === 'comment:reply')
            personFor(f)
              .then((me) => replyToThread(f, me, msg.threadId, msg.text, 'user'))
              .catch(failed)
          else if (msg.t === 'comment:status') setStatus(f, msg.threadId, msg.status, 'user')
          else if (msg.t === 'comment:delete') deleteThread(f, msg.threadId, 'user')
          else if (msg.t === 'createPage') {
            const { page, root } = newPage(f, msg.name?.trim() || `Page ${f.doc.pages.length + 1}`)
            f.transact([{ t: 'page:add', page, root }], 'user', 'create page')
            f.setPage(page.id)
          }
        }
      }
    } catch (e) {
      // SAFETY: transact, branch and file helpers throw Error instances.
      send({ t: 'error', message: (e as Error).message })
    }
  })

  socket.on('close', () => workspace.clients.delete(client))
})

// ---- Lifecycle -------------------------------------------------------------------

/** Resolves once the server is accepting connections. */
export const listening = new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(PORT, HOST, () => {
    console.log(`\n  Paperish running at ${ORIGIN}`)
    console.log(`  MCP endpoints:     ${ORIGIN}/mcp/<project id>\n`)
    resolve()
  })
})

// Push project status (starting/ready/components changed) to every client of a linked file.
onProjectChange((state) => {
  const data = JSON.stringify({ t: 'project', project: state } satisfies ServerMsg)

  for (const c of workspace.clients) {
    if (!c.fileId || c.ws.readyState !== 1) continue

    try {
      if (workspace.get(c.fileId).doc.project?.root === state.root) c.ws.send(data)
    } catch {}
  }
})

/** Save everything and stop the codebases' dev servers. */
export async function shutdown() {
  workspace.flushAll()
  await engine.close().catch(() => {})
  await closeProjects()
}
