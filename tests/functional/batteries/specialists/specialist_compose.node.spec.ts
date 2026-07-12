// Multi-model composition proof for the specialists domain (gated on TEST_MODEL_MATRIX) — the same
// composition pattern as multi_model_compose.node.spec.ts, but driving the new dedicated specialist
// ADAPTERS (TransformersJsSttAdapter / TesseractJsOcrAdapter) directly rather than the media pipeline's
// engines:
//   1. A narrow specialist adapter turns its modality into TEXT.
//   2. That specialist text is handed to a DIFFERENT, TEXT-ONLY LLM (Llama-3.2-1B) as conversation input.
//   3. The text-only model — which never saw the bytes — grounds its answer on the specialist's output.
//
// Two chains only:
//   (a) STT chain:  TransformersJsSttAdapter.transcribe(speech.wav) → transcript → Llama grounds on "fox"
//   (b) OCR chain:  TesseractJsOcrAdapter.recognize(sample_ocr.png) → text → Llama grounds on "hello"
//
// The CAPTION chain is intentionally NOT covered here — grounding a downstream LLM on a caption needs a
// multimodal VL captioner's output (Gemma-4-E2B's image branch, per multi_model_compose.node.spec.ts's
// VISION chain), which is that OLDER spec's job (it composes a single-model-multimodal captioner with a
// text-only LLM). The new TransformersJsCaptionAdapter is exercised for its OWN real-weight correctness
// in caption_real_model.node.spec.ts / specialists.webgpu.spec.ts, not re-proven here.
//
// RECEIPTS (same fixtures + recorded transcripts as multi_model_compose.node.spec.ts):
//   Whisper(speech.wav)        = "The quick brown fox jumps over the lazy dog."
//   Tesseract(sample_ocr.png)  = "HELLO OCR\n123"
//   Llama-3.2-1B(transcript→Q) = "Fox"
//
// Node-only: the specialist engines (transformers ASR, tesseract) and the ONNX text model run under
// node; nothing here is browser-portable.

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { matrixEntryById } from '../../../_fixtures/model_matrix'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { makeMatrixContext, makeMatrixHelpers } from '../../../_fixtures/matrix_context'
import { TesseractJsOcrAdapter } from '@nhtio/adk/batteries/specialists/ocr/tesseract_js'
import { TransformersJsSttAdapter } from '@nhtio/adk/batteries/specialists/stt/transformers_js'
import type { MatrixEntry } from '../../../_fixtures/model_matrix'

const RUN = process.env.TEST_MODEL_MATRIX === '1'

const TEXT_MODEL = 'onnx-community/Llama-3.2-1B-Instruct-q4f16'
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../_fixtures/media')

/** Run a turn through a real TEXT-ONLY LLM with `prompt` and return its assistant prose. */
const askTextModel = async (prompt: string): Promise<string> => {
  const base = matrixEntryById('tjs-llama-3.2-1b')
  const entry = {
    ...(base ?? {}),
    id: 'compose-downstream',
    family: 'Llama 3.2 1B (text-only downstream)',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: base?.modelRef ?? TEXT_MODEL,
    host: 'exists',
    // text-only: NO multimodal flags, NO tools — it can only reason over the text it is given.
    capabilities: { streaming: true },
    tools: undefined,
    attachments: undefined,
    prompt,
    expect: {},
  } as unknown as MatrixEntry
  const adapter = new TransformersJsAdapter({
    model: entry.modelRef,
    ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
    stream: false,
    autoAck: true,
    maxNewTokens: 48,
    doSample: false,
  })
  try {
    const { ctx, stored } = makeMatrixContext(entry, [])
    await adapter.executor()(ctx, makeMatrixHelpers(stored))
    const last = [...stored.messages].reverse().find((m) => m.role === 'assistant')
    return (last?.content?.toString() ?? '').toLowerCase()
  } finally {
    await adapter.dispose?.()
  }
}

describe.skipIf(!RUN)('specialist composition (dedicated adapters → text-only LLM)', () => {
  // Constructed in beforeAll, not at the describe body's top level: `describe.skipIf` only skips
  // `it`/hook bodies at run time, not the describe callback itself (see stt_real_model.node.spec.ts
  // for the proven collection-time-crash reproduction). These constructor args happen to be hardcoded
  // literals rather than env-derived, so this specific file wouldn't crash either way today — but
  // deferring construction consistently avoids depending on that coincidence.
  let sttAdapter: TransformersJsSttAdapter
  let ocrAdapter: TesseractJsOcrAdapter

  beforeAll(() => {
    sttAdapter = new TransformersJsSttAdapter({ model: 'onnx-community/whisper-base' })
    ocrAdapter = new TesseractJsOcrAdapter({ languages: ['eng'] })
  })

  afterAll(async () => {
    await sttAdapter?.dispose()
    await ocrAdapter?.dispose()
  })

  it('STT chain: TransformersJsSttAdapter transcribes → text-only Llama grounds on the speech', async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURE_DIR, 'speech.wav')))
    const { text: transcript } = await sttAdapter.transcribe({ bytes, mimeType: 'audio/wav' })
    expect(transcript.toLowerCase()).toContain('fox') // the specialist actually heard the speech

    const answer = await askTextModel(
      `An audio clip was transcribed as: "${transcript}". ` +
        `Question: what animal is mentioned in the audio? Answer with one word.`
    )
    expect(answer, `downstream did not ground on the transcript (got: ${answer})`).toMatch(/fox/)
  }, 900_000)

  it('OCR chain: TesseractJsOcrAdapter recognizes → text-only Llama grounds on the text', async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURE_DIR, 'sample_ocr.png')))
    const { text: ocrTextRaw } = await ocrAdapter.recognize({ bytes, mimeType: 'image/png' })
    const ocrText = ocrTextRaw.replace(/\s+/g, ' ').trim()
    expect(ocrText.toLowerCase()).toContain('hello') // the OCR specialist actually read the glyphs

    // The composition claim under test is GROUNDING — the specialist's text reaches and is used by
    // the downstream model — not the 1B's reasoning quality. A comprehension question ("what
    // greeting word…?") proved flaky against Llama-3.2-1B (it answers the category "greetings", or
    // truncates "123" to "1" — the same flake exists in the original multi_model_compose spec
    // today). A verbatim repeat demands zero reasoning: the answer can only contain the OCR'd
    // tokens if the model actually received them.
    const answer = await askTextModel(
      `Here is text extracted from an image via OCR: "${ocrText}". ` +
        `Repeat the extracted text back exactly, word for word.`
    )
    expect(
      answer.toLowerCase(),
      `downstream did not ground on the OCR text (got: ${answer})`
    ).toContain('hello')
    expect(answer, `downstream did not repeat the OCR'd number (got: ${answer})`).toContain('123')
  }, 900_000)
})

describe('specialist composition — gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'}`, () => {
    expect(typeof RUN).toBe('boolean')
  })
})
