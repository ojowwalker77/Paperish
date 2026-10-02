import { ORIGIN, PORT } from '../server/config'
import { onMain, post } from '../server/host'

// The server's own process, forked by the app (./host.ts), so its work never
// holds up input in the app's windows.

try {
  const server = await import('../server/index')
  await server.listening
  onMain((msg) => {
    if (msg.t === 'stop') void server.shutdown().finally(() => process.exit(0))
  })
  post({ t: 'ready', origin: ORIGIN })
} catch (e) {
  // SAFETY: caught from server listen; ErrnoException carries code when the port is busy.
  const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE'

  post({
    t: 'failed',
    // SAFETY: caught from server startup; Error carries the failure message.
    message: busy
      ? `Port ${PORT} is already in use. Is another Paperish running?`
      : (e as Error).message,
  })
}
