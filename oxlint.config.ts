import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: [
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
    'tools/oxlint/anti-slop/**',
    'dist/**',
    'out/**',
    'release/**',
    'build/**',
    'smoke-out/**',
    'node_modules/**',
  ],
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'error',
  },
  rules: {
    // Sequential awaits are intentional: MCP tool calls, browser automation,
    // importer passes, and perf measurements must run in order.
    'eslint/no-await-in-loop': 'allow',
    // `window.__paperish*` globals and `_`-prefixed throwaway params are conventions.
    'eslint/no-underscore-dangle': [
      'error',
      {
        allow: [
          '__paperish',
          '__store',
          '__tokens',
          '__engine',
          '__texts',
          '__frames',
          '__raf',
          '__lofs',
          '_fs',
        ],
      },
    ],
    'eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'oxc/no-accumulating-spread': 'error',
    'anti-slop/no-array-filter-map': 'error',
    'anti-slop/no-reduce-accumulator-copy': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-readable-spacing': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
  },
  overrides: [
    {
      files: ['src/app/host.ts', 'src/server/host.ts'],
      rules: {
        // Electron's utility process ports, not window.postMessage: there's no target origin.
        'unicorn/require-post-message-target-origin': 'allow',
      },
    },
    {
      files: ['src/server/import/extract.js'],
      rules: {
        // Single self-contained page function: the importer extracts and evals
        // it in the target page, so helpers cannot move to module scope.
        'unicorn/consistent-function-scoping': 'allow',
      },
    },
  ],
})
