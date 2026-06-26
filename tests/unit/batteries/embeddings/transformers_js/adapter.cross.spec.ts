import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsEmbeddingsAdapter,
  E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS,
  E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR,
} from '@nhtio/adk/batteries/embeddings/transformers_js'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/embeddings/transformers_js'

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

// A fake pipeline that returns RAW [batch, seq, hidden] token states (what `pooling:'none'` yields).
const makeRawStatesPipeline = (states: number[][][]) => {
  const calls: Array<{ input: unknown; opts: unknown }> = []
  const fn = vi.fn(async (input: unknown, opts: unknown) => {
    calls.push({ input, opts })
    return {
      tolist: () => states,
      dims: [states.length, states[0]?.length ?? 0, states[0]?.[0]?.length ?? 0],
    }
  })
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('TransformersJsEmbeddingsAdapter — poolingOwner', () => {
  it("'engine' (default) delegates pooling+normalize to the pipeline (unchanged behavior)", async () => {
    const pipe = makeFakePipeline([[0.6, 0.8]])
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', pipeline: pipe as never })
    const v = await a.embed('x')
    const opts = (pipe as unknown as { calls: Array<{ opts: { pooling: string } }> }).calls[0].opts
    expect(opts.pooling).toBe('mean')
    expect(v).toEqual([0.6, 0.8]) // returned verbatim from the engine
  })

  it("'battery' requests raw states and mean-pools + L2-normalizes deterministically", async () => {
    // Two tokens; mean = [2,0] → L2-normalize → [1,0].
    const pipe = makeRawStatesPipeline([
      [
        [3, 0],
        [1, 0],
      ],
    ])
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      poolingOwner: 'battery',
    })
    const v = await a.embed('x')
    const opts = (pipe as unknown as { calls: Array<{ opts: { pooling: string } }> }).calls[0].opts
    expect(opts.pooling).toBe('none') // raw states requested
    expect(v[0]).toBeCloseTo(1, 6)
    expect(v[1]).toBeCloseTo(0, 6)
  })

  it("'battery' with normalize:false returns the raw mean (no unit norm)", async () => {
    const pipe = makeRawStatesPipeline([
      [
        [4, 0],
        [2, 0],
      ],
    ])
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      poolingOwner: 'battery',
      normalize: false,
    })
    const v = await a.embed('x')
    expect(v).toEqual([3, 0]) // mean of 4 and 2
  })

  it("'battery' cls pooling takes the first token", async () => {
    const pipe = makeRawStatesPipeline([
      [
        [9, 9],
        [1, 1],
      ],
    ])
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      poolingOwner: 'battery',
      pooling: 'cls',
      normalize: false,
    })
    expect(await a.embed('x')).toEqual([9, 9])
  })

  it("'battery' handles a single ungrouped [seq, hidden] result by wrapping to one vector", async () => {
    // Some models/ungrouped inputs return [seq, hidden] (2-D) rather than [1, seq, hidden].
    const pipe = makeFakePipeline([
      [2, 0],
      [0, 0],
    ]) // tolist → [[2,0],[0,0]] interpreted as one [seq,hidden]
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: pipe as never,
      poolingOwner: 'battery',
      normalize: false,
    })
    const out = await a.embedMany(['x'])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual([1, 0]) // mean of [2,0] and [0,0]
  })
})

// ─── lifecycle hooks ────────────────────────────────────────────────────────────────────────────────

describe('TransformersJsEmbeddingsAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase) via createPipeline', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'fam/embed',
      createPipeline: async () => makeFakePipeline([[1, 0]]) as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.embed('hello')
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=transformers_js_embed + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'fam/embed',
      createPipeline: async () => makeFakePipeline([[1, 0]]) as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.embed('x')
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js_embed')
      expect(r.model).toBe('fam/embed')
    }
  })

  it('emits error (not complete) when the pipeline load fails', async () => {
    const phases: string[] = []
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.embed('x')).rejects.toThrow(E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR)
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('forwards onInitProgress into a normalized loading report', async () => {
    const loading: BatteryLifecycleReport[] = []
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      onLoading: (r: BatteryLifecycleReport) => loading.push(r),
      createPipeline: async (input: { onInitProgress?: (info: unknown) => void }) => {
        input.onInitProgress?.({ status: 'progress', file: 'model.onnx', progress: 73 })
        return makeFakePipeline([[1, 0]]) as never
      },
    })
    await a.embed('x')
    const withProgress = loading.find((r) => typeof r.progress === 'number')
    expect(withProgress?.progress).toBeCloseTo(0.73, 5)
  })

  it('a throwing consumer hook does not break embedMany', async () => {
    const a = new TransformersJsEmbeddingsAdapter({
      model: 'm',
      pipeline: makeFakePipeline([[0.6, 0.8]]) as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    expect(await a.embed('x')).toEqual([0.6, 0.8])
  })
})

describe('TransformersJsEmbeddingsAdapter — dispose (release ONNX sessions)', () => {
  it('awaits the loaded pipeline.dispose() then forces a fresh re-load', async () => {
    let loads = 0
    const dispose = vi.fn(async () => [])
    const createPipeline = vi.fn(async () => {
      loads += 1
      const pipe = makeFakePipeline([[0.6, 0.8]])
      ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = dispose
      return pipe as never
    })
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', createPipeline })
    expect(await a.embed('x')).toEqual([0.6, 0.8])
    expect(loads).toBe(1)
    await a.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    // Cached handle dropped → next embed re-resolves a fresh pipeline (reclaims memory between matrix cells).
    await a.embed('y')
    expect(loads).toBe(2)
  })

  it('is a no-op (no throw) when nothing has been loaded', async () => {
    const a = new TransformersJsEmbeddingsAdapter({ model: 'm', createPipeline: vi.fn() })
    await expect(a.dispose()).resolves.toBeUndefined()
  })
})
