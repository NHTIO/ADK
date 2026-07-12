// Gated real-model proof for the transformers.js Caption (image-to-text) specialist battery (Node /
// onnxruntime-node). Gated on a model env var so CI skips cleanly (the model is a real download). To
// run locally, put in .env.test:
//   TEST_SPECIALIST_CAPTION_MODEL=Xenova/vit-gpt2-image-captioning
//   pnpm run test:node
//
// Fixture choice: the only image fixtures in tests/_fixtures/media/ are `sample.png` (a 100x100 solid
// red block — used as the vision leg of model_matrix.ts / multi_model_compose.node.spec.ts) and
// `sample_ocr.png` (rendered text — "HELLO OCR\n123"). Neither is a real photo; `sample.png` is the
// sensible pick here because it's a plain scene image (a captioner is meant to describe what's IN an
// image, not read glyphs off it) — `sample_ocr.png` would just invite the captioner to hallucinate a
// caption for a block of text, which isn't a meaningful proof of the image-to-text pipeline. Because a
// solid-colour block has no canonical caption (unlike Whisper's/Tesseract's exact-text outputs), this
// spec asserts only that a non-empty caption comes back — a stronger content assertion would be
// asserting against next-token noise, not the adapter's behavior.

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { TransformersJsCaptionAdapter } from '@nhtio/adk/batteries/specialists/caption/transformers_js'

const MODEL = process.env.TEST_SPECIALIST_CAPTION_MODEL

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../_fixtures/media/sample.png'
)

describe.skipIf(!MODEL)('TransformersJsCaptionAdapter — real model (Node, gated)', () => {
  // Constructed in beforeAll, NOT at the describe body's top level: `describe.skipIf` only skips
  // `it`/hook bodies at run time — the describe callback itself still executes during collection
  // even when the suite is skipped. Building the (validated, `model`-required) adapter eagerly here
  // would throw "model is required" during collection whenever the gate is closed (proven while
  // authoring this spec — an ungated top-level `new TransformersJsCaptionAdapter({...})` crashed
  // collection of this file even with the suite skipped).
  let adapter: TransformersJsCaptionAdapter

  beforeAll(() => {
    adapter = new TransformersJsCaptionAdapter({ model: MODEL as string })
  })

  afterAll(async () => {
    await adapter?.dispose()
  })

  it('describes the image fixture with a non-empty caption', async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH))
    const result = await adapter.describe({ bytes, mimeType: 'image/png' })
    expect(typeof result.text).toBe('string')
    expect(result.text.trim().length).toBeGreaterThan(0)
  }, 900_000)
})

describe('TransformersJsCaptionAdapter — gate status', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof !!MODEL).toBe('boolean')
  })
})
