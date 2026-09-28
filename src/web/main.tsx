import { createRoot } from 'react-dom/client'
import { EngineApp, installEngine } from './engine'
import { StandaloneViewer } from './Viewer'
import { loadIndex } from './render/fonts'
import { ENGINE_MODE, store, VIEW_NODE } from './store'
import { Editor } from './editor/Editor'
import './styles.css'

const fileId = new URLSearchParams(location.search).get('file')

// Inside the desktop app the top bar doubles as the window's title bar.
if (navigator.userAgent.includes('Electron'))
  document.documentElement.classList.add(
    'app',
    /Mac/.test(navigator.platform) ? 'app-mac' : 'app-other',
  )

await loadIndex()

store.connect(fileId)

if (ENGINE_MODE) {
  document.documentElement.classList.add('engine')
  installEngine()
  createRoot(document.getElementById('app')!).render(<EngineApp />)
} else if (VIEW_NODE) {
  createRoot(document.getElementById('app')!).render(<StandaloneViewer />)
} else {
  createRoot(document.getElementById('app')!).render(<Editor />)
}
