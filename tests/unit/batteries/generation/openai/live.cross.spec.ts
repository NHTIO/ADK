/**
 * LIVE gated spec for the OpenAI-shaped generation battery (WP-3).
 *
 * @remarks
 * These tests hit a real network endpoint and are gated on `TEST_GENERATION_OPENAI_API_KEY` being
 * set (blank in CI per `.env.test.example`, so `describe.skipIf` skips the whole block green).
 * This is a `.cross.spec.ts` file (collected by both the `node` and `browser` vitest projects —
 * see `vite.config.mts`), so {@link envFor} guards on `typeof process !== 'undefined'` first: a
 * browser project run has no `process.env`, so the block skips there too, unconditionally.
 *
 * PROBE-CONFIRMED live topology: the configured base URL is an OpenAI-Images-compatible `/v1`
 * surface. Through the nhtio LLM load balancer this route translates `/v1/images/generations`
 * onto Gemini image models — hence the `gemini-2.5-flash-image` default below — but the wire shape
 * consumed by {@link OpenAIGenerationAdapter.generate} is the standard OpenAI Images response
 * (`{ data: [{ b64_json }] }`) regardless of which model actually renders it. Direct-OpenAI users
 * should set `TEST_GENERATION_OPENAI_MODEL=gpt-image-1` (or `dall-e-3`) and leave `BASE_URL` blank.
 *
 * KNOWN GAP — `edit()` has no live coverage here: probing the LB's `/v1/images/edits` route
 * returned a 404 (the gateway does not implement OpenAI-shaped image edits, only generations).
 * `edit()`'s request-building (multipart field names, mask handling, response decoding) stays
 * fully covered by the fetch-stubbed suite in `../../openai/index.cross.spec.ts`; only `generate()`
 * gets a live exercise in this file.
 */

import { describe, expect, it } from 'vitest'
import { envFor, magicMatches } from '../_live_helpers'
import { OpenAIGenerationAdapter } from '../../../../../src/batteries/generation/openai'

// These tests hit a real network endpoint, so a small retry absorbs genuinely transient I/O blips
// (connection resets, momentary backend hiccups) — not a substitute for correctness, since the
// deterministic wire-shape behavior is fully covered by the fetch-stubbed sibling suite.
const LIVE_RETRY = 2
const LIVE_TIMEOUT_MS = 120_000

const env = envFor('TEST_GENERATION_OPENAI', 'gemini-2.5-flash-image')

describe.skipIf(!env)('OpenAIGenerationAdapter — live', () => {
  const apiKey = env?.apiKey ?? ''
  const baseURL = env?.baseURL
  const model = env?.model ?? 'gemini-2.5-flash-image'

  it(
    'generate() returns at least one real image with plausible bytes',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT_MS },
    async () => {
      const adapter = new OpenAIGenerationAdapter({
        model,
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      })

      const outputs = await adapter.generate('A simple red circle centered on a white background', {
        n: 1,
      })

      expect(outputs.length).toBeGreaterThanOrEqual(1)
      for (const output of outputs) {
        expect(output.kind).toBe('image')
        expect(output.bytes.byteLength).toBeGreaterThan(5000)
        expect(magicMatches(output.mimeType, output.bytes)).toBe(true)
      }
    }
  )
})
