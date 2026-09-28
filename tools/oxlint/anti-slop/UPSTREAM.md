# UPSTREAM.md — vendored anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (main, 2026-09-28)
- Installed: `tools/oxlint/anti-slop/` (full `src/` copy: `index.ts`, `rules/`, `effect/`, `shared/`, `vendor/`)
- Includes vendored third-party code: `vendor/eslint-stylistic/` (MIT, see `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`)
- Deviations: none. Local policy lives in the root `oxlint.config.ts`, not in this directory.
- The Effect plugin (`effect/`) is vendored but not registered: this repo has no direct `effect` dependency.
