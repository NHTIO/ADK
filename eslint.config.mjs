import { configure } from '@nhtio/eslint-config'
import { default as adk } from './eslint-rules/index.mjs'

export default [
  ...configure({
    ignores: [
      '**/docs/api/**/*',
      '**/tsconfig.json',
      '**/docs/**/*.md',
      '**/README.md',
      '**/tmp/**/*',
      // Generated static assets served by VitePress — includes the multi-MB
      // precompiled ADK REPL bundle (docs/public/repl/adk-repl.es.js). Never lint
      // targets, and large enough to crash eslint's parser.
      '**/docs/public/**/*',
    ],
  }),
  {
    plugins: { adk },
  },
  {
    // Guard policies apply repo-wide. Carve-outs are declared inline via
    // `// eslint-disable-next-line adk/<rule> -- <reason>` at each exempt site.
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      'adk/use-is-instance-of': 'error',
      'adk/prefer-is-object': 'error',
      'adk/prefer-is-error': 'error',
    },
  },
  {
    // Functional tests exercise the *public* import surface only. Reaching into `src/lib/`
    // bypasses the barrel boundary — if a symbol is needed in a functional test, it must be
    // exported from a public barrel (`@nhtio/adk/*`). Internal-only primitives stay in unit
    // tests.
    files: ['tests/functional/**/*.{ts,tsx,mts}'],
    rules: {
      'adk/no-src-lib-import-from-functional-tests': 'error',
    },
  },
  {
    // Cross-env specs (*.cross.spec.ts) run in BOTH the node and browser projects. They must
    // not import from `node:*` — if they need filesystem / streams / etc., they belong in a
    // `*.node.spec.ts`. Browser-only specs (*.browser.spec.ts) are also forbidden from
    // pulling in node: builtins for symmetry.
    files: ['tests/**/*.cross.spec.ts', 'tests/**/*.browser.spec.ts'],
    rules: {
      'adk/no-node-builtin-from-cross-or-browser-spec': 'error',
    },
  },
]
