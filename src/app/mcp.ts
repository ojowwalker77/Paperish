import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { ORIGIN } from '../server/config'
import { createMcpServer, type Forward } from '../server/tools'

const CALL_TIMEOUT = 15 * 60_000

export async function serveStdio(projectId: string, onClose: () => void) {
  const url = new URL(`${ORIGIN}/mcp/${projectId}`)
  const headers = { 'X-Paperish-Dir': process.cwd() }

  const forward: Forward = async (name, args) => {
    const client = new Client({ name: 'paperish-stdio', version: '0' })

    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
    } catch (e) {
      if (!(e instanceof TypeError)) throw e

      throw new Error(`Paperish isn't running at ${ORIGIN}. Open the Paperish app, then retry.`, {
        cause: e,
      })
    }

    try {
      return await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT })
    } finally {
      await client.close()
    }
  }

  // SAFETY: forwarded tools run in the app, so the proxy's handlers never touch a workspace.
  await createMcpServer(null as never, projectId, forward).connect(new StdioServerTransport())
  process.stdin.once('end', onClose)
}
