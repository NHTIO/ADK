import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsGenerationAdapter,
  E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS,
  E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR,
  E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION,
} from '../../../../../src/batteries/generation/transformers_js'
import type { BatteryLifecycleReport } from '../../../../../src/batteries/generation/transformers_js'

// ─── fakes ──────────────────────────────────────────────────────────────────────

/** A fake RawImage-like result: exposes neither toBlob nor toSharp — encodeImage must short-circuit. */
const makeFakeRawImage = (tag: string) => ({ __tag: tag })

/** A fake Janus model whose generate_images() returns `count` fake RawImage-like results. */
const makeFakeModel = (count = 1) => {
  const calls: Array<Record<string, unknown>> = []
  const generateImages = vi.fn(async (options: Record<string, unknown>) => {
    calls.push(options)
    return Array.from({ length: count }, (_, i) => makeFakeRawImage(`img-${i}`))
  })
  return { generate_images: generateImages, calls }
}

/** A fake Janus processor: records conversation/options, returns a stub input bag. */
const makeFakeProcessor = (numImageTokens = 576) => {
  const calls: Array<{ conversation: unknown; options: unknown }> = []
  const fn = vi.fn(async (conversation: unknown, options: unknown) => {
    calls.push({ conversation, options })
    return { input_ids: [1, 2, 3], attention_mask: [1, 1, 1] }
  }) as unknown as {
    (conversation: unknown, options?: unknown): Promise<Record<string, unknown>>
    num_image_tokens: number
    calls: typeof calls
  }
  fn.num_image_tokens = numImageTokens
  fn.calls = calls
  return fn
}

const fakeEncodeImage = vi.fn(async (image: unknown) => {
  const tag = (image as { __tag?: string }).__tag ?? 'unknown'
  return new TextEncoder().encode(`png-bytes-${tag}`)
})

// ─── construction / validation ─────────────────────────────────────────────────

describe('TransformersJsGenerationAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TransformersJsGenerationAdapter.isAvailable()).toBe(true)
  })

  it('requires a model', () => {
    expect(() => new TransformersJsGenerationAdapter({})).toThrow(
      E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS
    )
  })

  it('rejects an empty model string', () => {
    expect(() => new TransformersJsGenerationAdapter({ model: '' })).toThrow(
      E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS
    )
  })

  it('rejects unknown top-level keys', () => {
    expect(() => new TransformersJsGenerationAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS
    )
  })

  it('accepts a fully-specified valid options bag', () => {
    expect(
      () =>
        new TransformersJsGenerationAdapter({
          model: 'onnx-community/Janus-Pro-1B-ONNX',
          device: 'wasm',
          dtype: 'q4',
          doSample: true,
          temperature: 1.2,
          topK: 40,
          guidanceScale: 5,
          repetitionPenalty: 1.1,
          chatTemplate: 'text_to_image',
          role: '<|User|>',
        })
    ).not.toThrow()
  })

  it('instance isAvailable() honours an injected override', () => {
    const a = new TransformersJsGenerationAdapter({ model: 'm', isAvailable: () => false })
    expect(a.isAvailable()).toBe(false)
  })
})

// ─── generate() core flow ──────────────────────────────────────────────────────

describe('TransformersJsGenerationAdapter — generate', () => {
  it('builds the processor call with role + chat_template and forwards inputs to generate_images', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor(10)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    await a.generate('a red bicycle')

    expect(processor.calls).toHaveLength(1)
    expect(processor.calls[0].conversation).toEqual([
      { role: '<|User|>', content: 'a red bicycle' },
    ])
    expect(processor.calls[0].options).toEqual({ chat_template: 'text_to_image' })

    expect(model.calls).toHaveLength(1)
    const call = model.calls[0]
    expect(call.input_ids).toEqual([1, 2, 3])
    expect(call.do_sample).toBe(true)
    expect(call.min_new_tokens).toBe(10)
    expect(call.max_new_tokens).toBe(10)
  })

  it('returns one GeneratedMediaOutput per resolved image, PNG-encoded via encodeImage', async () => {
    const model = makeFakeModel(2)
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    const outputs = await a.generate('a cat')
    expect(outputs).toHaveLength(2)
    for (const [i, out] of outputs.entries()) {
      expect(out.kind).toBe('image')
      expect(out.mimeType).toBe('image/png')
      expect(out.filename).toBe(`generated-${i + 1}.png`)
      expect(out.bytes).toBeInstanceOf(Uint8Array)
    }
  })

  it('per-call knob overrides take precedence over adapter-level defaults', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor(8)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
      doSample: false,
      temperature: 0.5,
      topK: 10,
      guidanceScale: 2,
      repetitionPenalty: 1.0,
      chatTemplate: 'default',
      role: '<|Assistant|>',
    })
    await a.generate('prompt', {
      doSample: true,
      temperature: 1.5,
      topK: 50,
      guidanceScale: 6,
      repetitionPenalty: 1.3,
      chatTemplate: 'text_to_image',
      role: '<|User|>',
      minNewTokens: 20,
      maxNewTokens: 30,
    })

    expect(processor.calls[0].conversation).toEqual([{ role: '<|User|>', content: 'prompt' }])
    expect(processor.calls[0].options).toEqual({ chat_template: 'text_to_image' })

    const call = model.calls[0]
    expect(call.do_sample).toBe(true)
    expect(call.temperature).toBe(1.5)
    expect(call.top_k).toBe(50)
    expect(call.guidance_scale).toBe(6)
    expect(call.repetition_penalty).toBe(1.3)
    expect(call.min_new_tokens).toBe(20)
    expect(call.max_new_tokens).toBe(30)
  })

  it('adapter-level defaults are used when a call omits its own knobs', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor(12)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
      doSample: false,
      temperature: 0.7,
      topK: 20,
      guidanceScale: 3,
      repetitionPenalty: 1.2,
      chatTemplate: 'default',
      role: '<|Assistant|>',
    })
    await a.generate('prompt')

    expect(processor.calls[0].conversation).toEqual([{ role: '<|Assistant|>', content: 'prompt' }])
    expect(processor.calls[0].options).toEqual({ chat_template: 'default' })

    const call = model.calls[0]
    expect(call.do_sample).toBe(false)
    expect(call.temperature).toBe(0.7)
    expect(call.top_k).toBe(20)
    expect(call.guidance_scale).toBe(3)
    expect(call.repetition_penalty).toBe(1.2)
    expect(call.min_new_tokens).toBe(12)
    expect(call.max_new_tokens).toBe(12)
  })

  it('do_sample defaults to true when neither call nor adapter specify it', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    await a.generate('prompt')
    expect(model.calls[0].do_sample).toBe(true)
  })

  it('omits optional numeric knobs from generate_images options when unset', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor(5)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    await a.generate('prompt')
    const call = model.calls[0]
    expect(call).not.toHaveProperty('temperature')
    expect(call).not.toHaveProperty('top_k')
    expect(call).not.toHaveProperty('guidance_scale')
    expect(call).not.toHaveProperty('repetition_penalty')
  })

  it('throws an engine error when generate_images returns an empty array', async () => {
    const model = { generate_images: vi.fn(async () => []) }
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
  })

  it('wraps a generate_images throw in an engine error (with cause message preserved)', async () => {
    const model = {
      generate_images: vi.fn(async () => {
        throw new Error('onnx session boom')
      }),
    }
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    try {
      await a.generate('prompt')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
      expect((err as Error).message).toContain('onnx session boom')
    }
  })

  it('wraps a processor call throw in an engine error', async () => {
    const model = makeFakeModel(1)
    const processor = vi.fn(async () => {
      throw new Error('processor boom')
    })
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
  })

  it('wraps an encodeImage throw in an engine error', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: vi.fn(async () => {
        throw new Error('encode boom')
      }) as never,
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
  })

  it('wraps a model/processor load failure in an engine error', async () => {
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      createModel: async () => {
        throw new Error('model load boom')
      },
      createProcessor: async () => makeFakeProcessor() as never,
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
  })

  it('lazy createModel/createProcessor are single-flight across concurrent generate calls', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor()
    const createModel = vi.fn(async () => model as never)
    const createProcessor = vi.fn(async () => processor as never)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      createModel,
      createProcessor,
      encodeImage: fakeEncodeImage as never,
    })
    await Promise.all([a.generate('one'), a.generate('two')])
    expect(createModel).toHaveBeenCalledOnce()
    expect(createProcessor).toHaveBeenCalledOnce()
  })
})

// ─── edit() unsupported ─────────────────────────────────────────────────────────

describe('TransformersJsGenerationAdapter — edit', () => {
  it('always throws E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION', async () => {
    const a = new TransformersJsGenerationAdapter({ model: 'm' })
    await expect(a.edit(new Uint8Array([1]), 'make it blue')).rejects.toThrow(
      E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION
    )
  })

  it('never touches the model/processor factories', async () => {
    const createModel = vi.fn()
    const createProcessor = vi.fn()
    const a = new TransformersJsGenerationAdapter({ model: 'm', createModel, createProcessor })
    await expect(a.edit(new Uint8Array([1]), 'x')).rejects.toThrow()
    expect(createModel).not.toHaveBeenCalled()
    expect(createProcessor).not.toHaveBeenCalled()
  })
})

// ─── lifecycle hooks ────────────────────────────────────────────────────────────

describe('TransformersJsGenerationAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const a = new TransformersJsGenerationAdapter({
      model: 'fam/janus',
      createModel: async () => makeFakeModel(1) as never,
      createProcessor: async () => makeFakeProcessor() as never,
      encodeImage: fakeEncodeImage as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.generate('prompt')
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=transformers_js_generation + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const a = new TransformersJsGenerationAdapter({
      model: 'fam/janus',
      createModel: async () => makeFakeModel(1) as never,
      createProcessor: async () => makeFakeProcessor() as never,
      encodeImage: fakeEncodeImage as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.generate('prompt')
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js_generation')
      expect(r.model).toBe('fam/janus')
    }
  })

  it('emits error (not complete) when the model/processor load fails', async () => {
    const phases: string[] = []
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      createModel: async () => {
        throw new Error('load boom')
      },
      createProcessor: async () => makeFakeProcessor() as never,
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('emits error (not complete) when generate_images fails', async () => {
    const phases: string[] = []
    const model = {
      generate_images: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: makeFakeProcessor() as never,
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.generate('prompt')).rejects.toThrow(E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR)
    expect(phases).toContain('generating')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('a throwing consumer hook does not break generate', async () => {
    const model = makeFakeModel(1)
    const processor = makeFakeProcessor()
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      janusModel: model as never,
      processor: processor as never,
      encodeImage: fakeEncodeImage as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    const result = await a.generate('prompt')
    expect(result).toHaveLength(1)
  })
})

// ─── preload / reset ────────────────────────────────────────────────────────────

describe('TransformersJsGenerationAdapter — preload / reset', () => {
  it('preload() eagerly resolves the model + processor', async () => {
    const createModel = vi.fn(async () => makeFakeModel(1) as never)
    const createProcessor = vi.fn(async () => makeFakeProcessor() as never)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      createModel,
      createProcessor,
      encodeImage: fakeEncodeImage as never,
    })
    await a.preload()
    expect(createModel).toHaveBeenCalledOnce()
    expect(createProcessor).toHaveBeenCalledOnce()
    await a.generate('prompt')
    expect(createModel).toHaveBeenCalledOnce() // still cached, no second load
    expect(createProcessor).toHaveBeenCalledOnce()
  })

  it('reset() drops the cached model/processor so the next generate re-resolves', async () => {
    let loads = 0
    const createModel = vi.fn(async () => {
      loads += 1
      return makeFakeModel(1) as never
    })
    const createProcessor = vi.fn(async () => makeFakeProcessor() as never)
    const a = new TransformersJsGenerationAdapter({
      model: 'm',
      createModel,
      createProcessor,
      encodeImage: fakeEncodeImage as never,
    })
    await a.generate('prompt')
    expect(loads).toBe(1)
    a.reset()
    await a.generate('prompt')
    expect(loads).toBe(2)
  })
})

// ─── helpers.rawImageToEncodedBytes (env-branch + encodeImage seam) ────────────

describe('rawImageToEncodedBytes', () => {
  it('uses the injected encodeImage override, bypassing toBlob/toSharp entirely', async () => {
    const { rawImageToEncodedBytes } =
      await import('../../../../../src/batteries/generation/transformers_js/helpers')
    const image = { __tag: 'x' }
    const encodeImage = vi.fn(async () => new Uint8Array([9, 9, 9]))
    const bytes = await rawImageToEncodedBytes(image as never, encodeImage)
    expect(bytes).toEqual(new Uint8Array([9, 9, 9]))
    expect(encodeImage).toHaveBeenCalledWith(image)
  })

  it('falls back to toSharp() in a non-browser-like env when no encodeImage is given', async () => {
    const { rawImageToEncodedBytes } =
      await import('../../../../../src/batteries/generation/transformers_js/helpers')
    // Uses a plain Uint8Array (not Node's `Buffer`) so this fixture stays environment-neutral — the
    // real `toSharp().png().toBuffer()` resolves a Node Buffer, but `viaSharp` only ever wraps the
    // result in `new Uint8Array(...)`, so any array-like of bytes exercises the same code path.
    const toBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const png = vi.fn(() => ({ toBuffer }))
    const image = { toSharp: vi.fn(() => ({ png })) }
    const bytes = await rawImageToEncodedBytes(image as never)
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('throws when neither toBlob nor toSharp nor encodeImage is available', async () => {
    const { rawImageToEncodedBytes } =
      await import('../../../../../src/batteries/generation/transformers_js/helpers')
    await expect(rawImageToEncodedBytes({} as never)).rejects.toThrow()
  })
})
