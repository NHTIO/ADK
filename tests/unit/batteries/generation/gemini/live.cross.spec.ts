/**
 * LIVE gated spec for the Gemini native generation battery (WP-3).
 *
 * @remarks
 * These tests hit a real network endpoint and are gated on `TEST_GENERATION_GEMINI_API_KEY` being
 * set (blank in CI per `.env.test.example`, so `describe.skipIf` skips the whole block green).
 * This is a `.cross.spec.ts` file (collected by both the `node` and `browser` vitest projects —
 * see `vite.config.mts`), so {@link envFor} guards on `typeof process !== 'undefined'` first: a
 * browser project run has no `process.env`, so the block skips there too, unconditionally.
 *
 * PROBE-CONFIRMED live topology: the configured base URL is the native Gemini `/v1beta`
 * `generateContent` surface — through the nhtio LLM load balancer, BOTH `generate()` and `edit()`
 * work live (unlike the OpenAI-shaped engine, whose `/v1/images/edits` route 404s — see
 * `../openai/live.cross.spec.ts`). Auth arrives via `headers: { Authorization: 'Bearer ' + apiKey
 * }` — the LB-compatible form — rather than the adapter's own `apiKey` option (which sends
 * `x-goog-api-key` and is what a direct-Google caller, bypassing the LB, would use instead).
 */

import { describe, expect, it } from 'vitest'
import { envFor, magicMatches } from '../_live_helpers'
import { GeminiGenerationAdapter } from '../../../../../src/batteries/generation/gemini'

// These tests hit a real network endpoint, so a small retry absorbs genuinely transient I/O blips
// (connection resets, momentary backend hiccups) — not a substitute for correctness, since the
// deterministic wire-shape behavior is fully covered by the fetch-stubbed sibling suite.
const LIVE_RETRY = 2
const LIVE_TIMEOUT_MS = 120_000

const env = envFor('TEST_GENERATION_GEMINI', 'gemini-2.5-flash-image')

// Reused across generate/edit assertions below.
const assertLiveImageOutput = (output: { kind: string; mimeType: string; bytes: Uint8Array }) => {
  expect(output.kind).toBe('image')
  expect(output.bytes.byteLength).toBeGreaterThan(5000)
  expect(magicMatches(output.mimeType, output.bytes)).toBe(true)
}

describe.skipIf(!env)('GeminiGenerationAdapter — live', () => {
  const model = env?.model ?? 'gemini-2.5-flash-image'

  // LB-compatible construction: no `apiKey` field, Bearer auth via `headers` instead. A caller
  // going directly to Google (no LB in front) would set `apiKey` and drop `headers` — the adapter
  // then sends `x-goog-api-key` itself (see `GeminiGenerationAdapter#headers`).
  const makeAdapter = () =>
    new GeminiGenerationAdapter({
      model,
      ...(env?.baseURL ? { baseURL: env.baseURL } : {}),
      headers: { Authorization: `Bearer ${env?.apiKey ?? ''}` },
    })

  it(
    'generate() returns at least one real image with plausible bytes',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT_MS },
    async () => {
      const adapter = makeAdapter()

      const outputs = await adapter.generate('A simple red circle centered on a white background', {
        n: 1,
      })

      expect(outputs.length).toBeGreaterThanOrEqual(1)
      for (const output of outputs) assertLiveImageOutput(output)
    }
  )

  it(
    'edit() recolors the fixture image and returns bytes that differ from the input',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT_MS },
    async () => {
      // Dynamic + deferred: this test body only ever executes under the node project (the env
      // guard above requires `process` to exist), so `node:fs/promises` is safe here even though
      // the file is collected by the browser project too — the browser run skips this whole
      // `describe` block before this import is ever evaluated.
      const { readFile } = await import('node:fs/promises')
      const { resolve } = await import('node:path')
      const fixturePath = resolve(import.meta.dirname, '../../../../_fixtures/media/sample.png')
      const inputBytes = new Uint8Array(await readFile(fixturePath))

      const adapter = makeAdapter()
      const outputs = await adapter.edit(
        { bytes: inputBytes, mimeType: 'image/png' },
        'Recreate this image but make the circle blue'
      )

      expect(outputs.length).toBeGreaterThanOrEqual(1)
      for (const output of outputs) {
        assertLiveImageOutput(output)
        expect(Buffer.compare(Buffer.from(output.bytes), Buffer.from(inputBytes))).not.toBe(0)
      }
    }
  )

  it(
    'generate() with a per-call aspectRatio succeeds against the real imageConfig contract',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT_MS },
    async () => {
      const adapter = makeAdapter()

      const outputs = await adapter.generate('A simple red circle centered on a white background', {
        n: 1,
        aspectRatio: '1:1',
      })

      expect(outputs.length).toBeGreaterThanOrEqual(1)
      for (const output of outputs) assertLiveImageOutput(output)
    }
  )
})
