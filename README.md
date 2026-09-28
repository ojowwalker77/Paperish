# Paperish

A design canvas where every design is real HTML/CSS rendered by a browser, and where AI agents design alongside you over MCP. It's a clean-room take on the idea behind [Paper](https://paper.design).

```
agent (Claude Code, Cursor, …) ──MCP──▶ app (server) ──ws──▶ editor windows (you)
                                          │
                                          └──ws──▶ hidden windows (layout engine)
```

## Quick start

```bash
bun install            # or npm install
npm start              # builds the editor and opens the app
```

Paperish is an Electron app. The server runs in its main process on `http://127.0.0.1:29980`, and the editor is a window onto it. `npm run dist` builds the macOS app (`release/Paperish-<version>-arm64.dmg` and a zip for updates) with electron-builder; see [Releases](#releases). `npm start` builds the editor and opens the app on the production bundle, which is what you want for designing. `npm run dev` opens it on Vite with hot reload and React's development build, which is two to three times slower on big files; use it when working on Paperish itself.

## Projects

The app opens on your projects. **Add project…** picks a folder with the system dialog; inside a git repo it uses the repo's root. Adding one sets it up:
- **`design/`** holds the project's designs as `.paperish` files, plus `design/paperish.json` with the project's id. Commit both.
- **`.mcp.json`** gets a `paperish` entry pointing at `http://127.0.0.1:29980/mcp/<project id>`, so Claude Code in that repo connects to this project with no setup. Commit it and teammates who add the same repo get it too. Other entries in the file are left alone.
- **The codebase** is the project itself when it has a `package.json`, so its components work on the canvas.

**Scratch** is always there, for designs that don't belong to a repo. It lives in the app's data folder and agents reach it at `/mcp/scratch`.

Then ask the agent to design something ("make a pricing page for a note-taking app"). You'll see artboards fill in live, with an "Agent" indicator on the artboards it's touching.

The app keeps only the list of project folders (and caches) in its data folder: `data/` in development, the app's user-data folder when packaged, or `PAPERISH_DATA`.

## How it works

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

## Tailwind

`write_html` also accepts Tailwind classes (`class="flex gap-4 rounded-xl bg-white p-6"`). Classes are compiled with Tailwind v4 and resolved into inline styles, so the layers stay editable:
- With a linked codebase, its own CSS entry and `@theme` are used, so custom colors like `bg-brand-600` work.
- `sm:`/`md:`/`lg:` variants apply according to the artboard's width.
- `hover:`, `focus:`, `dark:` and child-targeting utilities (`space-y-*`) can't be inlined; `write_html` reports them.
- `get_jsx` maps theme values back to class names (`text-zinc-900`).

## Import a URL

`import_url` (or the globe button in the top bar) turns a live page into editable layers:
1. A hidden window with its own throwaway session loads the page, scrolls it to trigger lazy content, and removes cookie banners.
2. `src/server/import/extract.js` walks the rendered DOM, recording computed styles only where they differ from what the Paperish renderer would produce anyway.
3. Authored sizing comes from the site's stylesheets through the DevTools protocol (`CSS.getMatchedStylesForNode`): `%`, `max-width`, `auto` margins and `fr` tracks. This keeps imported layouts fluid rather than frozen at pixel sizes.
4. Images and web fonts (`@font-face` files) are downloaded into `data/assets`.
5. Pseudo-elements, inline SVG (with computed paints and `<use>` sprites resolved), tables and fixed headers are handled.

## Real components (React, Vue)

A project with a `package.json` at its root is its own codebase. In a monorepo, an agent can point a file at an app folder with `link_project`. Paperish then:
- **Discovers components and their props.** React is parsed from TypeScript: interfaces, inline types, shadcn-style `cva` variants, destructuring defaults. Vue comes from `defineProps` (typed, runtime or `withDefaults`).
- **Runs a component host inside the project** (`src/server/component-host.ts`). It's a Vite dev server using the project's own Vite, config, aliases and Tailwind; without a Vite config it falls back to the React/Vue plugins and tsconfig paths.
- **Renders each instance live in an isolated iframe** that sizes to its content. Props and children arrive over `postMessage`, HMR keeps instances current as you edit the code, and agent screenshots include them.

Agents use components by name in `write_html`, e.g. `<Button variant="outline">Save</Button>` or `<PricingCard plan="Pro" price={24} highlighted />`. Children can nest other components and HTML. `set_component_props` edits instances, and `get_jsx` emits the real `import` lines.

## Visual diff

`visual_diff` scores a design node against a reference: a live URL captured at the node's width, a local image, or another node (before/after). The comparison runs in the layout engine:
- **Colour delta:** a perceptual YIQ difference, as in pixelmatch.
- **Spatial tolerance:** 1px by default, so anti-aliasing and sub-pixel jitter don't count.
- **Vertical auto-alignment:** a design that sits a few px higher or lower doesn't light up every row.

It returns:
- **Content match:** the share of non-background pixels that agree.
- **Overall similarity.**
- **One image:** design | reference | heatmap side by side.
- **The largest differing regions**, mapped to the layers underneath.

Agents can iterate against the number: fix the layers named in the first regions, re-run, repeat.

## Designs in your repo

Every file is a `.paperish` file in the project's `design/` folder, e.g. `design/checkout.paperish`:
- **Every edit saves into it.** It's JSON written deterministically: nodes in tree order, one style per line, no timestamps. A git diff shows exactly which layers and properties changed.
- **Images and font files** are copied into `design/assets/`, named by content hash. Commit them with the file.
- **The linked codebase** is stored as a relative path, so a teammate who opens the file from their own clone gets the same components.
- **Outside changes reload the file**, e.g. `git checkout`, `pull`, `stash`, or a teammate's edit. If the file on disk can't be read (merge conflicts), Paperish stops saving to it until it's fixed, so it never overwrites your conflict.
- **The branch picker in the status bar** shows the branch and a dot for uncommitted changes. Its menu opens **Changes**: the file's commits, plus your uncommitted work, each rendered as a visual diff per artboard (side by side, swipe, or heatmap) with a content-match score.
- **Deleting a file** moves it to the system trash.

### Worktrees and branches

A repo has checkouts: the main one and any git worktrees, which is where agents mostly work. Each checkout has its own `design/` folder, so an agent's edits land in its worktree, on its branch.
- **The branch picker** switches between checkouts, and also shows branches that have no worktree as committed (read-only).
- **A project opens on the checkout an agent last worked in**, else the one with the newest design. When an agent edits a checkout you're not looking at, an "Agent in `<branch>`" pill takes you there.
- **Agents reach their own checkout.** The `.mcp.json` entry sends `X-Paperish-Dir: ${PWD}`, so a Claude Code session started inside a worktree targets that worktree. Worktrees made inside a session (`claude --worktree`, subagents) share the parent's MCP connection, so Paperish can't tell them apart from the header. For those, agents `open_file` the `.paperish` path under their working directory and pass its `fileId` (or `cwd` to `list_files`/`create_file`), as the tool descriptions and guide tell them. A call that names no file and no directory in a repo with several checkouts fails and asks for one, rather than guess and edit another agent's worktree.

For agents, `compare_revision` summarizes what changed since a revision ("HEAD", "main"), and `visual_diff` takes `reference.revision` for a single node.

## MCP tools

Names and argument shapes match Paper's MCP (captured in `reference/paper-tools.json`), so prompts and skills written for Paper work unchanged. Descriptions and the agent guide (`get_guide`) are our own.

| Area | Tools |
| --- | --- |
| Files | `list_files` `open_file` `create_file` `create_page` |
| Repo | `compare_revision` |
| Codebase | `link_project` `list_components` `set_component_props` |
| Import | `import_url` |
| Verify | `visual_diff` (against a URL, image, node or git revision) |
| Read | `get_basic_info` `get_selection` `get_node_info` `get_children` `get_tree_summary` `get_screenshot` `get_jsx` `get_computed_styles` `get_fill_image` `find_nodes` `get_font_family_info` `get_guide` |
| Write | `create_artboard` `write_html` `set_text_content` `update_styles` `rename_nodes` `duplicate_nodes` `move_nodes` `delete_nodes` `finish_working_on_nodes` |
| Tokens | `get_tokens` `create_tokens` `set_tokens` |
| Comments | `list_comment_threads` `get_comment_thread` `list_comment_thread_authors` `set_comment_thread_status` |
| Export | `export` (png, jpg, webp, pdf, svg via foreignObject) `export_combined_pdf` |

Extras beyond Paper:
- `write_html` returns the created subtree with real sizes, and flags zero-size nodes and artboard overflow.
- Grid and other CSS render as-is, because it's a real browser.

`npx tsx scripts/smoke.ts` drives the whole surface end to end, in Scratch (`PAPERISH_MCP` aims it at another project's endpoint). `npm run perf -- <fileId>` drives the editor with real input (wheel pan, pinch zoom, hover, drag, edits, selection) and reports main-thread cost per interaction; point it at a large file and at `PAPERISH_URL` for a production server.

## Editor

| Keys | Action |
| --- | --- |
| `V` / `F` / `T` / `H` | Move, frame, text and hand tools |
| Space + drag, scroll | Pan |
| ⌘ + scroll, pinch | Zoom |
| ⇧1 / ⇧2 | Fit all / fit selection |
| Double-click | Drill into a layer; on text, edit it |
| Enter / Esc | Select children / parent |
| ⌘-click | Select the deepest layer |
| ⌘D, ⌫, arrows | Duplicate, delete, nudge |
| ⌘Z / ⇧⌘Z | Undo / redo, shared with the agent |
| ⌘C / ⌘V | Copy as HTML; paste any HTML to turn it into layers |
| ⌘\ | Hide / show both side panels (each also has a toggle in the top bar) |
| P | Preview the selected artboard as a full page UI (Fit / 100% / Responsive, ← → between artboards, Esc to close). "Open in new tab" gives a live standalone URL (`/?file=…&view=…`) |

**Device previews.** Responsive mode can render the frame inside a phone shell at that device's CSS viewport, so layouts reflow as they would on the phone:

| Device | Viewport | Notes |
| --- | --- | --- |
| iPhone 18 Pro | 402 × 874 @3x | Smaller Dynamic Island (size estimated) |
| iPhone 17 | 402 × 874 @3x | |
| iPhone Duo | 466 × 678 folded, 890 × 626 open | Fold/Open toggle, hole-punch outside, crease inside. Apple hasn't published browser values; these assume @3x |

Each shell has:
- a status bar whose icons switch between light and dark to match the page under them
- a home indicator, or the iOS 26 Safari Liquid Glass bar (the "Safari" toggle)
- side buttons, and the finishes of each model

The frame design is adapted from [liquidframe](https://github.com/CVERInc/liquidframe) (MIT); see `THIRD_PARTY_NOTICES.md`.

The inspector edits common properties, or the node's full CSS directly. It can also copy the selection as Tailwind JSX, inline-style JSX, or HTML.

## Releases

`npm run dist` bundles the main process with Bun (`out/main.js`), builds the editor (`dist/`), and packages both with electron-builder (config in `package.json` under `build`):
- **Signing** uses the best identity in the keychain. A build others can open needs a **Developer ID Application** certificate; with only Apple Development, the app runs on the machine that built it.
- **Notarization** runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (or an App Store Connect API key) are set.
- **Updates**: the packaged app checks GitHub releases of this repo with electron-updater and installs new versions on quit. `electron-builder --publish always` (with `GH_TOKEN`) uploads the DMG, the zip and `latest-mac.yml`. The updater can only read releases of a public repo.
- **arm64 only** for now: the native modules (lightningcss, rolldown) are installed for the building machine, so an Intel build has to be made on (or with dependencies for) x64.

## Security

- The server binds to `127.0.0.1` only.
- The MCP endpoint has DNS-rebinding protection, and websocket upgrades check `Origin`.
- Inline SVG is stripped of scripts, event handlers and `javascript:` URLs.
- Documents never reference arbitrary local paths: local images are copied into the asset cache and served by hash.

## Not yet

- Components from Next.js-only APIs (`next/image`, server components) and non-Vite toolchains are best effort
- Comment UI (the data model and tools exist)
- Drag-to-reorder inside flex layouts and in the layer tree
- Snapping and rulers
- Components and instances
- Multiplayer presence
- Video and AVIF export
- Intel (x64) builds
- A stdio MCP proxy (so tools are listed before the app starts)
