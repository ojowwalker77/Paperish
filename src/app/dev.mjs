// Runs the TypeScript main process, and the server's utility process, straight from source (npm run app).
import { register } from 'tsx/esm/api'

register()

// Not awaited: Electron holds 'ready' until the entry module finishes evaluating.
void import(process.parentPort ? './server.ts' : './main.ts')
