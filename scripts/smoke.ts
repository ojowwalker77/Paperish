// End-to-end MCP smoke test: builds a small design through the MCP endpoint
// and saves screenshots. Usage: npx tsx scripts/smoke.ts [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const url = process.env.PAPERISH_MCP ?? 'http://127.0.0.1:29980/mcp/scratch'

const out = process.argv[2] ?? 'smoke-out'

fs.mkdirSync(out, { recursive: true })

const client = new Client(
  { name: 'smoke', version: '0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)

await client.connect(new StreamableHTTPClientTransport(new URL(url)))

type Content = { type: string; text?: string; data?: string; mimeType?: string }

type ToolArgs = Record<string, string | number | boolean | null | ToolArgs | ToolArgs[]>

async function call(name: string, args: ToolArgs = {}) {
  const t0 = Date.now()

  // SAFETY: MCP returns content items for the requested tool; smoke prints text and saves images.
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Content[]
    isError?: boolean
  }

  const ms = Date.now() - t0

  const textOut = res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

  console.log(`\n### ${name} (${ms}ms)${res.isError ? ' ERROR' : ''}\n${textOut.slice(0, 1500)}`)

  if (res.isError) throw new Error(`${name} failed`)

  for (const c of res.content) {
    if (c.type === 'image') {
      const file = path.join(out, `${name}-${Date.now()}.${c.mimeType?.split('/')[1] ?? 'png'}`)
      fs.writeFileSync(file, Buffer.from(c.data!, 'base64'))
      console.log(`→ saved ${file}`)
    }
  }

  return textOut
}

const tools = await client.listTools()

console.log(`${tools.tools.length} tools:`, tools.tools.map((t) => t.name).join(', '))

await call('get_basic_info')

const ab = JSON.parse(
  await call('create_artboard', {
    name: 'Landing',
    styles: { width: '1440px', height: '900px', backgroundColor: '#F6F3EE' },
  }),
)

await call('write_html', {
  targetNodeId: ab.id,
  mode: 'insert-children',
  html: `<div layer-name="Nav" style="display:flex;align-items:center;justify-content:space-between;padding:28px 64px;">
    <span style="font-family:'Fraunces',serif;font-size:24px;font-weight:600;color:#1C1917;">Fieldnote</span>
    <div style="display:flex;gap:32px;align-items:center;">
      <span style="font-size:15px;color:#57534E;">Journal</span>
      <span style="font-size:15px;color:#57534E;">Pricing</span>
      <button style="padding:10px 18px;border-radius:999px;background:#1C1917;color:#FAFAF9;font-size:14px;font-weight:500;">Start writing</button>
    </div>
  </div>`,
})

await call('write_html', {
  targetNodeId: ab.id,
  mode: 'insert-children',
  html: `<div layer-name="Hero" style="display:flex;flex-direction:column;gap:28px;padding:120px 64px 0;max-width:980px;">
    <h1 style="font-family:'Fraunces',serif;font-size:84px;line-height:88px;letter-spacing:-0.03em;color:#1C1917;font-weight:500;">A quiet place for the notes that matter.</h1>
    <p style="font-size:20px;line-height:32px;color:#57534E;max-width:620px;">Fieldnote turns scattered thoughts into a searchable journal — private by default, synced everywhere, and fast enough to keep up with you.</p>
    <div style="display:flex;gap:12px;">
      <button style="display:flex;align-items:center;gap:8px;padding:16px 24px;border-radius:999px;background:#C2410C;color:white;font-size:16px;font-weight:600;">Try it free <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      <button style="padding:16px 24px;border-radius:999px;border:1px solid #D6D3D1;color:#1C1917;font-size:16px;font-weight:500;">Watch the tour</button>
    </div>
  </div>`,
})

const tree = await call('get_tree_summary', { nodeId: ab.id, depth: 4 })

await call('get_screenshot', { nodeId: ab.id })

await call('get_jsx', { nodeId: ab.id, format: 'tailwind' })

const btnId =
  tree.match(/Text "Start writing" \((N\w+)\)/)?.[1] ?? tree.match(/Button[^(]*\((N\w+)\)/)?.[1]

if (btnId) await call('get_computed_styles', { nodeIds: [btnId] })

await call('find_nodes', { filters: [{ styleName: 'background-color', styleValue: '#1c1917' }] })

await call('find_nodes', { textValue: '*free*' })

await call('get_font_family_info', {
  familyNames: ['Fraunces', 'Inter', 'Helvetica Neue', 'Nope Sans'],
})

await call('create_tokens', {
  tokens: [{ type: 'color', name: '--color-accent', value: '#C2410C' }],
})

const dup = JSON.parse(await call('duplicate_nodes', { nodes: [{ id: ab.id }] }))

await call('update_styles', {
  updates: [{ nodeIds: [dup[0].newId], styles: { backgroundColor: '#1C1917' } }],
})

await call('rename_nodes', { updates: [{ nodeId: dup[0].newId, name: 'Landing — dark' }] })

await call('get_screenshot', { nodeId: dup[0].newId, scale: 0.5 })

await call('export', {
  nodes: {
    [ab.id]: [
      { format: 'png', scale: '1x' },
      { format: 'pdf', scale: '1x' },
    ],
  },
})

await call('get_basic_info')

await call('finish_working_on_nodes')

await client.close()
