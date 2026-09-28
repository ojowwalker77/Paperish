// Call one Paperish MCP tool from the command line.
//   npx tsx scripts/mcp.ts <tool> '<json args>' [imageOutDir]
import fs from 'node:fs'
import path from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const [name, rawArgs = '{}', outDir] = process.argv.slice(2)

if (!name) {
  console.error('usage: npx tsx scripts/mcp.ts <tool> [json-args] [image-out-dir]')
  process.exit(1)
}

const client = new Client(
  { name: 'paperish-cli', version: '0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)

await client.connect(
  new StreamableHTTPClientTransport(
    new URL(process.env.PAPERISH_MCP ?? 'http://127.0.0.1:29980/mcp'),
  ),
)

// SAFETY: MCP returns content items for the requested tool; CLI prints text and saves images.
const res = (await client.callTool(
  { name, arguments: JSON.parse(rawArgs) },
  { timeout: 180_000 },
)) as {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  isError?: boolean
}

for (const c of res.content) {
  if (c.type === 'text') console.log(c.text)
  else if (c.type === 'image' && c.data) {
    const file = path.join(
      outDir ?? '.',
      `${name}-${Date.now()}.${c.mimeType?.split('/')[1] ?? 'png'}`,
    )

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(c.data, 'base64'))
    console.log(`[image] ${file}`)
  }
}

await client.close()

process.exit(res.isError ? 1 : 0)
