import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsEmbeddingsAdapter,
  E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS,
  E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR,
} from '@nhtio/adk/batteries/embeddings/transformers_js'

// A fake feature-extraction pipeline: a callable returning a Tensor-like { tolist, dims }. With
// pooling the real pipeline yields [batch, hidden]; we mimic that shape.
const makeFakePipeline = (vectors: number[][]) => {
  const calls: Array<{ input: unknown; opts: unknown }> = []
  const fn = vi.fn(async (input: unknown, opts: unknown) => {
    calls.push({ input, opts })
    return { tolist: () => vectors, dims: [vectors.length, vectors[0]?.length ?? 0] }
  })
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('TransformersJsEmbeddingsAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TransformersJsEmbeddingsAdapter.isAvailable()).toBe(true)
  })
  it('requires a model', () => {
    expect(() => new TransformersJsEmbeddingsAdapter({})).toThrow(
      E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS
    )
  })
  it('rejects unknown keys', () => {
    expect(() => new TransformersJsEmbeddingsAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS
    )
  })
})

describe('TransformersJsEmbeddingsAdapter — embedding', () => {
  it('embed() returns a single vector', async () => {
    const pipe = makeFakePipeline([[0.1, 0.2, 0.3]])
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', pipeline: pipe as never })
    expect(await a.embed('hello')).toEqual([0.1, 0.2, 0.3])
  })

  it('embedMany() returns one vector per input, in order', async () => {
    const pipe = makeFakePipeline([
      [1, 0],
      [0, 1],
    ])
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', pipeline: pipe as never })
    expect(await a.embedMany(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ])
  })

  it('passes pooling + normalize through to the pipeline', async () => {
    const pipe = makeFakePipeline([[1, 2]])
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      pooling: 'cls',
      normalize: false,
    })
    await a.embed('x')
    const opts = (
      pipe as unknown as { calls: Array<{ opts: { pooling: string; normalize: boolean } }> }
    ).calls[0].opts
    expect(opts.pooling).toBe('cls')
    expect(opts.normalize).toBe(false)
  })

  it('applies the query/document prefix', async () => {
    const pipe = makeFakePipeline([[1]])
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      queryPrefix: 'Q: ',
    })
    await a.embed('hello', { kind: 'query' })
    const input = (pipe as unknown as { calls: Array<{ input: string[] }> }).calls[0].input
    expect(input).toEqual(['Q: hello'])
  })

  it('empty input returns []', async () => {
    const pipe = makeFakePipeline([[1]])
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', pipeline: pipe as never })
    expect(await a.embedMany([])).toEqual([])
    expect((pipe as unknown as { calls: unknown[] }).calls).toHaveLength(0)
  })

  it('dimensions getter reflects options', () => {
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      dimensions: 384,
      pipeline: makeFakePipeline([[1]]) as never,
    })
    expect(a.dimensions).toBe(384)
  })

  it('lazy createPipeline is single-flight (called once across concurrent embeds)', async () => {
    const pipe = makeFakePipeline([[1]])
    const createPipeline = vi.fn(async () => pipe as never)
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', createPipeline })
    await Promise.all([a.embed('a'), a.embed('b')])
    expect(createPipeline).toHaveBeenCalledOnce()
  })

  it('wraps a vector-count mismatch in an engine error', async () => {
    const pipe = makeFakePipeline([[1]]) // returns 1 vector
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.embedMany(['a', 'b'])).rejects.toThrow(E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR)
  })

  it('wraps a pipeline load failure in an engine error', async () => {
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('boom')
      },
    })
    await expect(a.embed('x')).rejects.toThrow(E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR)
  })
})
