import { describe, expect, it, vi } from 'vitest'
import {
  TesseractJsOcrAdapter,
  E_INVALID_TESSERACT_JS_OCR_OPTIONS,
  E_TESSERACT_JS_OCR_ENGINE_ERROR,
} from '@nhtio/adk/batteries/specialists/ocr/tesseract_js'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/specialists/ocr/tesseract_js'

// A fake tesseract.js worker: recognize() returns { data: { text, confidence } }, terminate() resolves.
const makeFakeWorker = (data: { text: string; confidence?: number }) => {
  const recognizeCalls: unknown[] = []
  const terminate = vi.fn(async () => undefined)
  const recognize = vi.fn(async (image: unknown) => {
    recognizeCalls.push(image)
    return { data }
  })
  return { recognize, terminate, recognizeCalls }
}

describe('TesseractJsOcrAdapter — static + validation', () => {
  it('is environment-neutral available', () => {
    expect(TesseractJsOcrAdapter.isAvailable()).toBe(true)
  })

  it('requires languages', () => {
    expect(() => new TesseractJsOcrAdapter({})).toThrow(E_INVALID_TESSERACT_JS_OCR_OPTIONS)
  })

  it('rejects an empty languages array', () => {
    expect(() => new TesseractJsOcrAdapter({ languages: [] })).toThrow(
      E_INVALID_TESSERACT_JS_OCR_OPTIONS
    )
  })

  it('rejects unknown keys', () => {
    expect(() => new TesseractJsOcrAdapter({ languages: ['eng'], bogus: 1 })).toThrow(
      E_INVALID_TESSERACT_JS_OCR_OPTIONS
    )
  })
})

describe('TesseractJsOcrAdapter — worker single-flight', () => {
  it('createWorker is called once across concurrent recognize calls', async () => {
    const worker = makeFakeWorker({ text: 'hello', confidence: 91 })
    const createWorker = vi.fn(async () => worker as never)
    const a = new TesseractJsOcrAdapter({ languages: ['eng'], createWorker })
    await Promise.all([
      a.recognize(new Uint8Array([1, 2, 3])),
      a.recognize(new Uint8Array([4, 5, 6])),
    ])
    expect(createWorker).toHaveBeenCalledOnce()
  })

  it('passes constructor languages + langPath/cachePath to createWorker', async () => {
    const worker = makeFakeWorker({ text: 'x' })
    const createWorker = vi.fn(async () => worker as never)
    const a = new TesseractJsOcrAdapter({
      languages: ['eng', 'fra'],
      langPath: '/lang',
      cachePath: '/cache',
      createWorker,
    })
    await a.recognize(new Uint8Array([1]))
    expect(createWorker).toHaveBeenCalledWith({
      languages: ['eng', 'fra'],
      langPath: '/lang',
      cachePath: '/cache',
      workerOptions: undefined,
    })
  })
})

describe('TesseractJsOcrAdapter — recognize()', () => {
  it('maps text + confidence', async () => {
    const worker = makeFakeWorker({ text: 'hello world', confidence: 87.5 })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    const result = await a.recognize(new Uint8Array([1, 2, 3]))
    expect(result).toEqual({ text: 'hello world', confidence: 87.5 })
  })

  it('confidence absent (non-numeric) maps to undefined', async () => {
    const worker = makeFakeWorker({ text: 'hello' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    const result = await a.recognize(new Uint8Array([1]))
    expect(result.confidence).toBeUndefined()
  })

  it('passes the environment-appropriate image type (Buffer in Node, Blob otherwise)', async () => {
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    await a.recognize(new Uint8Array([9, 8, 7]))
    const image = worker.recognizeCalls[0]
    if (typeof globalThis.Buffer !== 'undefined') {
      expect(globalThis.Buffer.isBuffer(image)).toBe(true)
      expect(Array.from(image as Buffer)).toEqual([9, 8, 7])
    } else {
      expect(image).toBeInstanceOf(Blob)
    }
  })

  it('accepts a SpecialistBytesInput (bytes + mimeType)', async () => {
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    const result = await a.recognize({ bytes: new Uint8Array([1, 2]), mimeType: 'image/png' })
    expect(result.text).toBe('x')
  })

  it('accepts a Media-like input via asBytes()', async () => {
    const worker = makeFakeWorker({ text: 'from-media' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    const media = { mimeType: 'image/png', asBytes: async () => new Uint8Array([1, 2, 3]) }
    const result = await a.recognize(media)
    expect(result.text).toBe('from-media')
  })

  it('a per-call languages subset matching the constructor languages (order-insensitive) is accepted', async () => {
    const worker = makeFakeWorker({ text: 'ok' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng', 'fra'],
      createWorker: async () => worker as never,
    })
    const result = await a.recognize(new Uint8Array([1]), { languages: ['fra', 'eng'] })
    expect(result.text).toBe('ok')
  })

  it('a genuinely different per-call languages set throws (cached-worker language switch unsupported)', async () => {
    const worker = makeFakeWorker({ text: 'ok' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    await expect(a.recognize(new Uint8Array([1]), { languages: ['deu'] })).rejects.toThrow(
      E_TESSERACT_JS_OCR_ENGINE_ERROR
    )
  })

  it('wraps a worker load failure in an engine error', async () => {
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => {
        throw new Error('boom')
      },
    })
    await expect(a.recognize(new Uint8Array([1]))).rejects.toThrow(E_TESSERACT_JS_OCR_ENGINE_ERROR)
  })

  it('wraps a recognize() throw in an engine error, preserving the cause', async () => {
    const cause = new Error('recognize boom')
    const worker = {
      recognize: vi.fn(async () => {
        throw cause
      }),
      terminate: vi.fn(async () => undefined),
    }
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    await expect(a.recognize(new Uint8Array([1]))).rejects.toMatchObject({
      cause,
    })
  })
})

describe('TesseractJsOcrAdapter — dispose / reset', () => {
  it('dispose() terminates the cached worker', async () => {
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    await a.recognize(new Uint8Array([1]))
    await a.dispose()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('reset() also terminates the cached worker (a live WASM worker has no lighter tier)', async () => {
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
    })
    await a.recognize(new Uint8Array([1]))
    await a.reset()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('after dispose(), the next recognize() creates a fresh worker', async () => {
    let creations = 0
    const createWorker = vi.fn(async () => {
      creations += 1
      return makeFakeWorker({ text: `w${creations}` }) as never
    })
    const a = new TesseractJsOcrAdapter({ languages: ['eng'], createWorker })
    const first = await a.recognize(new Uint8Array([1]))
    expect(first.text).toBe('w1')
    await a.dispose()
    const second = await a.recognize(new Uint8Array([1]))
    expect(second.text).toBe('w2')
    expect(createWorker).toHaveBeenCalledTimes(2)
  })

  it('dispose() is a no-op (no throw) when nothing has been loaded', async () => {
    const a = new TesseractJsOcrAdapter({ languages: ['eng'], createWorker: vi.fn() })
    await expect(a.dispose()).resolves.toBeUndefined()
  })
})

describe('TesseractJsOcrAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await a.recognize(new Uint8Array([1]))
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=tesseract_js_ocr + model=joined languages on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const worker = makeFakeWorker({ text: 'x' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng', 'fra'],
      createWorker: async () => worker as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await a.recognize(new Uint8Array([1]))
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('tesseract_js_ocr')
      expect(r.model).toBe('eng+fra')
    }
  })

  it('emits error (not complete) when the worker fails to load', async () => {
    const phases: string[] = []
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => {
        throw new Error('load boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    await expect(a.recognize(new Uint8Array([1]))).rejects.toThrow(E_TESSERACT_JS_OCR_ENGINE_ERROR)
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
  })

  it('a throwing consumer hook does not break recognize()', async () => {
    const worker = makeFakeWorker({ text: 'ok' })
    const a = new TesseractJsOcrAdapter({
      languages: ['eng'],
      createWorker: async () => worker as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    const result = await a.recognize(new Uint8Array([1]))
    expect(result.text).toBe('ok')
  })
})
