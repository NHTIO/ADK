import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsCaptionAdapter,
  E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS,
  E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR,
} from '@nhtio/adk/batteries/specialists/caption/transformers_js'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/specialists/caption/transformers_js'

// A fake image-to-text pipeline: a callable receiving whatever image value the adapter built (here,
// a `Blob` — see the adapter's remarks on why no `RawImage`/peer import is needed for the fake-pipeline
// path) plus the forwarded options. Mirrors the embeddings battery's own fake-pipeline test style.
const makeFakePipeline = (output: { generated_text: string }[] | { generated_text: string }) => {
  const calls: Array<{ image: unknown; opts: unknown }> = []
  const fn = vi.fn(async (image: unknown, opts: unknown) => {
    calls.push({ image, opts })
    return output
  })
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('TransformersJsCaptionAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TransformersJsCaptionAdapter.isAvailable()).toBe(true)
  })

  it('requires a model', () => {
    expect(() => new TransformersJsCaptionAdapter({})).toThrow(
      E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS
    )
  })

  it('rejects unknown keys', () => {
    expect(() => new TransformersJsCaptionAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS
    )
  })

  it('rejects an empty model string', () => {
    expect(() => new TransformersJsCaptionAdapter({ model: '' })).toThrow(
      E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS
    )
  })
})

describe('TransformersJsCaptionAdapter — describe', () => {
  it('returns the caption text from an array result', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'a cat on a couch' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.describe(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ text: 'a cat on a couch' })
  })

  it('tolerates a single-result-object shape (not wrapped in an array)', async () => {
    const pipe = makeFakePipeline({ generated_text: 'a dog in a park' })
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.describe(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ text: 'a dog in a park' })
  })

  it('passes SOMETHING image-shaped to the pipeline (a Blob), without loading the real peer', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'x' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await a.describe({ bytes: new Uint8Array([9, 9]), mimeType: 'image/png' })
    const calls = (pipe as unknown as { calls: Array<{ image: unknown }> }).calls
    expect(calls).toHaveLength(1)
    expect(calls[0].image).toBeInstanceOf(Blob)
  })

  it('forwards maxNewTokens as max_new_tokens', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'x' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await a.describe(new Uint8Array([1]), { maxNewTokens: 42 })
    const opts = (pipe as unknown as { calls: Array<{ opts: { max_new_tokens?: number } }> })
      .calls[0].opts
    expect(opts).toEqual({ max_new_tokens: 42 })
  })

  it('omits max_new_tokens when maxNewTokens is unset', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'x' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await a.describe(new Uint8Array([1]))
    const opts = (pipe as unknown as { calls: Array<{ opts: unknown }> }).calls[0].opts
    expect(opts).toBeUndefined()
  })

  it('accepts a SpecialistMediaLike input via asBytes()', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'from media' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    const media = { mimeType: 'image/jpeg', asBytes: async () => new Uint8Array([1, 2]) }
    const result = await a.describe(media)
    expect(result).toEqual({ text: 'from media' })
  })

  it('throws an engine error when generated_text is empty', async () => {
    const pipe = makeFakePipeline([{ generated_text: '' }])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
  })

  it('throws an engine error when generated_text is missing', async () => {
    const pipe = makeFakePipeline([{} as never])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
  })

  it('throws an engine error when the result array is empty', async () => {
    const pipe = makeFakePipeline([])
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
  })

  it('wraps an engine throw with cause', async () => {
    const cause = new Error('boom')
    const pipe = vi.fn(async () => {
      throw cause
    })
    const a = new TransformersJsCaptionAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
    try {
      await a.describe(new Uint8Array([1]))
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('boom')
    }
  })

  it('wraps a pipeline load failure in an engine error', async () => {
    const a = new TransformersJsCaptionAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
    })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
  })

  it('lazy createPipeline is single-flight (called once across concurrent describes)', async () => {
    const pipe = makeFakePipeline([{ generated_text: 'x' }])
    const createPipeline = vi.fn(async () => pipe as never)
    const a = new TransformersJsCaptionAdapter({ model: 'm', createPipeline })
    await Promise.all([a.describe(new Uint8Array([1])), a.describe(new Uint8Array([2]))])
    expect(createPipeline).toHaveBeenCalledOnce()
  })
})

describe('TransformersJsCaptionAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const a = new TransformersJsCaptionAdapter({
      model: 'fam/caption',
      createPipeline: async () => makeFakePipeline([{ generated_text: 'x' }]) as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.describe(new Uint8Array([1]))
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=transformers_js_caption + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const a = new TransformersJsCaptionAdapter({
      model: 'fam/caption',
      createPipeline: async () => makeFakePipeline([{ generated_text: 'x' }]) as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.describe(new Uint8Array([1]))
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js_caption')
      expect(r.model).toBe('fam/caption')
    }
  })

  it('emits error (not complete) when the pipeline load fails', async () => {
    const phases: string[] = []
    const a = new TransformersJsCaptionAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('emits error (not complete) when generated_text is empty', async () => {
    const phases: string[] = []
    const a = new TransformersJsCaptionAdapter({
      model: 'm',
      pipeline: makeFakePipeline([{ generated_text: '' }]) as never,
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.describe(new Uint8Array([1]))).rejects.toThrow(
      E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR
    )
    expect(phases).toContain('generating')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('a throwing consumer hook does not break describe', async () => {
    const a = new TransformersJsCaptionAdapter({
      model: 'm',
      pipeline: makeFakePipeline([{ generated_text: 'ok' }]) as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    expect(await a.describe(new Uint8Array([1]))).toEqual({ text: 'ok' })
  })
})

describe('TransformersJsCaptionAdapter — reset / dispose', () => {
  it('reset() drops the cached pipeline so the next describe re-resolves', async () => {
    let loads = 0
    const createPipeline = vi.fn(async () => {
      loads += 1
      return makeFakePipeline([{ generated_text: 'x' }]) as never
    })
    const a = new TransformersJsCaptionAdapter({ model: 'm', createPipeline })
    await a.describe(new Uint8Array([1]))
    expect(loads).toBe(1)
    a.reset()
    await a.describe(new Uint8Array([1]))
    expect(loads).toBe(2)
  })

  it('dispose() awaits the loaded pipeline.dispose() then forces a fresh re-load', async () => {
    let loads = 0
    const dispose = vi.fn(async () => [])
    const createPipeline = vi.fn(async () => {
      loads += 1
      const pipe = makeFakePipeline([{ generated_text: 'x' }])
      ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = dispose
      return pipe as never
    })
    const a = new TransformersJsCaptionAdapter({ model: 'm', createPipeline })
    expect(await a.describe(new Uint8Array([1]))).toEqual({ text: 'x' })
    expect(loads).toBe(1)
    await a.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    await a.describe(new Uint8Array([1]))
    expect(loads).toBe(2)
  })

  it('dispose() is a no-op (no throw) when nothing has been loaded', async () => {
    const a = new TransformersJsCaptionAdapter({ model: 'm', createPipeline: vi.fn() })
    await expect(a.dispose()).resolves.toBeUndefined()
  })

  it('preload() eagerly resolves the pipeline', async () => {
    const createPipeline = vi.fn(async () => makeFakePipeline([{ generated_text: 'x' }]) as never)
    const a = new TransformersJsCaptionAdapter({ model: 'm', createPipeline })
    await a.preload()
    expect(createPipeline).toHaveBeenCalledOnce()
    await a.describe(new Uint8Array([1]))
    expect(createPipeline).toHaveBeenCalledOnce() // still cached, no second load
  })
})
