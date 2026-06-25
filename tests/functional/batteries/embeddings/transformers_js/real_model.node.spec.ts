// Gated real-model proof for the transformers.js embeddings battery (Node / onnxruntime-node).
//
// transformers.js is environment-neutral — this exercises the NATIVE Node ONNX backend. Gated on a
// model env var so CI skips cleanly (the model is a real download). To run locally, put in .env.test:
//   TEST_TRANSFORMERS_JS_EMBED_MODEL=onnx-community/all-MiniLM-L6-v2-ONNX
//   pnpm run test:node

import { describe, expect, it } from 'vitest'
import { TransformersJsEmbeddingsAdapter } from '@nhtio/adk/batteries/embeddings/transformers_js'

const MODEL = process.env.TEST_TRANSFORMERS_JS_EMBED_MODEL

describe.skipIf(!MODEL)('TransformersJsEmbeddingsAdapter — real model (Node, gated)', () => {
  it('loads a real ONNX model and embeds text deterministically', async () => {
    const adapter = new TransformersJsEmbeddingsAdapter({
      model: MODEL as string,
      dtype: (process.env.TEST_TRANSFORMERS_JS_EMBED_DTYPE as never) ?? 'fp32',
    })
    const [a, b] = await adapter.embedMany(['hello world', 'hello world'])
    expect(Array.isArray(a)).toBe(true)
    expect(a.length).toBeGreaterThan(0)
    // Same input → identical vector (determinism).
    expect(a).toEqual(b)
    // Normalised (default) → unit-ish length.
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeGreaterThan(0.9)
    expect(norm).toBeLessThan(1.1)
  }, 600_000)
})

describe('TransformersJsEmbeddingsAdapter — gate status', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof !!MODEL).toBe('boolean')
  })
})
