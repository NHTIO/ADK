import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsTtsAdapter,
  E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS,
  E_TRANSFORMERS_JS_TTS_ENGINE_ERROR,
} from '@nhtio/adk/batteries/tts/transformers_js'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/tts/transformers_js'

// Minimal WAV header (44 bytes) so `bytes` has a concrete value to assert against.
const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
])

const makeFakePipeline = (output?: { toBlob: () => Blob }) => {
  const calls: Array<{ text: string; opts: Record<string, unknown> }> = []
  const fn = vi.fn(async (text: string, opts: Record<string, unknown>) => {
    calls.push({ text, opts })
    return output ?? { toBlob: () => new Blob([wavBytes], { type: 'audio/wav' }) }
  })
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('TransformersJsTtsAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TransformersJsTtsAdapter.isAvailable()).toBe(true)
  })

  it('requires a model', () => {
    expect(() => new TransformersJsTtsAdapter({})).toThrow(E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS)
  })

  it('rejects an empty model', () => {
    expect(() => new TransformersJsTtsAdapter({ model: '' })).toThrow(
      E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS
    )
  })

  it('rejects unknown keys', () => {
    expect(() => new TransformersJsTtsAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS
    )
  })
})

describe('TransformersJsTtsAdapter — option mapping', () => {
  it('maps voice string → speaker_embeddings, rate → speed, numInferenceSteps → num_inference_steps', async () => {
    const pipe = makeFakePipeline()
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      pipeline: pipe as never,
      voice: 'spk-1',
      rate: 1.2,
      numInferenceSteps: 50,
    })
    await a.synthesize('hello')
    const opts = (pipe as unknown as { calls: Array<{ opts: Record<string, unknown> }> }).calls[0]
      .opts
    expect(opts.speaker_embeddings).toBe('spk-1')
    expect(opts.speed).toBe(1.2)
    expect(opts.num_inference_steps).toBe(50)
  })

  it('uses Float32Array speaker embeddings verbatim', async () => {
    const pipe = makeFakePipeline()
    const embeddings = new Float32Array([0.1, 0.2, 0.3])
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      pipeline: pipe as never,
      speakerEmbeddings: embeddings,
    })
    await a.synthesize('hi')
    const opts = (pipe as unknown as { calls: Array<{ opts: Record<string, unknown> }> }).calls[0]
      .opts
    expect(opts.speaker_embeddings).toBe(embeddings)
    expect(opts.voice).toBeUndefined()
  })

  it('omits undefined pipeline keys when no constructor or per-call values are provided', async () => {
    const pipe = makeFakePipeline()
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await a.synthesize('hello')
    const opts = (pipe as unknown as { calls: Array<{ opts: Record<string, unknown> }> }).calls[0]
      .opts
    expect(opts.speaker_embeddings).toBeUndefined()
    expect(opts.speed).toBeUndefined()
    expect(opts.num_inference_steps).toBeUndefined()
  })

  it('per-call options override constructor defaults', async () => {
    const pipe = makeFakePipeline()
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      pipeline: pipe as never,
      voice: 'ctor-voice',
      rate: 1.0,
      numInferenceSteps: 25,
      speakerEmbeddings: new Float32Array([1]),
    })
    await a.synthesize('hello', {
      voice: 'call-voice',
      rate: 1.5,
      numInferenceSteps: 75,
      speakerEmbeddings: new Float32Array([2, 3]),
    })
    const opts = (pipe as unknown as { calls: Array<{ opts: Record<string, unknown> }> }).calls[0]
      .opts
    expect(opts.speaker_embeddings).toEqual(new Float32Array([2, 3]))
    expect(opts.speed).toBe(1.5)
    expect(opts.num_inference_steps).toBe(75)
  })

  it('passes the input text verbatim', async () => {
    const pipe = makeFakePipeline()
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await a.synthesize('hello world')
    const call = (pipe as unknown as { calls: Array<{ text: string }> }).calls[0]
    expect(call.text).toBe('hello world')
  })
})

describe('TransformersJsTtsAdapter — result mapping', () => {
  it('returns a GeneratedMediaOutput with kind audio, WAV bytes, and default filename', async () => {
    const pipe = makeFakePipeline()
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.synthesize('hello')
    expect(result.kind).toBe('audio')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.filename).toBe('speech.wav')
    expect(result.bytes).toEqual(wavBytes)
  })

  it('falls back to audio/wav when the blob has no type', async () => {
    const pipe = makeFakePipeline({ toBlob: () => new Blob([wavBytes], { type: '' }) })
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.synthesize('hello')
    expect(result.mimeType).toBe('audio/wav')
  })

  it('throws ENGINE_ERROR when the result lacks toBlob', async () => {
    const pipe = vi.fn(async () => ({}) as never)
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.synthesize('hello')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
  })

  it('throws ENGINE_ERROR (not a raw TypeError) when the result is null', async () => {
    const pipe = vi.fn(async () => null as never)
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.synthesize('hello')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
  })

  it('wraps a throwing toBlob() in ENGINE_ERROR', async () => {
    const pipe = makeFakePipeline({
      toBlob: () => {
        throw new Error('encode boom')
      },
    })
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.synthesize('hello')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
    try {
      await a.synthesize('hello')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('encode boom')
    }
  })

  it('wraps a rejecting blob.arrayBuffer() in ENGINE_ERROR', async () => {
    const badBlob = {
      type: 'audio/wav',
      arrayBuffer: () => Promise.reject(new Error('arraybuffer boom')),
    } as unknown as Blob
    const pipe = makeFakePipeline({ toBlob: () => badBlob })
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.synthesize('hello')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
  })
})

describe('TransformersJsTtsAdapter — error handling', () => {
  it('wraps a pipeline throw in an engine error with message preserved', async () => {
    const cause = new Error('boom')
    const pipe = vi.fn(async () => {
      throw cause
    })
    const a = new TransformersJsTtsAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.synthesize('hi')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('boom')
    }
  })

  it('wraps a pipeline load failure in an engine error', async () => {
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
    })
    await expect(a.synthesize('hi')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
  })
})

describe('TransformersJsTtsAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const a = new TransformersJsTtsAdapter({
      model: 'fam/tts',
      createPipeline: async () => makeFakePipeline() as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.synthesize('hi')
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=transformers_js_tts + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const a = new TransformersJsTtsAdapter({
      model: 'fam/tts',
      createPipeline: async () => makeFakePipeline() as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.synthesize('hi')
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js_tts')
      expect(r.model).toBe('fam/tts')
    }
  })

  it('emits error (not complete) when pipeline load fails', async () => {
    const phases: string[] = []
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.synthesize('hi')).rejects.toThrow(E_TRANSFORMERS_JS_TTS_ENGINE_ERROR)
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('forwards onInitProgress into a normalized loading report', async () => {
    const loading: BatteryLifecycleReport[] = []
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      onLoading: (r: BatteryLifecycleReport) => loading.push(r),
      createPipeline: async (input: { onInitProgress?: (info: unknown) => void }) => {
        input.onInitProgress?.({ status: 'progress', file: 'model.onnx', progress: 42 })
        return makeFakePipeline() as never
      },
    })
    await a.synthesize('hi')
    const withProgress = loading.find((r) => typeof r.progress === 'number')
    expect(withProgress?.progress).toBeCloseTo(0.42, 5)
  })

  it('a throwing consumer hook does not break synthesize', async () => {
    const a = new TransformersJsTtsAdapter({
      model: 'm',
      pipeline: makeFakePipeline() as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    const result = await a.synthesize('ok')
    expect(result.kind).toBe('audio')
  })
})

describe('TransformersJsTtsAdapter — preload / reset / dispose', () => {
  it('preload resolves the pipeline once; single-flight across concurrent synthesize calls', async () => {
    const pipe = makeFakePipeline()
    const createPipeline = vi.fn(async () => pipe as never)
    const a = new TransformersJsTtsAdapter({ model: 'm', createPipeline })
    await Promise.all([a.synthesize('a'), a.synthesize('b')])
    expect(createPipeline).toHaveBeenCalledTimes(1)
  })

  it('reset() drops the cached pipeline so the next call reloads', async () => {
    let loads = 0
    const createPipeline = vi.fn(async () => {
      loads += 1
      return makeFakePipeline() as never
    })
    const a = new TransformersJsTtsAdapter({ model: 'm', createPipeline })
    await a.synthesize('a')
    expect(loads).toBe(1)
    a.reset()
    await a.synthesize('b')
    expect(loads).toBe(2)
  })

  it('dispose() awaits the loaded pipeline.dispose() then forces a fresh re-load', async () => {
    let loads = 0
    const dispose = vi.fn(async () => undefined)
    const createPipeline = vi.fn(async () => {
      loads += 1
      const pipe = makeFakePipeline()
      ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = dispose
      return pipe as never
    })
    const a = new TransformersJsTtsAdapter({ model: 'm', createPipeline })
    await a.synthesize('a')
    expect(loads).toBe(1)
    await a.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    await a.synthesize('b')
    expect(loads).toBe(2)
  })

  it('dispose() is a no-op (no throw) when nothing has been loaded', async () => {
    const a = new TransformersJsTtsAdapter({ model: 'm', createPipeline: vi.fn() })
    await expect(a.dispose()).resolves.toBeUndefined()
  })
})
