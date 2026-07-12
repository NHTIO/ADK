import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkIsolated } from '@nhtio/adk/batteries/isolation/child_process'
import { embeddingsPipelineSpec } from '../../../_fixtures/isolation/embeddings_pipeline_spec'
import { TransformersJsEmbeddingsAdapter } from '@nhtio/adk/batteries/embeddings/transformers_js'
import { prebundleChild, type PrebundledChild } from '../../../_fixtures/isolation/prebundle_child'
import type { CreateTransformersJsEmbeddingsPipeline } from '@nhtio/adk/batteries/embeddings/transformers_js'

/**
 * WP5 Proof B: an isolated (out-of-process) feature-extraction pipeline handed to the REAL, UNMODIFIED
 * `TransformersJsEmbeddingsAdapter` via its public `createPipeline` injection seam — no
 * `@huggingface/transformers` import anywhere in this test. The child hosts a fake, deterministic
 * hash-based pipeline (`embeddings_pipeline_child.ts`); `createPipeline` forwards the adapter's exact
 * call shape (`{model, device, dtype, onInitProgress}` in, `pipe(input, {pooling, normalize})` per-call)
 * across the isolation boundary and reconstructs the `{tolist(), dims}` Tensor-like the adapter expects.
 */
let child: PrebundledChild

beforeAll(async () => {
  child = await prebundleChild(
    new URL('../../../_fixtures/isolation/embeddings_pipeline_child.ts', import.meta.url).pathname
  )
}, 120_000)

afterAll(async () => {
  await child?.dispose()
})

const makeAdapter = (): {
  adapter: TransformersJsEmbeddingsAdapter
  dispose: () => Promise<void>
} => {
  const svc = forkIsolated(embeddingsPipelineSpec, { modulePath: child.modulePath })
  const createPipeline: CreateTransformersJsEmbeddingsPipeline = async () =>
    (async (input: string[], opts: { pooling?: string; normalize?: boolean }) => {
      const { vectors } = await svc.api.embed(input, opts)
      return { tolist: () => vectors, dims: [vectors.length, vectors[0]?.length ?? 0] }
    }) as never
  const adapter = new TransformersJsEmbeddingsAdapter({ model: 'fake-hash-model', createPipeline })
  return { adapter, dispose: () => svc.dispose() }
}

describe('isolated feature-extraction pipeline through the real TransformersJsEmbeddingsAdapter', () => {
  it('adapter.embed() resolves a deterministic vector via the isolated pipeline', async () => {
    const { adapter, dispose } = makeAdapter()
    try {
      const vec = await adapter.embed('hello world')
      expect(vec).toHaveLength(8)
      const vec2 = await adapter.embed('hello world')
      expect(vec2).toEqual(vec)
    } finally {
      await dispose()
    }
  })

  it('adapter.embedMany() returns one vector per input, in order', async () => {
    const { adapter, dispose } = makeAdapter()
    try {
      const vectors = await adapter.embedMany(['alpha', 'beta', 'gamma'])
      expect(vectors).toHaveLength(3)
      expect(new Set(vectors.map((v) => JSON.stringify(v))).size).toBe(3)
    } finally {
      await dispose()
    }
  })
})
