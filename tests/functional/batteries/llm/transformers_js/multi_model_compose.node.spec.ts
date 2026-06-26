// Multi-MODEL multimodal composition (gated on TEST_MODEL_MATRIX) — the proof that SEPARATE specialist
// models (one per modality) can be COMPOSED with a text-only reasoning model, as opposed to one unified
// model (Gemma-4) perceiving every modality itself (that's the single-model path, covered by the matrix's
// tjs-gemma-mm / tjs-gemma-audio / tjs-gemma-mixed entries).
//
// The composition pattern, end-to-end on REAL weights:
//   1. A narrow specialist model turns its modality into TEXT:
//        - audio  → Whisper-base (onnx-community/whisper-base) via the media pipeline's audio.transcribe
//        - vision → Gemma-4-E2B image branch (a VL captioner) — names what's in the image
//        - OCR    → Tesseract (image glyphs → text) via the media pipeline's extractText  [separate chain]
//   2. That specialist text is handed to a DIFFERENT, TEXT-ONLY LLM (Llama-3.2-1B) as conversation input.
//   3. The text-only model — which never saw the bytes — grounds its answer on the specialist's output.
//
// Two genuinely different models per chain. This is the first real-weight test of the multi-model seam;
// the matrix only ever pairs a single model with a modality. RECEIPTS captured while authoring (so the
// asserts below are grounded, not hopeful):
//   Whisper(speech.wav)            = "The quick brown fox jumps over the lazy dog."
//   Gemma-4-image(sample.png)      = "...Red..."           (the colour block)
//   Tesseract(sample_ocr.png)      = "HELLO OCR\n123"
//   Llama-3.2-1B(transcript→Q)     = "Fox"
//
// Node-only: the specialist engines (audio-decode, transformers ASR, tesseract) and the ONNX text model
// run under node; nothing here is browser-portable.

import { describe, it, expect } from 'vitest'
import { createMediaPipeline } from '@nhtio/adk/batteries/media'
import { matrixEntryById } from '../../../../_fixtures/model_matrix'
import { loadMediaFixture } from '../../../../_fixtures/media_fixtures'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { audioDecodeEngine } from '../../../../../src/batteries/media/engines/audio_decode'
import { tesseractJsEngine } from '../../../../../src/batteries/media/engines/tesseract_js'
import { makeMatrixContext, makeMatrixHelpers } from '../../../../_fixtures/matrix_context'
import { transformersAsrEngine } from '../../../../../src/batteries/media/engines/transformers_asr'
import type { MatrixEntry } from '../../../../_fixtures/model_matrix'

const RUN = process.env.TEST_MODEL_MATRIX === '1'

const TEXT_MODEL = 'onnx-community/Llama-3.2-1B-Instruct-q4f16'

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
  const { ctx, stored } = makeMatrixContext(entry, [])
  await adapter.executor()(ctx, makeMatrixHelpers(stored))
  const last = [...stored.messages].reverse().find((m) => m.role === 'assistant')
  return (last?.content?.toString() ?? '').toLowerCase()
}

describe.skipIf(!RUN)(
  'multi-MODEL multimodal composition (specialist → text → text-only LLM)',
  () => {
    it('AUDIO chain: Whisper transcribes → text-only Llama grounds on the speech', async () => {
      // Specialist #1 (audio model): real Whisper-base, via the media pipeline.
      const mp = await createMediaPipeline({
        engines: [
          () => audioDecodeEngine(),
          () => transformersAsrEngine({ model: 'onnx-community/whisper-base' }),
        ],
      })
      const transcript = (await mp(
        await loadMediaFixture('speech.wav')
      ).audio.transcribe()) as string
      expect(transcript.toLowerCase()).toContain('fox') // the specialist actually heard the speech

      // Specialist #2 (text model): a SEPARATE text-only LLM reasons over the transcript.
      const answer = await askTextModel(
        `An audio clip was transcribed as: "${transcript}". ` +
          `Question: what animal is mentioned in the audio? Answer with one word.`
      )
      expect(answer, `downstream did not ground on the transcript (got: ${answer})`).toMatch(/fox/)
    }, 900_000)

    it('VISION chain: Gemma-4 captions the image → text-only Llama grounds on the caption', async () => {
      // Specialist #1 (vision model): Gemma-4-E2B image branch acts as a captioner — bytes → a colour word.
      const visionEntry = matrixEntryById('tjs-gemma-mm')
      expect(visionEntry, 'tjs-gemma-mm entry missing').toBeDefined()
      const capAdapter = new TransformersJsAdapter({
        model: visionEntry!.modelRef,
        dtype: visionEntry!.dtype as never,
        multimodal: { image: true, audio: false },
        stream: false,
        autoAck: true,
        maxNewTokens: 48,
        doSample: false,
      })
      const capEntry = {
        ...visionEntry!,
        prompt: 'In one short phrase, what is the dominant colour in this image?',
      } as MatrixEntry
      const { buildAttachments } = await import('../../../../_fixtures/matrix_context')
      const { readFileSync } = await import('node:fs')
      const attachments = buildAttachments(capEntry, (p) => new Uint8Array(readFileSync(p)))
      const { ctx: capCtx, stored: capStored } = makeMatrixContext(capEntry, attachments)
      await capAdapter.executor()(capCtx, makeMatrixHelpers(capStored))
      const caption = (
        [...capStored.messages]
          .reverse()
          .find((m) => m.role === 'assistant')
          ?.content?.toString() ?? ''
      ).toLowerCase()
      expect(caption, `vision specialist produced no caption (got: ${caption})`).toMatch(
        /red|colou?r/
      )

      // Specialist #2 (text model): a SEPARATE text-only LLM reasons over the caption.
      const answer = await askTextModel(
        `An image was captioned as: "${caption}". ` +
          `Question: what colour is the image? Answer with one word.`
      )
      expect(answer, `downstream did not ground on the caption (got: ${answer})`).toMatch(/red/)
    }, 900_000)

    it('OCR chain (separate scenario): Tesseract reads glyphs → text-only Llama grounds on the text', async () => {
      // OCR is a DIFFERENT specialist kind from a VL captioner — it extracts text glyphs, not scene meaning.
      const mp = await createMediaPipeline({
        engines: [() => tesseractJsEngine({ languages: ['eng'] })],
      })
      const ocrText = (await mp(await loadMediaFixture('sample_ocr.png')).extractText({
        ocr: 'force',
      })) as string
      expect(ocrText.toLowerCase()).toContain('hello') // the OCR specialist actually read the glyphs

      // A SEPARATE text-only LLM reasons over the OCR'd text.
      const answer = await askTextModel(
        `Text was extracted from an image via OCR: "${ocrText.replace(/\s+/g, ' ').trim()}". ` +
          `Question: what greeting word appears in the image? Answer with one word.`
      )
      expect(answer, `downstream did not ground on the OCR text (got: ${answer})`).toMatch(/hello/)
    }, 900_000)
  }
)

describe('multi-model composition — gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'}`, () => {
    expect(typeof RUN).toBe('boolean')
  })
})
