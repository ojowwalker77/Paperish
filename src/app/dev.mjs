// Runs the TypeScript main process straight from source (npm run app).
import { register } from 'tsx/esm/api'

register()
// Not awaited: Electron holds 'ready' until the entry module finishes evaluating.
void import('./main.ts')
