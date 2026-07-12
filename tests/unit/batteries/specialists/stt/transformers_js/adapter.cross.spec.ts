import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsSttAdapter,
  E_INVALID_TRANSFORMERS_JS_STT_OPTIONS,
  E_TRANSFORMERS_JS_STT_ENGINE_ERROR,
} from '@nhtio/adk/batteries/specialists/stt/transformers_js'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/specialists/stt/transformers_js'

// A fake automatic-speech-recognition pipeline: a callable returning `{ text, chunks? }`.
const makeFakePipeline = (output: { text: string; chunks?: unknown[] }) => {
  const calls: Array<{ audio: unknown; opts: unknown }> = []
  const fn = vi.fn(async (audio: unknown, opts: unknown) => {
    calls.push({ audio, opts })
    return output
  })
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

describe('TransformersJsSttAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TransformersJsSttAdapter.isAvailable()).toBe(true)
  })
  it('requires a model', () => {
    expect(() => new TransformersJsSttAdapter({})).toThrow(E_INVALID_TRANSFORMERS_JS_STT_OPTIONS)
  })
  it('rejects unknown keys', () => {
    expect(() => new TransformersJsSttAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_STT_OPTIONS
    )
  })
})

describe('TransformersJsSttAdapter — audio normalization', () => {
  it('PCM at 16 kHz passes through unresampled (exact Float32Array received)', async () => {
    const pipe = makeFakePipeline({ text: 'hello' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    const pcm = new Float32Array([0.1, 0.2, 0.3, 0.4])
    await a.transcribe({ pcm, sampleRate: 16000 })
    const received = (pipe as unknown as { calls: Array<{ audio: Float32Array }> }).calls[0].audio
    expect(received).toBe(pcm) // same reference — resampleTo no-ops when fromRate === toRate
  })

  it('PCM at 48 kHz gets resampled down to 16 kHz (length check)', async () => {
    const pipe = makeFakePipeline({ text: 'hello' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    const pcm = new Float32Array(4800) // 0.1s @ 48kHz
    await a.transcribe({ pcm, sampleRate: 48000 })
    const received = (pipe as unknown as { calls: Array<{ audio: Float32Array }> }).calls[0].audio
    expect(received).not.toBe(pcm)
    expect(received.length).toBe(1600) // 0.1s @ 16kHz
  })

  it('bytes input invokes decodeAudio then resamples', async () => {
    const pipe = makeFakePipeline({ text: 'hello' })
    const decodedPcm = new Float32Array(8000) // 0.25s @ 32kHz
    const decodeAudio = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes).toBeInstanceOf(Uint8Array)
      return { pcm: decodedPcm, sampleRate: 32000 }
    })
    const a = new TransformersJsSttAdapter({
      model: 'm',
      pipeline: pipe as never,
      decodeAudio,
    })
    await a.transcribe(new Uint8Array([1, 2, 3, 4]))
    expect(decodeAudio).toHaveBeenCalledOnce()
    const received = (pipe as unknown as { calls: Array<{ audio: Float32Array }> }).calls[0].audio
    expect(received.length).toBe(4000) // 0.25s @ 16kHz
  })
})

describe('TransformersJsSttAdapter — option mapping', () => {
  it('maps language/translate/timestamps onto the pipeline call, plus default chunk_length_s', async () => {
    const pipe = makeFakePipeline({ text: 'bonjour' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    await a.transcribe(
      { pcm: new Float32Array([0, 0]), sampleRate: 16000 },
      { language: 'french', translate: true, timestamps: true }
    )
    const opts = (
      pipe as unknown as {
        calls: Array<{
          opts: {
            language?: string
            task?: string
            return_timestamps?: boolean
            chunk_length_s?: number
          }
        }>
      }
    ).calls[0].opts
    expect(opts.language).toBe('french')
    expect(opts.task).toBe('translate')
    expect(opts.return_timestamps).toBe(true)
    expect(opts.chunk_length_s).toBe(30)
  })

  it('omits language/task/return_timestamps when not requested', async () => {
    const pipe = makeFakePipeline({ text: 'hi' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    const opts = (
      pipe as unknown as {
        calls: Array<{ opts: Record<string, unknown> }>
      }
    ).calls[0].opts
    expect(opts.language).toBeUndefined()
    expect(opts.task).toBeUndefined()
    expect(opts.return_timestamps).toBeUndefined()
  })

  it('respects a custom chunkLengthS', async () => {
    const pipe = makeFakePipeline({ text: 'hi' })
    const a = new TransformersJsSttAdapter({
      model: 'm',
      pipeline: pipe as never,
      chunkLengthS: 15,
    })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    const opts = (pipe as unknown as { calls: Array<{ opts: { chunk_length_s: number } }> })
      .calls[0].opts
    expect(opts.chunk_length_s).toBe(15)
  })
})

describe('TransformersJsSttAdapter — result mapping', () => {
  it('returns text only when timestamps were not requested', async () => {
    const pipe = makeFakePipeline({ text: 'hello world' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(result).toEqual({ text: 'hello world' })
  })

  it('maps chunks to segments including a null end', async () => {
    const pipe = makeFakePipeline({
      text: 'hello world',
      chunks: [
        { timestamp: [0, 1.5], text: 'hello' },
        { timestamp: [1.5, null], text: ' world' },
      ],
    })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.transcribe(
      { pcm: new Float32Array([0]), sampleRate: 16000 },
      { timestamps: true }
    )
    expect(result.text).toBe('hello world')
    expect(result.segments).toEqual([
      { start: 0, end: 1.5, text: 'hello' },
      { start: 1.5, end: null, text: ' world' },
    ] satisfies typeof result.segments)
  })

  it('does not populate segments when timestamps requested but no chunks returned', async () => {
    const pipe = makeFakePipeline({ text: 'hello' })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    const result = await a.transcribe(
      { pcm: new Float32Array([0]), sampleRate: 16000 },
      { timestamps: true }
    )
    expect(result.segments).toBeUndefined()
  })
})

describe('TransformersJsSttAdapter — error handling', () => {
  it('wraps an engine throw in an engine error with cause preserved', async () => {
    const cause = new Error('boom')
    const pipe = vi.fn(async () => {
      throw cause
    })
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })).rejects.toThrow(
      E_TRANSFORMERS_JS_STT_ENGINE_ERROR
    )
    try {
      await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('boom')
    }
  })

  it('wraps a pipeline load failure in an engine error', async () => {
    const a = new TransformersJsSttAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
    })
    await expect(a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })).rejects.toThrow(
      E_TRANSFORMERS_JS_STT_ENGINE_ERROR
    )
  })

  it('wraps a malformed pipeline result in an engine error', async () => {
    const pipe = vi.fn(async () => ({}) as never)
    const a = new TransformersJsSttAdapter({ model: 'm', pipeline: pipe as never })
    await expect(a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })).rejects.toThrow(
      E_TRANSFORMERS_JS_STT_ENGINE_ERROR
    )
  })
})

describe('TransformersJsSttAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase) via createPipeline', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const a = new TransformersJsSttAdapter({
      model: 'fam/stt',
      createPipeline: async () => makeFakePipeline({ text: 'hi' }) as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=transformers_js_stt + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const a = new TransformersJsSttAdapter({
      model: 'fam/stt',
      createPipeline: async () => makeFakePipeline({ text: 'hi' }) as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js_stt')
      expect(r.model).toBe('fam/stt')
    }
  })

  it('emits error (not complete) when the pipeline load fails', async () => {
    const phases: string[] = []
    const a = new TransformersJsSttAdapter({
      model: 'm',
      createPipeline: async () => {
        throw new Error('load boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })).rejects.toThrow(
      E_TRANSFORMERS_JS_STT_ENGINE_ERROR
    )
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('forwards onInitProgress into a normalized loading report', async () => {
    const loading: BatteryLifecycleReport[] = []
    const a = new TransformersJsSttAdapter({
      model: 'm',
      onLoading: (r: BatteryLifecycleReport) => loading.push(r),
      createPipeline: async (input: { onInitProgress?: (info: unknown) => void }) => {
        input.onInitProgress?.({ status: 'progress', file: 'model.onnx', progress: 42 })
        return makeFakePipeline({ text: 'hi' }) as never
      },
    })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    const withProgress = loading.find((r) => typeof r.progress === 'number')
    expect(withProgress?.progress).toBeCloseTo(0.42, 5)
  })

  it('a throwing consumer hook does not break transcribe', async () => {
    const a = new TransformersJsSttAdapter({
      model: 'm',
      pipeline: makeFakePipeline({ text: 'ok' }) as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    const result = await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(result.text).toBe('ok')
  })
})

describe('TransformersJsSttAdapter — preload / reset / dispose', () => {
  it('preload resolves the pipeline once; single-flight across concurrent transcribe calls', async () => {
    const pipe = makeFakePipeline({ text: 'hi' })
    const createPipeline = vi.fn(async () => pipe as never)
    const a = new TransformersJsSttAdapter({ model: 'm', createPipeline })
    await Promise.all([
      a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 }),
      a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 }),
    ])
    expect(createPipeline).toHaveBeenCalledOnce()
  })

  it('reset() drops the cached pipeline so the next call reloads', async () => {
    let loads = 0
    const createPipeline = vi.fn(async () => {
      loads += 1
      return makeFakePipeline({ text: 'hi' }) as never
    })
    const a = new TransformersJsSttAdapter({ model: 'm', createPipeline })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(loads).toBe(1)
    a.reset()
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(loads).toBe(2)
  })

  it('dispose() awaits the loaded pipeline.dispose() then forces a fresh re-load', async () => {
    let loads = 0
    const dispose = vi.fn(async () => undefined)
    const createPipeline = vi.fn(async () => {
      loads += 1
      const pipe = makeFakePipeline({ text: 'hi' })
      ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = dispose
      return pipe as never
    })
    const a = new TransformersJsSttAdapter({ model: 'm', createPipeline })
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(loads).toBe(1)
    await a.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    await a.transcribe({ pcm: new Float32Array([0]), sampleRate: 16000 })
    expect(loads).toBe(2)
  })

  it('dispose() is a no-op (no throw) when nothing has been loaded', async () => {
    const a = new TransformersJsSttAdapter({ model: 'm', createPipeline: vi.fn() })
    await expect(a.dispose()).resolves.toBeUndefined()
  })
})
