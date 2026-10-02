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

Paperish is an Electron app. The server runs in its main process on `http://127.0.0.1:29980`, and the editor is a window onto it.

## Projects

The app opens on your projects. **Add project…** picks a folder with the system dialog; inside a git repo it uses the repo's root. Adding one sets it up:
- **`design/`** holds the project's designs as `.paperish` files, plus `design/paperish.json` with the project's id. Commit both.
- **`.mcp.json`** gets a `paperish` entry pointing at `http://127.0.0.1:29980/mcp/<project id>`, so Claude Code in that repo connects to this project with no setup. Commit it and teammates who add the same repo get it too. Other entries in the file are left alone.
- **The codebase** is the project itself when it has a `package.json`, so its components work on the canvas.

**Scratch** is always there, for designs that don't belong to a repo. It lives in the app's data folder and agents reach it at `/mcp/scratch`.

Then ask the agent to design something ("make a pricing page for a note-taking app"). You'll see artboards fill in live, with an "Agent" indicator on the artboards it's touching.

## Docs

- [MCP](docs/mcp.md): MCP tools, Tailwind, URL import, real React/Vue components, visual diff, picking between options
- [Design checks](docs/design-checks.md): linting designs against the repo's DESIGN.md and Tailwind theme
- [Designs in your repo](docs/git.md): `.paperish` files, branches and worktrees
- [Editor](docs/editor.md): shortcuts, device previews, comments
- [Architecture](docs/architecture.md): document model, server, renderer, layout engine, security
- [Development](docs/development.md): dev builds, checks, releases, what's not done yet

## License

[Apache-2.0](LICENSE). Copies and forks must keep the [NOTICE](NOTICE) file and credit the original project.
