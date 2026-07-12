// Real-weight proof for the specialist batteries (STT / Caption / OCR) in a HEADED, REAL-GPU browser —
// the browser half of the specialist real-model coverage (the Node half is stt_real_model.node.spec.ts /
// caption_real_model.node.spec.ts / ocr_real.node.spec.ts). None of the three specialists actually
// REQUIRES WebGPU (all three are environment-neutral, per their adapters' own `isAvailable()` — always
// `true`), but this file proves they load and run correctly in the dedicated headed browser-webgpu
// project alongside the LLM/embeddings matrix, exercising the real onnxruntime-web / browser WASM
// backends rather than onnxruntime-node.
//
// It runs ONLY in the dedicated headed `browser-webgpu` vitest project, which vite.config.mts
// instantiates solely when TEST_MATRIX_BROWSER is set — i.e. via:
//
//   TEST_MATRIX_BROWSER=1 TEST_MODEL_MATRIX=1 vitest run --project=browser-webgpu
//
// So it never runs in normal CI / `test:browser` (shared runners have no GPU/headed display). Gated the
// same way `model_matrix.webgpu.spec.ts` gates: on `TEST_MODEL_MATRIX=1` (read via the vite-inlined
// `__TEST_ENV__`, since browsers have no `process.env`) AND `'gpu' in navigator`.
//
// Fixtures are fetched over HTTP (vitest's browser provider serves the repo root) rather than read via
// `node:fs` — a browser spec has no filesystem. Same fixtures + ground truths as the Node specs and
// multi_model_compose.node.spec.ts: speech.wav → "fox", sample_ocr.png → "HELLO OCR", sample.png → any
// non-empty caption (see caption_real_model.node.spec.ts for why a non-empty assertion is the honest
// bar for a solid-colour block).

import { describe, expect, it } from 'vitest'
import { TesseractJsOcrAdapter } from '@nhtio/adk/batteries/specialists/ocr/tesseract_js'
import { TransformersJsSttAdapter } from '@nhtio/adk/batteries/specialists/stt/transformers_js'
import { TransformersJsCaptionAdapter } from '@nhtio/adk/batteries/specialists/caption/transformers_js'

// `__TEST_ENV__` is inlined by vite.config (browsers have no process.env).
const TEST_ENV: Record<string, string> =
  typeof __TEST_ENV__ !== 'undefined'
    ? __TEST_ENV__
    : ((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {})

const HAS_WEBGPU =
  typeof navigator !== 'undefined' && 'gpu' in navigator && typeof navigator.gpu !== 'undefined'
const RUN = TEST_ENV.TEST_MODEL_MATRIX === '1' && HAS_WEBGPU

const STT_MODEL = TEST_ENV.TEST_SPECIALIST_STT_MODEL || 'onnx-community/whisper-tiny.en'
const CAPTION_MODEL = TEST_ENV.TEST_SPECIALIST_CAPTION_MODEL || 'Xenova/vit-gpt2-image-captioning'

// Fetch an attachment fixture over HTTP (vitest browser serves the repo root).
const fetchBytes = async (fixturePath: string): Promise<Uint8Array> => {
  const res = await fetch(`/${fixturePath}`)
  if (!res.ok) throw new Error(`failed to fetch ${fixturePath}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// Release a loaded adapter's native resources between cells — same rationale as the LLM/embeddings
// matrix's disposeQuietly (per-cell disposal keeps a full run from exhausting the heap). Errors are
// swallowed; teardown must never turn into a spurious red.
const disposeQuietly = async (adapter: { dispose?: () => Promise<unknown> }): Promise<void> => {
  try {
    if (typeof adapter.dispose === 'function') await adapter.dispose()
  } catch {
    // teardown is best-effort
  }
}

describe.skipIf(!RUN)('specialist batteries — real WebGPU browser (headed, gated)', () => {
  it('STT: whisper transcribes speech.wav and recognizes the spoken words', async () => {
    // dtype pinned: the browser build's auto-selected quantization fails ONNX session creation for
    // whisper/vit-gpt2 ("Missing required scale ... DequantizeLinear" from MatMulNBits weights) —
    // the exact WebGPU dtype sensitivity the adapter's device/dtype options exist to control.
    // fp32 is the known-good cross-EP combo for these small models (tiny/base ≈ 150-500MB fp32).
    const adapter = new TransformersJsSttAdapter({ model: STT_MODEL, dtype: 'fp32' as never })
    try {
      const bytes = await fetchBytes('tests/_fixtures/media/speech.wav')
      const result = await adapter.transcribe({ bytes, mimeType: 'audio/wav' })
      expect(result.text.toLowerCase()).toContain('fox')
    } finally {
      await disposeQuietly(adapter)
    }
  }, 900_000)

  it('Caption: vit-gpt2 describes sample.png with a non-empty caption', async () => {
    // dtype pinned to fp32 — same session-creation failure as the STT leg above without it.
    const adapter = new TransformersJsCaptionAdapter({
      model: CAPTION_MODEL,
      dtype: 'fp32' as never,
    })
    try {
      const bytes = await fetchBytes('tests/_fixtures/media/sample.png')
      const result = await adapter.describe({ bytes, mimeType: 'image/png' })
      expect(result.text.trim().length).toBeGreaterThan(0)
    } finally {
      await disposeQuietly(adapter)
    }
  }, 900_000)

  it('OCR: tesseract (eng) recognizes sample_ocr.png and reads the greeting text', async () => {
    const adapter = new TesseractJsOcrAdapter({ languages: ['eng'] })
    try {
      const bytes = await fetchBytes('tests/_fixtures/media/sample_ocr.png')
      const result = await adapter.recognize({ bytes, mimeType: 'image/png' })
      const normalized = result.text.replace(/\s+/g, ' ').trim().toUpperCase()
      expect(normalized).toContain('HELLO OCR')
    } finally {
      await disposeQuietly(adapter)
    }
  }, 900_000)
})

// Always-present marker so the file reports a result even when the gate is closed.
describe('specialist batteries — WebGPU gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'} (webgpu=${HAS_WEBGPU})`, () => {
    expect(typeof RUN).toBe('boolean')
  })
})
