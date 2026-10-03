import { execa } from 'execa'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'

/**
 * Issue #46: the published `dist/` inlined a SECOND copy of `@anthropic-ai/sdk/core/error` while the
 * adapter imported the REAL `@anthropic-ai/sdk` client — two identities for one class. The classifier
 * narrowed against the inlined copy, so every real HTTP error (429/502/503/504/529) was `fatal` with
 * status `0`, `retry` never ran, and `Retry-After` was never read.
 *
 * This test runs against the REAL BUILT `dist/`, not `src/`. That is load-bearing: under vitest the
 * source aliases resolve both imports to the same module, so a src-level test CANNOT observe the
 * identity split and would pass against the broken code (verified: restoring the old src file left the
 * src-level suite green). The bug only exists in the bundler's output, so the assertion lives there.
 *
 * Two things are checked:
 *  1. The published output does NOT inline the SDK's error classes — no `.mjs`/`.cjs` under `dist/`
 *     contains the SDK error source region while also being imported by a module that imports the SDK.
 *  2. The BUILT classifier correctly classifies real SDK-thrown errors, driven by a real client in a
 *     separate plain-Node process importing `dist/` (not vitest's SSR transform).
 *
 * `TEST_REQUIRE_DIST=1` turns a missing `dist/` into a hard failure rather than a quiet skip — same
 * convention as `cjs_entries_load.node.spec.ts` and `claude_code_cli_wrapper_resolves.node.spec.ts`.
 */
const distDir = resolve(__dirname, '../../../dist')
const adapterMjsPath = resolve(distDir, 'batteries/llm/anthropic_messages/adapter.mjs')
const distBuilt = existsSync(adapterMjsPath) && existsSync(resolve(distDir, 'package.json'))
const shouldSkip = !distBuilt && process.env.TEST_REQUIRE_DIST !== '1'

/** Every `dist/**``.mjs`/`.cjs` file, found by walking. */
const collectBundles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs')) continue
    out.push(resolve(entry.parentPath, entry.name))
  }
  return out
}

describe.skipIf(shouldSkip)(
  'published dist inlines no second copy of the SDK error classes (#46)',
  () => {
    it('does not inline `@anthropic-ai/sdk/core/error` while also importing the SDK', async () => {
      const bundles = await collectBundles(distDir)
      expect(bundles.length).toBeGreaterThan(0)
      // The SDK's own error source has this unmistakable marker (the makeMessage static plus the
      // class declaration), which the bundler leaves in a chunk it inlines.
      const offenders: string[] = []
      for (const file of bundles) {
        const source = await readFile(file, 'utf-8')
        const inlinesSdkErrorModule =
          /class APIError extends AnthropicError/.test(source) ||
          /static makeMessage\(status, error, message\)/.test(source)
        const importsTheRealSdk =
          /from\s+["']@anthropic-ai\/sdk["']/.test(source) ||
          /require\(["']@anthropic-ai\/sdk["']\)/.test(source)
        if (inlinesSdkErrorModule && importsTheRealSdk) offenders.push(file)
      }
      expect(
        offenders,
        `These bundles BOTH inline the SDK error classes and import the real SDK client, so the client ` +
          `throws classes the inlined copy never matches (issue #46). Externalise ` +
          `\`@anthropic-ai/sdk/*\` subpaths in vite.config.mts.`
      ).toEqual([])
    })

    it('has no chunk whose only SDK-error content is an inlined copy of the module', async () => {
      // A belt-and-braces check: outside the client module itself, nothing should carry the SDK error
      // source region. The client module legitimately resolves the SDK externally.
      const bundles = await collectBundles(distDir)
      const inlined = [] as string[]
      for (const file of bundles) {
        const source = await readFile(file, 'utf-8')
        if (/class AnthropicError extends Error/.test(source)) inlined.push(file)
      }
      expect(inlined).toEqual([])
    })
  }
)

describe.skipIf(shouldSkip)('built classifier classifies REAL SDK-thrown HTTP errors (#46)', () => {
  it('returns retriable for 429/502/503/504/529 and fatal for 400/401', async () => {
    // A separate plain-Node ESM process imports the built classifier and drives a REAL SDK client
    // with an injected fetch — the exact shape the issue measured.
    const script = `
      import Anthropic from '@anthropic-ai/sdk'
      import { translateAnthropicError } from ${JSON.stringify(`file://${adapterMjsPath.replace(/adapter\.mjs$/, 'error_translation.mjs')}`)}
      const RETRIABLE = [429, 502, 503, 504, 529]
      const results = {}
      for (const status of [429, 502, 503, 504, 529, 400, 401]) {
        const client = new Anthropic({
          apiKey: 'k',
          maxRetries: 0,
          fetch: async () => new Response(
            '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
            { status, headers: { 'content-type': 'application/json' } }
          ),
        })
        try {
          await client.messages.create({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
        } catch (err) {
          results[status] = translateAnthropicError(err, RETRIABLE)
        }
      }
      process.stdout.write(JSON.stringify(results))
    `
    const { stdout } = await execa(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: resolve(distDir, '..'),
    })
    const results = JSON.parse(stdout) as Record<string, { kind: string; status: number }>
    for (const status of [429, 502, 503, 504, 529]) {
      expect(results[String(status)], `HTTP ${status}`).toMatchObject({
        kind: 'retriable',
        status,
      })
    }
    for (const status of [400, 401]) {
      expect(results[String(status)], `HTTP ${status}`).toMatchObject({ kind: 'fatal', status })
    }
  }, 60_000)
})
