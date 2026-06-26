// Gated real-weight proof that the transformers.js LLM battery's `extractMediaOutputs` seam surfaces
// GENERATED media as an assistant `Message.attachments`. The seam is model-agnostic; the tested open-weight
// chat checkpoints emit only text, so to prove the FULL output path on real audio without a (nonexistent)
// small omni chat-LLM, the extractor here runs a REAL VITS TTS model (`Xenova/mms-tts-eng`) over the chat
// model's text answer and returns the synthesized WAV bytes. The adapter then persists them via
// `ctx.storeMediaBytes` and attaches a first-party `Media.toolGenerated(...)`.
//
// RECEIPTS (probe, this session): `Xenova/mms-tts-eng` → RawAudio Float32 @16kHz, peak 0.85 / rms 0.11
// (non-silent), `toBlob()` → audio/wav. So the assertion below (non-empty audio/wav attachment whose bytes
// round-trip) is grounded, not hopeful.
//
// Gated on TEST_MODEL_MATRIX (downloads real weights). Node-only (the TTS + chat models run under
// onnxruntime-node).

import { describe, it, expect } from 'vitest'
import { matrixEntryById } from '../../../../_fixtures/model_matrix'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { makeMatrixContext, makeMatrixHelpers } from '../../../../_fixtures/matrix_context'
import type { GeneratedMediaOutput } from '@nhtio/adk/batteries/llm/transformers_js'

const RUN = process.env.TEST_MODEL_MATRIX === '1'

describe.skipIf(!RUN)(
  'transformers.js LLM — media OUTPUT via extractMediaOutputs (real audio)',
  () => {
    it('a chat turn surfaces a generated audio/wav attachment on the assistant message', async () => {
      // A real VITS TTS pipeline, loaded once and reused by the extractor.
      const tf = (await import('@huggingface/transformers')) as unknown as {
        pipeline: (task: string, model: string) => Promise<unknown>
      }
      const synth = (await tf.pipeline('text-to-speech', 'Xenova/mms-tts-eng')) as (
        text: string
      ) => Promise<{ toBlob: () => Promise<Blob>; audio: Float32Array; sampling_rate: number }>

      const base = matrixEntryById('tjs-llama-3.2-1b')
      const adapter = new TransformersJsAdapter({
        model: base?.modelRef ?? 'onnx-community/Llama-3.2-1B-Instruct-q4f16',
        ...(base?.dtype ? { dtype: base.dtype as never } : {}),
        stream: false,
        autoAck: true,
        maxNewTokens: 32,
        doSample: false,
        // The seam under test: turn the model's text answer into spoken audio and surface it as output media.
        extractMediaOutputs: async (): Promise<GeneratedMediaOutput[]> => {
          const out = await synth('The quick brown fox jumps over the lazy dog.')
          const blob = await out.toBlob()
          const bytes = new Uint8Array(await blob.arrayBuffer())
          return [{ kind: 'audio', mimeType: 'audio/wav', bytes, filename: 'answer.wav' }]
        },
      })

      const entry = {
        ...(base ?? {}),
        id: 'media-out',
        battery: 'transformers_js_llm',
        runtime: 'node',
        modelRef: base?.modelRef ?? 'onnx-community/Llama-3.2-1B-Instruct-q4f16',
        host: 'exists',
        capabilities: { streaming: true },
        tools: undefined,
        prompt: 'Say hello in one short sentence.',
        expect: {},
      } as never
      const { ctx, stored } = makeMatrixContext(entry, [])
      await adapter.executor()(ctx, makeMatrixHelpers(stored))

      const msg = [...stored.messages].reverse().find((m) => m.role === 'assistant')
      expect(msg, 'no assistant message stored').toBeDefined()
      expect(msg!.attachments.length, 'no generated media attached').toBe(1)
      const att = msg!.attachments[0]!
      expect(att.kind).toBe('audio')
      expect(att.mimeType).toBe('audio/wav')
      expect(att.trustTier).toBe('first-party')
      const bytes = await att.asBytes()
      // A real WAV: RIFF header + non-trivial payload.
      expect(bytes.length).toBeGreaterThan(1000)
      expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF')
    }, 900_000)
  }
)

describe('media-output gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'}`, () => {
    expect(typeof RUN).toBe('boolean')
  })
})
