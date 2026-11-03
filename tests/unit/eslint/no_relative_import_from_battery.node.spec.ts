import { join } from 'node:path'
import { RuleTester } from 'eslint'
import { describe, test } from 'vitest'
import { parser as tsParser } from 'typescript-eslint'
// @ts-expect-error — untyped .mjs rule module; it's a plain ESLint rule object ({ meta, create }),
// not TS-compiled, so there's no declaration file (mirrors the existing untyped-.mjs-import
// pattern in tests/unit/eslint/repo_rules.node.spec.ts).
import { default as noRelativeImportFromBattery } from '../../../eslint-rules/rules/no-relative-import-from-battery.mjs'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals; unlike
// `@typescript-eslint/rule-tester`, the plain `eslint` package's RuleTester only exposes
// `describe`/`it`/`itOnly`, no `afterAll`).
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

// The rule sees `import type` / `export type` in real battery sources, so the fixtures are parsed
// with the TypeScript parser rather than plain espree.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

// The rule lints by resolving specifiers against the linted file's own path, so every test case
// pins a fake filename inside a battery. `join` keeps the fixtures absolute and host-native, the
// way ESLint hands `context.filename` to the rule.
const BATTERY_ROOT = join(process.cwd(), 'src', 'batteries')
const inBattery = (...segments: string[]) => join(BATTERY_ROOT, ...segments)

ruleTester.run('no-relative-import-from-battery', noRelativeImportFromBattery, {
  valid: [
    // ── Intra-battery relative imports stay relative ────────────────────────────────────────
    {
      // A `./` sibling inside the same battery.
      filename: inBattery('sandbox', 'tool.ts'),
      code: "import { runToolGate } from './tool_gate'",
    },
    {
      // A `../` walk that stays within the same battery directory.
      filename: inBattery('sandbox', 'node', 'srt_enforcer.ts'),
      code: "import { Tool } from '../tool'",
    },
    {
      // A deeply nested file walking up only as far as its own battery root.
      filename: inBattery('llm', 'transformers_js', 'layers', 'decoder.ts'),
      code: "import { withModelSource } from '../../model_source'",
    },
    {
      // A relative EXPORT also stays legal when it re-exports a same-battery module.
      filename: inBattery('sandbox', 'index.ts'),
      code: "export * from './types'",
    },
    {
      // …including a named re-export.
      filename: inBattery('sandbox', 'js', 'index.ts'),
      code: "export { createGuestRunner } from './runner'",
    },
    {
      // The exemption: the top-level aggregator barrel sits above every battery.
      filename: inBattery('index.ts'),
      code: "export * from './llm'\nexport * from './tools'",
    },

    // ── Public-barrel imports never need a relative escape ──────────────────────────────────
    {
      filename: inBattery('sandbox', 'executor.ts'),
      code: "import type { BinaryExecutor } from '@nhtio/adk/batteries/media'",
    },
    {
      filename: inBattery('skills', 'types.ts'),
      code: "import type { DispatchContext } from '@nhtio/adk/types'",
    },
    {
      filename: inBattery('llm', 'ollama', 'adapter.ts'),
      code: "import { canonicalStringify } from '@nhtio/adk'",
    },
    {
      filename: inBattery('dev_tools', 'index.ts'),
      code: "import { runOnion } from '@nhtio/adk/lib/middleware/run_onion'",
    },
    {
      // …including dynamic import and require of a public barrel.
      filename: inBattery('media', 'steps', 'loader.ts'),
      code: "const engine = await import('@nhtio/adk/batteries/media')",
    },
    {
      filename: inBattery('sandbox', 'loader.ts'),
      code: 'const sibling = await import(`./sibling`)',
    },
    {
      filename: inBattery('sandbox', 'loader.ts'),
      code: 'const sibling = await import(`../${name}`)',
    },
    {
      filename: inBattery('validation', 'middleware.ts'),
      code: "const { ENCODE_METHOD } = require('@nhtio/adk/common')",
    },

    // ── Files outside any battery are out of scope ──────────────────────────────────────────
    {
      filename: join(process.cwd(), 'src', 'lib', 'utils', 'retry.ts'),
      code: "import { isObject } from '../../guards'",
    },
    {
      filename: join(process.cwd(), 'src', 'common.ts'),
      code: "export { encodeBase64 } from './lib/helpers/base64'",
    },
  ],
  invalid: [
    // ── A relative specifier resolving OUTSIDE the battery is the core violation ────────────
    {
      // A sibling battery's internals.
      filename: inBattery('sandbox', 'executor.ts'),
      code: "import type { BinaryExecutor } from '../media/contracts'",
      errors: [
        {
          messageId: 'publicBarrelOnly',
          data: { source: '../media/contracts', battery: 'sandbox' },
        },
      ],
    },
    {
      // …even type-only: the boundary is an import-surface rule, not a runtime one.
      filename: inBattery('skills', 'types.ts'),
      code: "import type { SandboxHandle } from '../sandbox/manager'",
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // A deep walk into the private src/lib tree.
      filename: inBattery('llm', 'ollama', 'adapter.ts'),
      code: "import { retry } from '../../../lib/utils/retry'",
      errors: [
        {
          messageId: 'publicBarrelOnly',
          data: { source: '../../../lib/utils/retry', battery: 'llm' },
        },
      ],
    },
    {
      // The harness root barrels are outside every battery too.
      filename: inBattery('generation', 'local_diffusion', 'adapter.ts'),
      code: "import { encodeBase64 } from '../../common'",
      errors: [
        { messageId: 'publicBarrelOnly', data: { source: '../../common', battery: 'generation' } },
      ],
    },
    {
      // An export escaping the battery is just as illegal as an import.
      filename: inBattery('sandbox', 'validation.ts'),
      code: "export { validateOrThrow } from '../../lib/utils/validation'",
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // A `export type` re-export counts the same way.
      filename: inBattery('skills', 'contracts.ts'),
      code: "export type { GuestRuntimeLike } from '../sandbox/js/ses_contracts'",
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // Statically known template literals are relative specifiers too.
      filename: inBattery('dev_tools', 'runtime.ts'),
      code: 'const patch = await import(`../../lib/x`)',
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      filename: inBattery('media', 'runtime.ts'),
      code: 'const module = require(`../sandbox/y`)',
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // Dynamic import() crosses the boundary just the same.
      filename: inBattery('dev_tools', 'runtime.ts'),
      code: "const patch = await import('../../lib/patch')",
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // require() too (CJS interop shims).
      filename: inBattery('media', 'engines', 'execa_executor.ts'),
      code: "const { execa } = require('../../lib/patch')",
      errors: [{ messageId: 'publicBarrelOnly' }],
    },
    {
      // Two escapes in one file both report, each pinned to its own specifier.
      filename: inBattery('orchestration', 'validation.ts'),
      code: [
        "import { isInstanceOf } from '../../lib/utils/guards'",
        "const retry = require('../llm/chat_common/retry')",
      ].join('\n'),
      errors: [{ messageId: 'publicBarrelOnly' }, { messageId: 'publicBarrelOnly' }],
    },
  ],
})
