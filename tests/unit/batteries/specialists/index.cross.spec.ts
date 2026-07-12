import { describe, expect, expectTypeOf, it } from 'vitest'
import * as specialistsBarrel from '../../../../src/batteries/specialists'
import { TesseractJsOcrAdapter as OcrFromModality } from '../../../../src/batteries/specialists/ocr'
import { TransformersJsSttAdapter as SttFromModality } from '../../../../src/batteries/specialists/stt'
import { TransformersJsCaptionAdapter as CaptionFromModality } from '../../../../src/batteries/specialists/caption'
import {
  TransformersJsSttAdapter,
  TesseractJsOcrAdapter,
  TransformersJsCaptionAdapter,
  E_INVALID_TRANSFORMERS_JS_STT_OPTIONS,
  E_TRANSFORMERS_JS_STT_ENGINE_ERROR,
  E_INVALID_TESSERACT_JS_OCR_OPTIONS,
  E_TESSERACT_JS_OCR_ENGINE_ERROR,
  E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS,
  E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR,
  isPcmInput,
  toBytes,
  defaultDecodeAudio,
} from '../../../../src/batteries/specialists'
import type {
  SpecialistMediaLike,
  SpecialistBytesInput,
  SpecialistImageInput,
  SpecialistPcmInput,
  SpecialistAudioInput,
  DecodeAudioFn,
  TranscribeOptions,
  TranscribeResult,
  SttSegment,
  RecognizeOptions,
  RecognizeResult,
  DescribeOptions,
  DescribeResult,
} from '../../../../src/batteries/specialists'

describe('@nhtio/adk/batteries/specialists', () => {
  it('re-exports every modality adapter class, identical to its own subpath', () => {
    expect(specialistsBarrel.TransformersJsSttAdapter).toBeDefined()
    expect(specialistsBarrel.TransformersJsSttAdapter).toBe(SttFromModality)

    expect(specialistsBarrel.TesseractJsOcrAdapter).toBeDefined()
    expect(specialistsBarrel.TesseractJsOcrAdapter).toBe(OcrFromModality)

    expect(specialistsBarrel.TransformersJsCaptionAdapter).toBeDefined()
    expect(specialistsBarrel.TransformersJsCaptionAdapter).toBe(CaptionFromModality)

    // Named imports resolve to the same classes.
    expect(TransformersJsSttAdapter).toBe(SttFromModality)
    expect(TesseractJsOcrAdapter).toBe(OcrFromModality)
    expect(TransformersJsCaptionAdapter).toBe(CaptionFromModality)
  })

  it('re-exports the six battery-scoped exceptions', () => {
    expect(E_INVALID_TRANSFORMERS_JS_STT_OPTIONS).toBeDefined()
    expect(E_TRANSFORMERS_JS_STT_ENGINE_ERROR).toBeDefined()
    expect(E_INVALID_TESSERACT_JS_OCR_OPTIONS).toBeDefined()
    expect(E_TESSERACT_JS_OCR_ENGINE_ERROR).toBeDefined()
    expect(E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS).toBeDefined()
    expect(E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR).toBeDefined()

    // Each is a constructable exception class carrying its own `code`.
    expect(new E_INVALID_TRANSFORMERS_JS_STT_OPTIONS(['x'])).toBeInstanceOf(Error)
    expect(new E_TRANSFORMERS_JS_STT_ENGINE_ERROR(['x'])).toBeInstanceOf(Error)
    expect(new E_INVALID_TESSERACT_JS_OCR_OPTIONS(['x'])).toBeInstanceOf(Error)
    expect(new E_TESSERACT_JS_OCR_ENGINE_ERROR(['x'])).toBeInstanceOf(Error)
    expect(new E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS(['x'])).toBeInstanceOf(Error)
    expect(new E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR(['x'])).toBeInstanceOf(Error)
  })

  it('re-exports the _shared guards/normalizers, callable', () => {
    expect(typeof isPcmInput).toBe('function')
    expect(typeof toBytes).toBe('function')
    expect(typeof defaultDecodeAudio).toBe('function')

    expect(isPcmInput({ pcm: new Float32Array(2), sampleRate: 16_000 })).toBe(true)
    expect(isPcmInput(new Uint8Array([1]))).toBe(false)
  })

  it('re-exports the per-modality validation schemas + validateOptions wrappers', () => {
    expect(specialistsBarrel.transformersJsSttAdapterOptionsSchema).toBeDefined()
    expect(specialistsBarrel.validateTransformersJsSttOptions).toBeDefined()

    expect(specialistsBarrel.tesseractJsOcrOptionsSchema).toBeDefined()
    expect(specialistsBarrel.validateTesseractJsOcrOptions).toBeDefined()

    expect(specialistsBarrel.transformersJsCaptionOptionsSchema).toBeDefined()
    expect(specialistsBarrel.validateTransformersJsCaptionOptions).toBeDefined()

    // The caption modality barrel's bare `validateOptions` is deliberately NOT re-exported at this
    // aggregate level (it would collide with @nhtio/adk/batteries/llm's own `validateOptions`
    // export once combined under @nhtio/adk/batteries) — only the renamed form is.
    expect((specialistsBarrel as Record<string, unknown>).validateOptions).toBeUndefined()
  })

  it('exposes every public value export as defined via Object.values', () => {
    const all = Object.values(specialistsBarrel)
    expect(all.length).toBeGreaterThan(0)
    for (const value of all) {
      expect(value).toBeDefined()
    }
  })

  // Type-level completeness: `expectTypeOf` only compiles if every listed type is actually
  // exported from the aggregate barrel with the expected shape — a type error here fails
  // `pnpm type-check` / vitest's type-checking, not a runtime `expect()`.
  it('re-exports every option/result type at the type level', () => {
    expectTypeOf<SpecialistMediaLike>().toHaveProperty('mimeType')
    expectTypeOf<SpecialistMediaLike>().toHaveProperty('asBytes')

    expectTypeOf<SpecialistBytesInput>().toHaveProperty('bytes')
    expectTypeOf<SpecialistImageInput>().toMatchTypeOf<
      Uint8Array | SpecialistBytesInput | SpecialistMediaLike
    >()

    expectTypeOf<SpecialistPcmInput>().toHaveProperty('pcm')
    expectTypeOf<SpecialistPcmInput>().toHaveProperty('sampleRate')
    expectTypeOf<SpecialistAudioInput>().toMatchTypeOf<SpecialistImageInput | SpecialistPcmInput>()

    expectTypeOf<DecodeAudioFn>().toBeFunction()
    expectTypeOf<DecodeAudioFn>().returns.resolves.toHaveProperty('pcm')
    expectTypeOf<DecodeAudioFn>().returns.resolves.toHaveProperty('sampleRate')

    expectTypeOf<TranscribeOptions>().toHaveProperty('language')
    expectTypeOf<TranscribeOptions>().toHaveProperty('translate')
    expectTypeOf<TranscribeOptions>().toHaveProperty('timestamps')
    expectTypeOf<TranscribeResult>().toHaveProperty('text')
    expectTypeOf<TranscribeResult>().toHaveProperty('segments')
    expectTypeOf<SttSegment>().toHaveProperty('start')
    expectTypeOf<SttSegment>().toHaveProperty('end')
    expectTypeOf<SttSegment>().toHaveProperty('text')

    expectTypeOf<RecognizeOptions>().toHaveProperty('languages')
    expectTypeOf<RecognizeResult>().toHaveProperty('text')
    expectTypeOf<RecognizeResult>().toHaveProperty('confidence')

    expectTypeOf<DescribeOptions>().toHaveProperty('maxNewTokens')
    expectTypeOf<DescribeResult>().toHaveProperty('text')
  })
})
