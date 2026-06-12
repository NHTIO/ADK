import { Jimp } from 'jimp'
import { describe, expect, it } from 'vitest'
import { loadMediaFixture } from '../../../_fixtures/media_fixtures'
import { jimpEngine } from '../../../../src/batteries/media/engines/jimp'
import { resampleTo } from '../../../../src/batteries/media/steps/image_audio'
import { implementsMediaEngine } from '../../../../src/batteries/media/contracts'
import {
  createMediaPipeline,
  PCM_MIME,
  pcmToBytes,
  bytesToPcm,
} from '../../../../src/batteries/media'
import type { StepPayload, MediaPipeline } from '../../../../src/batteries/media'
import type {
  MediaEngine,
  MutateRequest,
  ConvertOptions,
} from '../../../../src/batteries/media/contracts'

const dims = async (payload: StepPayload): Promise<{ w: number; h: number; mime: string }> => {
  const img = await Jimp.read(
    payload.bytes.buffer.slice(
      payload.bytes.byteOffset,
      payload.bytes.byteOffset + payload.bytes.byteLength
    ) as ArrayBuffer
  )
  return { w: img.width, h: img.height, mime: payload.mimeType }
}

const makePipeline = (): Promise<MediaPipeline> =>
  createMediaPipeline({ engines: [() => jimpEngine()] })

/** Wrap a mutate probe around the real jimp implementation. */
const probedJimp = (probe: (request: MutateRequest) => void): MediaEngine => {
  const real = jimpEngine()
  const capability = real.mutates![0]
  return {
    id: 'probed-jimp',
    mutates: [
      {
        over: capability.over,
        ops: capability.ops,
        encodes: capability.encodes,
        async mutate(request) {
          probe(request)
          return capability.mutate(request)
        },
      },
    ],
  }
}

describe('image.* steps with the jimp engine', () => {
  it('jimpEngine conforms to the MediaEngine contract', () => {
    expect(implementsMediaEngine(jimpEngine())).toBe(true)
  })

  it('resize via the builder', async () => {
    const mp = await makePipeline()
    const png = await loadMediaFixture('sample.png')
    const out = (await mp(png).image.resize({ width: 32 })) as StepPayload
    const { w } = await dims(out)
    expect(w).toBe(32)
  })

  it('format re-encode to jpeg with quality, filename follows', async () => {
    const mp = await makePipeline()
    const png = await loadMediaFixture('sample.png')
    const out = (await mp(png).image.format('jpeg', { quality: 70 })) as StepPayload
    expect(out.mimeType).toBe('image/jpeg')
    expect(out.filename.endsWith('.jpg')).toBe(true)
  })

  it('adjacent image steps fuse into ONE engine call (frozen 0.13)', async () => {
    let calls = 0
    const counting = probedJimp((request) => {
      calls += 1
      expect(request.resize?.width).toBe(24)
      expect(request.format?.to).toBe('jpeg')
      expect(request.rotate).toBe(90)
    })
    const mp = await createMediaPipeline({ engines: [counting] })
    const png = await loadMediaFixture('sample.png')
    const out = (await mp(png)
      .image.resize({ width: 24 })
      .image.format('jpeg')
      .image.rotate(90)) as StepPayload
    expect(calls).toBe(1)
    expect(out.mimeType).toBe('image/jpeg')
  })

  it('two rotates cancel modulo 360 in the fused request', async () => {
    let sawRotate: number | undefined = 999
    const probe = probedJimp((request) => {
      sawRotate = request.rotate
    })
    const mp = await createMediaPipeline({ engines: [probe] })
    const png = await loadMediaFixture('sample.png')
    await mp(png).image.rotate(180).image.rotate(180)
    expect(sawRotate).toBeUndefined()
  })

  it('unsupported output formats name the alternative engine', async () => {
    const mp = await makePipeline()
    const png = await loadMediaFixture('sample.png')
    await expect(mp(png).image.format('webp')).rejects.toThrow(/sharp/)
  })

  it('pipe surface: image resize width=… | image format to=…', async () => {
    const mp = await makePipeline()
    const png = await loadMediaFixture('sample.png')
    const result = await mp.query(png, 'image resize width=16 | image format to=png')
    expect(result.kind).toBe('media')
    const { w } = await dims((result as { payload: StepPayload }).payload)
    expect(w).toBe(16)
  })

  it('image verbs without a mutate provider are rejected at validation', async () => {
    const mp = await createMediaPipeline()
    const png = await loadMediaFixture('sample.png')
    await expect(mp(png).image.resize({ width: 8 })).rejects.toThrow(/Do not retry/)
  })

  it('image verbs on non-images fail with the family message', async () => {
    const mp = await makePipeline()
    const txt: StepPayload = {
      bytes: new TextEncoder().encode('x'),
      mimeType: 'text/plain',
      filename: 'x.txt',
    }
    await expect(mp(txt).image.resize({ width: 8 })).rejects.toThrow(/expect an image/)
  })
})

describe('audio.transcribe with stub engines', () => {
  const sine = (rate: number, seconds: number): Float32Array => {
    const out = new Float32Array(rate * seconds)
    for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / rate)
    return out
  }

  /** A stub decoder declaring audio→pcm. */
  const decoderOf = (pcm: Float32Array, sampleRate: number): MediaEngine => ({
    id: 'stub-decoder',
    converts: [
      {
        from: ['audio/*'],
        to: ['pcm'],
        async convert(request) {
          expect(request.bytes.byteLength).toBeGreaterThan(0)
          return {
            outputs: [{ bytes: pcmToBytes(pcm), mimeType: PCM_MIME, meta: { sampleRate } }],
          }
        },
      },
    ],
  })

  /** A stub transcriber declaring pcm→text forms. */
  const asrOf = (
    transcribe: (pcm: Float32Array, to: string, options?: ConvertOptions) => string
  ): MediaEngine => ({
    id: 'stub-asr',
    converts: [
      {
        from: [PCM_MIME],
        to: ['txt', 'srt', 'vtt', 'json'],
        async convert(request) {
          const text = transcribe(bytesToPcm(request.bytes), request.to, request.options)
          return { outputs: [{ bytes: new TextEncoder().encode(text), mimeType: 'text/plain' }] }
        },
      },
    ],
  })

  it('resampleTo halves the sample count from 32k to 16k', () => {
    const pcm = sine(32_000, 1)
    const out = resampleTo(pcm, 32_000, 16_000)
    expect(out.length).toBe(16_000)
  })

  it('decode → resample → asr composition, with out/lang/translate forwarded', async () => {
    let saw: { samples?: number; out?: string; lang?: unknown; translate?: unknown } = {}
    const mp = await createMediaPipeline({
      engines: [
        decoderOf(sine(44_100, 1), 44_100),
        asrOf((pcm, to, options) => {
          saw = { samples: pcm.length, out: to, lang: options?.lang, translate: options?.translate }
          return to === 'srt' ? '1\n00:00:00,000 --> 00:00:01,000\nhello' : 'hello'
        }),
      ],
    })
    const wav = await loadMediaFixture('sample.wav')
    const srt = (await mp(wav).audio.transcribe({
      out: 'srt',
      language: 'en',
      translate: true,
    })) as string
    expect(srt).toContain('-->')
    expect(saw.out).toBe('srt')
    expect(saw.lang).toBe('en')
    expect(saw.translate).toBe(true)
    expect(saw.samples).toBeCloseTo(16_000, -2)
  })

  it('missing engines are do-not-retry failures', async () => {
    const mp = await createMediaPipeline()
    const wav = await loadMediaFixture('sample.wav')
    await expect(mp(wav).audio.transcribe()).rejects.toThrow(/Do not retry/)
  })
})

describe('audio-decode engine against the wav fixture', () => {
  it('decodes wav to mono PCM reporting the source rate in meta', async () => {
    const { audioDecodeEngine } =
      await import('../../../../src/batteries/media/engines/audio_decode')
    const engine = audioDecodeEngine()
    const wav = await loadMediaFixture('sample.wav')
    const result = await engine.converts![0].convert({
      bytes: wav.bytes,
      mimeType: 'audio/wav',
      filename: 'sample.wav',
      to: 'pcm',
    })
    const output = result.outputs[0]
    expect(output.mimeType).toBe(PCM_MIME)
    expect(Number(output.meta?.sampleRate)).toBeGreaterThan(0)
    expect(bytesToPcm(output.bytes).length).toBeGreaterThan(0)
  })

  it('full local transcription path with a stub ASR (decode is real)', async () => {
    const { audioDecodeEngine } =
      await import('../../../../src/batteries/media/engines/audio_decode')
    const asr: MediaEngine = {
      id: 'stub-asr',
      converts: [
        {
          from: [PCM_MIME],
          to: ['txt'],
          async convert(request) {
            const pcm = bytesToPcm(request.bytes)
            return {
              outputs: [
                {
                  bytes: new TextEncoder().encode(`heard ${pcm.length} samples`),
                  mimeType: 'text/plain',
                },
              ],
            }
          },
        },
      ],
    }
    const mp = await createMediaPipeline({ engines: [() => audioDecodeEngine(), asr] })
    const wav = await loadMediaFixture('sample.wav')
    const text = (await mp(wav).audio.transcribe()) as string
    expect(text).toMatch(/^heard \d+ samples$/)
  })
})

describe('engine config validation (loud-config rules)', () => {
  it('transformersAsrEngine requires an explicit model id', async () => {
    const { transformersAsrEngine } =
      await import('../../../../src/batteries/media/engines/transformers_asr')
    // @ts-expect-error missing model on purpose
    expect(() => transformersAsrEngine({})).toThrow(/model id/)
  })

  it('tesseractJsEngine requires explicit languages', async () => {
    const { tesseractJsEngine } =
      await import('../../../../src/batteries/media/engines/tesseract_js')
    // @ts-expect-error missing languages on purpose
    expect(() => tesseractJsEngine({})).toThrow(/languages/)
  })

  it('sharpEngine conforms to the contract and declares webp', async () => {
    const { sharpEngine } = await import('../../../../src/batteries/media/engines/sharp')
    const engine = sharpEngine()
    expect(implementsMediaEngine(engine)).toBe(true)
    expect(engine.mutates![0].encodes).toContain('webp')
  })

  it('sharp engine transforms the png fixture to webp (native path)', async () => {
    const { sharpEngine } = await import('../../../../src/batteries/media/engines/sharp')
    const mp = await createMediaPipeline({ engines: [() => sharpEngine()] })
    const png = await loadMediaFixture('sample.png')
    const out = (await mp(png).image.resize({ width: 20 }).image.format('webp')) as StepPayload
    expect(out.mimeType).toBe('image/webp')
  })
})

describe('generation edges — blank canvas + silent wav', () => {
  it('empty:png via jimp mints a 1024×1024 white canvas', async () => {
    const engine = jimpEngine()
    const result = await engine.converts![0].convert({
      bytes: new Uint8Array(0),
      mimeType: 'application/x-adk-empty',
      filename: 'untitled',
      to: 'png',
    })
    const out = result.outputs[0]
    expect(out.mimeType).toBe('image/png')
    const image = await Jimp.read(
      out.bytes.buffer.slice(
        out.bytes.byteOffset,
        out.bytes.byteOffset + out.bytes.byteLength
      ) as ArrayBuffer
    )
    expect(image.width).toBe(1024)
    expect(image.height).toBe(1024)
  })

  it('empty:png | image resize width=64 — generate then shape in one chain', async () => {
    const mp = await createMediaPipeline({ engines: [() => jimpEngine()] })
    const minted = await mp.capabilities.convert({
      bytes: new Uint8Array(0),
      mimeType: 'application/x-adk-empty',
      filename: 'untitled',
      to: 'png',
    })
    const out = (await mp({
      bytes: minted.outputs[0].bytes,
      mimeType: minted.outputs[0].mimeType,
      filename: 'untitled.png',
    }).image.resize({ width: 64, height: 64 })) as StepPayload
    const image = await Jimp.read(
      out.bytes.buffer.slice(
        out.bytes.byteOffset,
        out.bytes.byteOffset + out.bytes.byteLength
      ) as ArrayBuffer
    )
    expect(image.width).toBe(64)
  })

  it('empty:wav mints decodable 44100 Hz mono silence (real audio-decode round-trip)', async () => {
    const { audioDecodeEngine } =
      await import('../../../../src/batteries/media/engines/audio_decode')
    const engine = audioDecodeEngine()
    const generation = engine.converts!.find((c) => c.from.includes('application/x-adk-empty'))!
    const minted = await generation.convert({
      bytes: new Uint8Array(0),
      mimeType: 'application/x-adk-empty',
      filename: 'untitled',
      to: 'wav',
    })
    expect(minted.outputs[0].mimeType).toBe('audio/wav')
    // The engine's own decode path accepts its own seed.
    const decoded = await engine.converts![0].convert({
      bytes: minted.outputs[0].bytes,
      mimeType: 'audio/wav',
      filename: 'untitled.wav',
      to: 'pcm',
    })
    expect(Number(decoded.outputs[0].meta?.sampleRate)).toBe(44_100)
    const pcm = bytesToPcm(decoded.outputs[0].bytes)
    expect(pcm.length).toBe(44_100) // one second, mono
    expect(pcm.every((sample) => sample === 0)).toBe(true) // silence
  })
})
