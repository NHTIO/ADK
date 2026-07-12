// Gated real-model proof for the tesseract.js OCR specialist battery (Node, WASM Tesseract — no
// native binary). Gated on TEST_SPECIALIST_OCR=1 so CI skips cleanly (tesseract.js downloads a
// language pack on first use). To run locally, put in .env.test:
//   TEST_SPECIALIST_OCR=1
//   pnpm run test:node
//
// Fixture: tests/_fixtures/media/sample_ocr.png — the same fixture the multi-model composition spec
// (multi_model_compose.node.spec.ts) and the media battery's own tesseract engine tests OCR, with the
// same recorded text ("HELLO OCR\n123"), so the "HELLO OCR" assertion here is grounded in that
// receipt. No langPath/cachePath override is needed in Node — tesseract.js resolves its own
// worker/lang-data URLs there; the media engine's own functional/e2e coverage (image_audio.node.spec.ts)
// likewise constructs `tesseractJsEngine({ languages: ['eng'] })` with no path overrides.

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { TesseractJsOcrAdapter } from '@nhtio/adk/batteries/specialists/ocr/tesseract_js'

const RUN = process.env.TEST_SPECIALIST_OCR === '1'

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../_fixtures/media/sample_ocr.png'
)

describe.skipIf(!RUN)('TesseractJsOcrAdapter — real engine (Node, gated)', () => {
  // Constructed in beforeAll, not at the describe body's top level: `describe.skipIf` only skips
  // `it`/hook bodies at run time, not the describe callback itself (see stt_real_model.node.spec.ts
  // for the proven collection-time-crash reproduction). These constructor args happen to be hardcoded
  // literals rather than env-derived, so this specific file wouldn't crash either way today — but
  // deferring construction consistently avoids depending on that coincidence.
  let adapter: TesseractJsOcrAdapter

  beforeAll(() => {
    adapter = new TesseractJsOcrAdapter({ languages: ['eng'] })
  })

  afterAll(async () => {
    await adapter?.dispose()
  })

  it('recognizes the OCR fixture, normalizing whitespace before asserting the greeting text', async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH))
    const result = await adapter.recognize({ bytes, mimeType: 'image/png' })
    const normalized = result.text.replace(/\s+/g, ' ').trim().toUpperCase()
    expect(normalized).toContain('HELLO OCR')
    expect(typeof result.confidence === 'number' || result.confidence === undefined).toBe(true)
  }, 900_000)
})

describe('TesseractJsOcrAdapter — gate status', () => {
  it('reports whether the real-engine gate is open', () => {
    expect(typeof RUN).toBe('boolean')
  })
})
