# Architecture

**Document model** (`src/shared`). A file is a flat map of nodes (`Frame`, `Text`, `Image`, `SVG`) under one `Root` per page. Styles are stored as camelCase CSS (the same shape as `React.CSSProperties`), so there's no translation layer between the model and the browser. Top-level nodes are artboards placed with `left`/`top`. Every change is an `Op` (`insert`, `delete`, `styles`, `patch`, `move`, …) applied with structural sharing, and each op produces its inverse for undo.

**Server** (`src/server`). This process owns the documents. It applies transactions from editors and agents, keeps a shared undo stack, saves each document into its `.paperish` file, and broadcasts ops over `/ws`. It also serves the Paper-compatible MCP endpoint, `/mcp/<project id>` per project, on the v2 TypeScript SDK: the 2026-07-28 protocol revision (stateless, per-request envelope), with stateless fallback for clients still on the 2025 `initialize` handshake.

**Renderer** (`src/web/render`). Each node renders as a real DOM element with inline styles inside a pan/zoom camera. A preflight-style reset keeps UA styles from leaking in, and Google Fonts load on demand.

**Layout engine** (`src/server/engine.ts`, `src/web/engine.tsx`). A hidden window of the app's own Chromium runs the same renderer and follows the document over the same websocket. `src/server/browser.ts` drives it through the DevTools protocol (`webContents.debugger`). Anything that needs layout goes through it: sizes, world positions, computed styles, `find_nodes`, overflow checks, screenshots (CDP `Page.captureScreenshot` with a clip and scale), and PDF export. Agents get pixel-accurate answers whatever the editor windows are showing.

**HTML → nodes** (`src/server/html.ts`). `write_html` parses agent HTML with htmlparser2:
- Elements that contain only text and inline phrasing become `Text`.
- Containers become `Frame`.
- `<img>` becomes `Image`, and local `paper-asset:///abs/path` files are copied into content-addressed `data/assets`.
- `<svg>` becomes a sanitized `SVG`.
- `<x-paper-clone node-id>` deep-clones an existing layer.
- `layer-name` names layers.

**Export** (`src/server/serialize.ts`, `src/shared/html.ts`). The tree serializes to JSX (Tailwind v4 classes with arbitrary-value fallback, or inline styles) and to static HTML (for PDF/SVG export and for copy/paste).

## Security

- The server binds to `127.0.0.1` only.
- The MCP endpoint has DNS-rebinding protection, and websocket upgrades check `Origin`.
- Inline SVG is stripped of scripts, event handlers and `javascript:` URLs.
- Documents never reference arbitrary local paths: local images are copied into the asset cache and served by hash.
