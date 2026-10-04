# Development

`npm start` builds the editor and opens the app on the production bundle, which is what you want for designing. `npm run dev` opens it on Vite with hot reload and React's development build, which is two to three times slower on big files; use it when working on Paperish itself.

The app keeps only the list of project folders (and caches) in its data folder: `data/` in development, the app's user-data folder when packaged, or `PAPERISH_DATA`.

Run `./scripts/checks` before committing: typecheck, lint, format, knip, audit and build.

`npx tsx scripts/smoke.ts` drives the whole MCP surface end to end, in Scratch (`PAPERISH_MCP` aims it at another project's endpoint). `npm run perf -- <fileId>` drives the editor with real input (wheel pan, pinch zoom, hover, drag, edits, selection) and reports main-thread cost per interaction; point it at a large file and at `PAPERISH_URL` for a production server.

## Releases

`npm run dist` bundles the main process with Bun (`out/main.js`), builds the editor (`dist/`), and packages both with electron-builder (config in `package.json` under `build`):
- **Signing** uses the best identity in the keychain. A build others can open needs a **Developer ID Application** certificate; with only Apple Development, the app runs on the machine that built it.
- **Notarization** runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (or an App Store Connect API key) are set.
- **Updates**: the packaged app checks GitHub releases of this repo with electron-updater and installs new versions on quit. `electron-builder --publish always` (with `GH_TOKEN`) uploads the DMG, the zip and `latest-mac.yml`. The updater can only read releases of a public repo.
- **macOS is arm64 only** for now: the native modules (lightningcss, rolldown) are installed for the building machine, so an Intel build has to be made on (or with dependencies for) x64.
- **macOS** (arm64 dmg and zip) and **Linux** (x64 AppImage and `.deb`) are built and published by `.github/workflows/release.yml` when a `v*` tag is pushed. The macOS dmg, its zip and the AppImage update themselves; the `.deb` doesn't.

## Not yet

- Drag-to-reorder inside flex layouts and in the layer tree
- Snapping and rulers
- Components and instances
- Multiplayer presence
- Video and AVIF export
- Intel (x64) builds
