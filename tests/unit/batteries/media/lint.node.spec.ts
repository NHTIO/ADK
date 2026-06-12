import { RuleTester } from '@typescript-eslint/rule-tester'
import { describe, test, afterAll, beforeAll } from 'vitest'
import { rules, setPeerResolverForTesting } from '../../../../src/batteries/media/lint'

// Bind RuleTester's lifecycle hooks to vitest (RuleTester defaults to mocha-style globals).
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const ruleTester = new RuleTester()

ruleTester.run('prefer-engine-resolver', rules['prefer-engine-resolver'], {
  valid: [
    // The canonical form: dynamic import inside a resolver.
    {
      code: `const mp = await createMediaPipeline({ engines: [() => import('@nhtio/adk/batteries/media/engines/jimp').then((m) => m.jimpEngine())] })`,
    },
    // Type-only imports are fine.
    {
      code: `import type { JimpEngineOptions } from '@nhtio/adk/batteries/media/engines/jimp'`,
    },
    {
      code: `import { type JimpEngineOptions } from '@nhtio/adk/batteries/media/engines/jimp'`,
    },
    // Non-engine battery subpaths are out of scope.
    { code: `import { createMediaPipeline } from '@nhtio/adk/batteries/media'` },
  ],
  invalid: [
    {
      code: `import { jimpEngine } from '@nhtio/adk/batteries/media/engines/jimp'`,
      errors: [{ messageId: 'preferResolver' }],
    },
    {
      code: `import { sofficeEngine } from '@nhtio/adk/batteries/media/engines/soffice'`,
      errors: [{ messageId: 'preferResolver' }],
    },
  ],
})

ruleTester.run('no-shadowed-engine', rules['no-shadowed-engine'], {
  valid: [
    // Narrow before broad: jimp can win png dispatches before sharp takes the rest.
    {
      code: `createMediaPipeline({ engines: [() => import('x').then((m) => m.jimpEngine()), () => import('y').then((m) => m.sharpEngine())] })`,
    },
    // Sharp before jimp is ALSO legal: jimp uniquely encodes bmp, which sharp does not
    // declare — so jimp is reachable for `format to=bmp` dispatches. (The drift test
    // against the live factories is what keeps this case honest.)
    {
      code: `createMediaPipeline({ engines: [sharpEngine(), jimpEngine()] })`,
    },
    // Unknown elements (identifiers, spreads) are not analyzable — no false positives.
    { code: `createMediaPipeline({ engines: [myEngine, sharpEngine()] })` },
    // Different capability kinds don't shadow.
    {
      code: `createMediaPipeline({ engines: [sharpEngine(), { id: 'ocr', converts: [{ from: ['image/*'], to: ['txt'], convert: async () => ({ outputs: [] }) }] }] })`,
    },
    // Single engine: nothing to shadow.
    { code: `createMediaPipeline({ engines: [jimpEngine()] })` },
  ],
  invalid: [
    // A literal engine entirely covered by an earlier bundled factory: sharp's image/*
    // mutate (all four ops, webp encode) subsumes this narrow webp-only resizer.
    {
      code: `createMediaPipeline({ engines: [
        sharpEngine(),
        { id: 'tiny', mutates: [{ over: ['image/webp'], ops: ['resize'], encodes: ['webp'], mutate: async () => ({}) }] },
      ] })`,
      errors: [{ messageId: 'shadowed' }],
    },
    // Same through the resolver form of the earlier engine.
    {
      code: `createMediaPipeline({ engines: [
        () => import('y').then((m) => m.sharpEngine()),
        { id: 'tiny', mutates: [{ over: ['image/png'], ops: ['rotate'], encodes: ['png'], mutate: async () => ({}) }] },
      ] })`,
      errors: [{ messageId: 'shadowed' }],
    },
    // Literal inline engine shadowed by an earlier broader literal.
    {
      code: `createMediaPipeline({ engines: [
        { id: 'broad', converts: [{ from: ['application/pdf'], to: ['txt', 'html'], convert: async () => ({ outputs: [] }) }] },
        { id: 'narrow', converts: [{ from: ['application/pdf'], to: ['txt'], convert: async () => ({ outputs: [] }) }] },
      ] })`,
      errors: [{ messageId: 'shadowed' }],
    },
  ],
})

// require-engine-peers asks Node whether a peer resolves. The spec injects a deterministic
// resolver instead — `jimp`/`xlsx` "installed", `@huggingface/transformers` "missing" — so the
// rule is tested independent of the test runner's real node_modules layout.
const INSTALLED = new Set(['jimp', 'xlsx', 'exceljs', 'js-yaml', 'papaparse', 'execa'])
beforeAll(() => {
  setPeerResolverForTesting((peer) => INSTALLED.has(peer))
})
afterAll(() => {
  setPeerResolverForTesting()
})

ruleTester.run('require-engine-peers', rules['require-engine-peers'], {
  valid: [
    // jimp engine referenced, `jimp` "installed" → fine.
    {
      code: `const mp = createMediaPipeline({ engines: [() => import('@nhtio/adk/batteries/media/engines/jimp').then((m) => m.jimpEngine())] })`,
    },
    // sheetjs referenced, `xlsx` "installed" → fine.
    {
      code: `import { sheetjsEngine } from '@nhtio/adk/batteries/media/engines/sheetjs'`,
    },
    // soffice has no external peer — nothing to resolve, nothing to report.
    {
      code: `const mp = createMediaPipeline({ engines: [() => import('@nhtio/adk/batteries/media/engines/soffice').then((m) => m.sofficeEngine(opts))] })`,
    },
    // Non-engine subpaths are out of scope.
    {
      code: `import { createMediaPipeline } from '@nhtio/adk/batteries/media'`,
    },
    // The missing peer, explicitly ignored, is silent.
    {
      code: `const mp = createMediaPipeline({ engines: [() => import('@nhtio/adk/batteries/media/engines/transformers_asr').then((m) => m.transformersAsrEngine({ model }))] })`,
      options: [{ ignore: ['@huggingface/transformers'] }],
    },
  ],
  invalid: [
    // transformers_asr referenced, but its peer is "not installed".
    {
      code: `const mp = createMediaPipeline({ engines: [() => import('@nhtio/adk/batteries/media/engines/transformers_asr').then((m) => m.transformersAsrEngine({ model }))] })`,
      errors: [{ messageId: 'missingPeer' }],
    },
    // Same engine via a static import — still caught.
    {
      code: `import { transformersAsrEngine } from '@nhtio/adk/batteries/media/engines/transformers_asr'`,
      errors: [{ messageId: 'missingPeer' }],
    },
  ],
})

ruleTester.run('augment-contracts-module', rules['augment-contracts-module'], {
  valid: [
    // The correct target.
    {
      code: `declare module '@nhtio/adk/batteries/media/contracts' { interface ConvertOptions { watermark?: { text: string } } }`,
    },
    // Relative specifiers that still end at the contracts module (in-repo usage).
    {
      code: `declare module '../../../../src/batteries/media/contracts' { interface ConvertOptions { x?: number } }`,
    },
    // Unrelated augmentations are out of scope.
    {
      code: `declare module 'express' { interface Request { user?: unknown } }`,
    },
    // Augmenting something else on an adk module is out of scope for this rule.
    {
      code: `declare module '@nhtio/adk/batteries/media' { interface SomethingElse { x?: 1 } }`,
    },
  ],
  invalid: [
    // The classic mistake: targeting the barrel.
    {
      code: `declare module '@nhtio/adk/batteries/media' { interface ConvertOptions { watermark?: { text: string } } }`,
      errors: [{ messageId: 'wrongModule' }],
    },
    // Targeting the root.
    {
      code: `declare module '@nhtio/adk' { interface ConvertOptions { watermark?: { text: string } } }`,
      errors: [{ messageId: 'wrongModule' }],
    },
  ],
})
