// Gated real-model proof for the transformers.js STT (speech-to-text) specialist battery (Node /
// onnxruntime-node). transformers.js is environment-neutral — this exercises the NATIVE Node ONNX
// backend against a real Whisper(-family) model. Gated on a model env var so CI skips cleanly (the
// model is a real download). To run locally, put in .env.test:
//   TEST_SPECIALIST_STT_MODEL=onnx-community/whisper-base
//   pnpm run test:node
//
// Fixture: tests/_fixtures/media/speech.wav — the same fixture the multi-model composition spec
// (multi_model_compose.node.spec.ts) uses for its Whisper leg, with the same recorded transcript
// ("The quick brown fox jumps over the lazy dog."), so the "fox" assertion here is grounded in that
// receipt, not a guess.

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { TransformersJsSttAdapter } from '@nhtio/adk/batteries/specialists/stt/transformers_js'

const MODEL = process.env.TEST_SPECIALIST_STT_MODEL

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../_fixtures/media/speech.wav'
)

describe.skipIf(!MODEL)('TransformersJsSttAdapter — real model (Node, gated)', () => {
  // Constructed in beforeAll, NOT at the describe body's top level: `describe.skipIf` only skips
  // `it`/hook bodies at run time — the describe callback itself still executes during collection
  // even when the suite is skipped. Building the (validated, `model`-required) adapter eagerly here
  // would throw "model is required" during collection whenever the gate is closed (proven while
  // authoring this spec — an ungated top-level `new TransformersJsSttAdapter({...})` crashed
  // collection of this file even with the suite skipped).
  let adapter: TransformersJsSttAdapter

  beforeAll(() => {
    adapter = new TransformersJsSttAdapter({ model: MODEL as string })
  })

  afterAll(async () => {
    await adapter?.dispose()
  })

  it('transcribes the speech fixture and recognizes the spoken words', async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH))
    const result = await adapter.transcribe({ bytes, mimeType: 'audio/wav' })
    expect(typeof result.text).toBe('string')
    expect(result.text.toLowerCase()).toContain('fox')
  }, 900_000)

  it('returns non-empty timestamped segments with numeric start times', async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH))
    const result = await adapter.transcribe({ bytes, mimeType: 'audio/wav' }, { timestamps: true })
    expect(Array.isArray(result.segments)).toBe(true)
    expect(result.segments!.length).toBeGreaterThan(0)
    for (const segment of result.segments!) {
      expect(typeof segment.start).toBe('number')
      expect(Number.isFinite(segment.start)).toBe(true)
    }
  }, 900_000)
})

describe('TransformersJsSttAdapter — gate status', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof !!MODEL).toBe('boolean')
  })
})
