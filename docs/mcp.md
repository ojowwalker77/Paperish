# MCP

## Tools

Names and argument shapes match Paper's MCP, so prompts and skills written for Paper work unchanged. Descriptions and the agent guide (`get_guide`) are our own.

| Area | Tools |
| --- | --- |
| Files | `list_files` `open_file` `create_file` `create_page` |
| Repo | `compare_revision` |
| Codebase | `link_project` `list_components` `set_component_props` |
| Import | `import_url` |
| Verify | `visual_diff` (against a URL, image, node or git revision), `lint_design` (against the repo's DESIGN.md) |
| Read | `get_basic_info` `get_selection` `get_node_info` `get_children` `get_tree_summary` `get_screenshot` `get_jsx` `get_computed_styles` `get_fill_image` `find_nodes` `get_font_family_info` `get_guide` |
| Write | `create_artboard` `write_html` `set_text_content` `update_styles` `rename_nodes` `duplicate_nodes` `move_nodes` `delete_nodes` `finish_working_on_nodes` |
| Tokens | `get_tokens` `create_tokens` `set_tokens` |
| Pick | `propose_options` `wait_for_pick` |
| Comments | `list_comment_threads` `get_comment_thread` `list_comment_thread_authors` `set_comment_thread_status` `reply_to_comment_thread` `create_comment_thread` |
| Export | `export` (png, jpg, webp, pdf, svg via foreignObject) `export_combined_pdf` |

Extras beyond Paper:
- `write_html` returns the created subtree with real sizes, and flags zero-size nodes and artboard overflow.
- Grid and other CSS render as-is, because it's a real browser.

## Stdio

The `.mcp.json` entry is HTTP, so an agent started while the app is closed can't connect and sees no tools. The app also runs as a stdio MCP server: it lists the tools straight away and forwards each call to the running app, or answers that Paperish isn't running.

```bash
# macOS
claude mcp add paperish -- /Applications/Paperish.app/Contents/MacOS/Paperish --mcp <project id>
# Linux (.deb)
claude mcp add paperish -- paperish --mcp <project id>
# From source
claude mcp add paperish -- /path/to/paperish/node_modules/.bin/electron /path/to/paperish --mcp <project id>
```

- The project id is the `id` in `design/paperish.json`. Leave it out for Scratch.
- Calls act on the checkout the agent was started in, like the HTTP entry.
- `claude mcp add` writes a local entry, which Claude Code prefers over the repo's `.mcp.json`.
- Agents started from an Electron editor (VS Code, Cursor) can inherit `ELECTRON_RUN_AS_NODE`. Set it to an empty string in the server's `env`.

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
- **Runs Next.js and Create React App components too.** Without a Vite config, `next/*` imports get browser stand-ins (`next/image` renders an `<img>`, `next/link` an `<a>`, `next/font/google` loads the font, router hooks return `/`), async server components are awaited, JSX in `.js` files compiles, and `NEXT_PUBLIC_*` / `REACT_APP_*` come from `.env` (`src/server/framework-shims.ts`). Server-only code (databases, secrets) still can't run in the browser.
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

## Picking between options

Agents don't guess on taste. For a call that's yours to make (layout, density, emphasis, tone), the agent builds 2 to 4 alternatives as artboards and calls `propose_options` with a question. Paperish frames them, labels them A to D, and shows the question in a bar at the bottom: press a letter (or click), optionally with a note, or answer None. `wait_for_pick` returns your answer to the agent; the picked artboard takes the first option's place and the others are removed, in one undo step. The agent guide tells agents to propose this way, and to record choices that settle the design system in DESIGN.md.
