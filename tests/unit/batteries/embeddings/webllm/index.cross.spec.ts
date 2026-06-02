import { describe, expect, it, vi } from 'vitest'
import {
  WebLLMEmbeddingsAdapter,
  E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS,
  E_WEBLLM_EMBEDDINGS_ENGINE_ERROR,
} from '../../../../../src/batteries/embeddings/webllm'

// ─── fake engine ────────────────────────────────────────────────────────────────

// Minimal stand-in for an MLCEngineInterface exposing only `embeddings.create`. Returns
// one vector [i, i, i] per input, in input order.
const makeFakeEngine = (impl?: (input: string[]) => unknown) => {
  const create = vi.fn(async ({ input }: { input: string[] }) => {
    if (impl) return impl(input)
    return {
      object: 'list',
      data: input.map((_, i) => ({ object: 'embedding', index: i, embedding: [i, i, i] })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }
  })
  return { engine: { embeddings: { create } } as never, create }
}

const alwaysAvailable = () => true

// ─── construction / validation ─────────────────────────────────────────────────

describe('WebLLMEmbeddingsAdapter — construction', () => {
  it('throws E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS when model is missing', () => {
    expect(() => new WebLLMEmbeddingsAdapter({})).toThrow(E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS)
  })

  it('throws when model is empty', () => {
    expect(() => new WebLLMEmbeddingsAdapter({ model: '' })).toThrow(
      E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS
    )
  })

  it('throws on unknown option keys', () => {
    expect(() => new WebLLMEmbeddingsAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS
    )
  })

  it('constructs with a valid model and reports dimensions', () => {
    const a = new WebLLMEmbeddingsAdapter({
      model: 'snowflake-arctic-embed-m-q0f32-MLC',
      dimensions: 768,
    })
    expect(a.dimensions).toBe(768)
  })
})

// ─── availability gating ─────────────────────────────────────────────────────────

describe('WebLLMEmbeddingsAdapter — availability', () => {
  it('honors an injected isWebGPUAvailable probe', () => {
    const a = new WebLLMEmbeddingsAdapter({ model: 'm', isWebGPUAvailable: () => false })
    expect(a.isAvailable()).toBe(false)
  })

  it('throws E_INVALID when no WebGPU and no engine is injected', async () => {
    const a = new WebLLMEmbeddingsAdapter({ model: 'm', isWebGPUAvailable: () => false })
    await expect(a.embed('x')).rejects.toThrow(E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS)
  })

  it('uses an injected engine even when WebGPU probe is false', async () => {
    const { engine } = makeFakeEngine()
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: () => false,
    })
    const vec = await a.embed('x')
    expect(vec).toEqual([0, 0, 0])
  })
})

// ─── embed / embedMany ───────────────────────────────────────────────────────────

describe('WebLLMEmbeddingsAdapter — embed', () => {
  it('embeds via the engine and returns number[]', async () => {
    const { engine, create } = makeFakeEngine()
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    const vec = await a.embed('hello')
    expect(vec).toEqual([0, 0, 0])
    expect(create).toHaveBeenCalledWith({ model: 'm', input: ['hello'] })
  })

  it('embedMany returns one vector per input in order', async () => {
    const { engine } = makeFakeEngine()
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    const vecs = await a.embedMany(['a', 'b', 'c'])
    expect(vecs.length).toBe(3)
    expect(vecs[2]).toEqual([2, 2, 2])
  })

  it('reorders out-of-order engine results by index', async () => {
    const { engine } = makeFakeEngine(() => ({
      data: [
        { index: 1, embedding: [1, 1] },
        { index: 0, embedding: [0, 0] },
      ],
    }))
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    const vecs = await a.embedMany(['x', 'y'])
    expect(vecs[0]).toEqual([0, 0])
    expect(vecs[1]).toEqual([1, 1])
  })

  it('returns [] for an empty batch without calling the engine', async () => {
    const { engine, create } = makeFakeEngine()
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    expect(await a.embedMany([])).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  it('applies queryPrefix only for kind: query', async () => {
    const { engine, create } = makeFakeEngine()
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      queryPrefix: 'Q: ',
      isWebGPUAvailable: alwaysAvailable,
    })
    await a.embed('cats', { kind: 'query' })
    expect(create).toHaveBeenCalledWith({ model: 'm', input: ['Q: cats'] })
    await a.embed('dogs')
    expect(create).toHaveBeenLastCalledWith({ model: 'm', input: ['dogs'] })
  })
})

// ─── engine lifecycle ────────────────────────────────────────────────────────────

describe('WebLLMEmbeddingsAdapter — engine lifecycle', () => {
  it('preload resolves the engine via createEngine (single-flight)', async () => {
    const { engine } = makeFakeEngine()
    const createEngine = vi.fn(async () => engine)
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      createEngine,
      isWebGPUAvailable: alwaysAvailable,
    })
    await Promise.all([a.preload(), a.preload()])
    await a.embed('x')
    // One creation shared across preload calls + embed.
    expect(createEngine).toHaveBeenCalledTimes(1)
  })

  it('reset forces a fresh engine creation on next use', async () => {
    const { engine } = makeFakeEngine()
    const createEngine = vi.fn(async () => engine)
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      createEngine,
      isWebGPUAvailable: alwaysAvailable,
    })
    await a.preload()
    a.reset()
    await a.preload()
    expect(createEngine).toHaveBeenCalledTimes(2)
  })

  it('wraps a createEngine failure in E_WEBLLM_EMBEDDINGS_ENGINE_ERROR', async () => {
    const createEngine = vi.fn(async () => {
      throw new Error('webgpu OOM')
    })
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      createEngine,
      isWebGPUAvailable: alwaysAvailable,
    })
    await expect(a.embed('x')).rejects.toThrow(E_WEBLLM_EMBEDDINGS_ENGINE_ERROR)
  })

  it('wraps an engine.embeddings.create failure in ENGINE_ERROR', async () => {
    const { engine } = makeFakeEngine(() => {
      throw new Error('inference failed')
    })
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    await expect(a.embed('x')).rejects.toThrow(E_WEBLLM_EMBEDDINGS_ENGINE_ERROR)
  })

  it('throws ENGINE_ERROR when the engine returns a mismatched vector count', async () => {
    const { engine } = makeFakeEngine(() => ({ data: [{ index: 0, embedding: [0] }] }))
    const a = new WebLLMEmbeddingsAdapter({
      model: 'm',
      engine,
      isWebGPUAvailable: alwaysAvailable,
    })
    await expect(a.embedMany(['a', 'b'])).rejects.toThrow(E_WEBLLM_EMBEDDINGS_ENGINE_ERROR)
  })
})
