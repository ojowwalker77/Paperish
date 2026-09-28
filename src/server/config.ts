import path from 'node:path'
import { app } from 'electron'

/** The app's own files: the repo in development, app.asar when packaged. */
export const ROOT_DIR = app.getAppPath()

export const PORT = Number(process.env.PAPERISH_PORT ?? 29980)

export const HOST = '127.0.0.1'

export const ORIGIN = `http://${HOST}:${PORT}`

/** App state: the project list, Scratch, and caches. Designs themselves live in each project's repo. */
const DATA_DIR = path.resolve(
  process.env.PAPERISH_DATA ??
    (app.isPackaged ? app.getPath('userData') : path.join(ROOT_DIR, 'data')),
)

export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')

/** The Scratch project: designs that don't belong to a repo. */
export const SCRATCH_DIR = path.join(DATA_DIR, 'scratch')

/** Content-addressed images and fonts served as /media/<hash>; each project keeps its own copy in design/assets. */
export const ASSETS_DIR = path.join(DATA_DIR, 'assets')

export const EXPORTS_DIR = path.join(DATA_DIR, 'exports')

export const CACHE_DIR = path.join(DATA_DIR, 'cache')

/** Serve the built editor (dist/) rather than Vite's dev server. */
export const IS_PROD = app.isPackaged || process.env.NODE_ENV === 'production'
