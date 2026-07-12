/**
 * tesseract.js (WASM Tesseract, dual-environment) OCR specialist adapter battery.
 *
 * @module @nhtio/adk/batteries/specialists/ocr/tesseract_js/adapter
 *
 * @remarks
 * OCR battery backed by `tesseract.js` — Node and browsers, no native binary. Environment-neutral,
 * mirroring the transformers.js embeddings battery's dual-environment posture.
 *
 * **Divergence from `src/batteries/media/engines/tesseract_js.ts`:** that `MediaEngine` creates a
 * fresh worker **per convert call** and terminates it in a `finally` — correct for a stateless,
 * possibly-concurrent conversion pipeline, but it pays tesseract's ~1-2s WASM boot on every single
 * call. This adapter is a construct-once specialist object (the same posture as
 * {@link @nhtio/adk/batteries/embeddings/transformers_js!TransformersJsEmbeddingsAdapter}): a
 * consumer builds it once and calls {@link TesseractJsOcrAdapter.recognize} repeatedly, so it holds
 * **one cached worker**, created single-flight on first use (or via {@link preload}), and reused
 * across calls. `dispose()` terminates it; `reset()` also terminates it (see its own TSDoc for why
 * that differs from the embeddings adapter's `reset()`). Consumers who need the per-call-worker,
 * leak-free-by-construction posture should use the media engine instead.
 *
 * `tesseract.js` is an optional peer dependency, lazily imported on first actual use.
 */

import { toBytes } from '../../_shared'
import { validateOptions } from './validation'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { emitLifecycle } from '../../../llm/chat_common/lifecycle'
import { E_INVALID_TESSERACT_JS_OCR_OPTIONS, E_TESSERACT_JS_OCR_ENGINE_ERROR } from './exceptions'
import type { SpecialistImageInput } from '../../_shared'
import type {
  TesseractJsOcrAdapterOptions,
  TesseractJsWorker,
  RecognizeOptions,
  RecognizeResult,
} from './types'

const makeDefaultCreateWorker = (
  options: TesseractJsOcrAdapterOptions
): NonNullable<TesseractJsOcrAdapterOptions['createWorker']> => {
  return async ({ languages, langPath, cachePath, workerOptions }) => {
    let mod
    try {
      mod = options.tesseract ? await options.tesseract() : await import('tesseract.js')
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_TESSERACT_JS_OCR_ENGINE_ERROR([
        `could not load the tesseract.js peer dependency: ${detail} — install it (pnpm add tesseract.js)`,
      ])
    }
    return mod.createWorker(languages as string[], undefined, {
      ...(langPath ? { langPath } : {}),
      ...(cachePath ? { cachePath } : {}),
      // Spread AFTER langPath/cachePath so an explicit workerOptions.langPath/cachePath wins —
      // this is the bundler escape hatch (workerPath/corePath URL-resolution quirks), not a
      // general override of the adapter's own knobs.
      ...(workerOptions ?? {}),
    } as never)
  }
}

/**
 * OCR adapter for `tesseract.js`.
 *
 * @remarks
 * Reusable: construct once, call {@link recognize} as many times as needed. The worker is
 * resolved lazily on first use (or via {@link preload}) and cached with single-flight semantics so
 * concurrent calls share one load. See the module remarks for how this deliberately diverges from
 * the per-call-worker `MediaEngine` in `src/batteries/media/engines/tesseract_js.ts`.
 */
export class TesseractJsOcrAdapter {
  readonly #options: TesseractJsOcrAdapterOptions
  #worker: TesseractJsWorker | undefined
  #workerPromise: Promise<TesseractJsWorker> | undefined

  /**
   * Whether this battery is available. tesseract.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TESSERACT_JS_OCR_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TesseractJsOcrAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the worker so the first `recognize` call is fast. Idempotent. */
  async preload(): Promise<void> {
    await this.#resolveWorker()
  }

  /**
   * Terminates the cached worker (if any) and drops the cached handle + in-flight load, so the
   * next call creates a fresh worker.
   *
   * @remarks
   * Unlike {@link @nhtio/adk/batteries/embeddings/transformers_js!TransformersJsEmbeddingsAdapter.reset},
   * which only nulls the JS reference and leaves native resources for {@link dispose} to reclaim,
   * this `reset()` also terminates the worker. A live tesseract.js worker is the SAME heavy WASM
   * resource `dispose()` releases — no lighter "just drop the reference" tier exists for it (there
   * is no separate pipeline-session handle to keep warm), so leaving it running after `reset()`
   * would just leak it under a different method name. Swallows a terminate error (teardown must
   * not throw). Idempotent.
   */
  async reset(): Promise<void> {
    const worker = this.#worker ?? (await this.#workerPromise?.catch(() => undefined))
    if (worker) {
      await Promise.resolve(worker.terminate()).catch(() => undefined)
    }
    this.#worker = undefined
    this.#workerPromise = undefined
  }

  /**
   * Terminates the cached worker and drops the cached handle. Alias of {@link reset} — both
   * reclaim the same underlying resource for this adapter (see {@link reset}'s TSDoc).
   */
  async dispose(): Promise<void> {
    await this.reset()
  }

  async #resolveWorker(): Promise<TesseractJsWorker> {
    if (this.#worker) return this.#worker
    if (!this.isAvailable()) {
      throw new E_INVALID_TESSERACT_JS_OCR_OPTIONS([
        'the tesseract.js OCR battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#workerPromise ??= (async () => {
      emitLifecycle(opts, 'tesseract_js_ocr', opts.languages.join('+'), 'loading', {
        detail: 'booting tesseract.js worker',
      })
      const createWorker = opts.createWorker ?? makeDefaultCreateWorker(opts)
      try {
        emitLifecycle(opts, 'tesseract_js_ocr', opts.languages.join('+'), 'compiling', {
          detail: 'initializing tesseract worker + language data',
        })
        const worker = await createWorker({
          languages: opts.languages,
          langPath: opts.langPath,
          cachePath: opts.cachePath,
          workerOptions: opts.workerOptions,
        })
        this.#worker = worker
        emitLifecycle(opts, 'tesseract_js_ocr', opts.languages.join('+'), 'ready', {
          detail: 'tesseract.js worker ready',
        })
        return worker
      } catch (err) {
        this.#workerPromise = undefined
        emitLifecycle(opts, 'tesseract_js_ocr', opts.languages.join('+'), 'error', { error: err })
        if (isInstanceOf(err, 'E_TESSERACT_JS_OCR_ENGINE_ERROR', E_TESSERACT_JS_OCR_ENGINE_ERROR))
          throw err
        throw new E_TESSERACT_JS_OCR_ENGINE_ERROR([
          `could not create the tesseract.js worker: ${isError(err) ? err.message : String(err)}`,
        ])
      }
    })()
    return this.#workerPromise
  }

  /**
   * Recognizes text in an image.
   *
   * @param input - The image/document input (bytes, bytes+MIME, or a `Media`-like value).
   * @param opts - Per-call options. `opts.languages`, when given, must equal the constructor's
   *   `languages` (order-insensitive) — tesseract.js v7 workers do not support re-initializing an
   *   already-created worker's languages via a public, stable API (there is no
   *   `worker.reinitialize` re-language call safe to make on a warm worker without risking
   *   cross-call state bleed), so a genuinely different subset throws
   *   {@link @nhtio/adk/batteries!E_TESSERACT_JS_OCR_ENGINE_ERROR} explaining that per-call language
   *   switching requires a new adapter instance.
   * @returns The recognized text and, when tesseract reports a numeric confidence, the mean
   *   confidence (`0..100`).
   * @throws {@link @nhtio/adk/batteries!E_TESSERACT_JS_OCR_ENGINE_ERROR} when the worker fails to
   *   load, the recognize call throws, or a per-call language override cannot be honored.
   */
  async recognize(input: SpecialistImageInput, opts?: RecognizeOptions): Promise<RecognizeResult> {
    const requestedLanguages = opts?.languages
    if (requestedLanguages && !sameLanguages(requestedLanguages, this.#options.languages)) {
      throw new E_TESSERACT_JS_OCR_ENGINE_ERROR([
        `per-call language switching is not supported against a cached worker (requested [${requestedLanguages.join(', ')}], worker was created with [${this.#options.languages.join(', ')}]) — construct a new TesseractJsOcrAdapter for a different language set`,
      ])
    }

    const worker = await this.#resolveWorker()
    const { bytes, mimeType } = await toBytes(input)
    // Mirrors the media engine's exact Buffer-vs-Blob branch: tesseract.js accepts Buffer/Blob/
    // ImageLike; raw bytes work via Buffer in Node, Blob in the browser (no global Buffer).
    const image =
      typeof globalThis.Buffer !== 'undefined'
        ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Blob([bytes as BlobPart], { type: mimeType })

    emitLifecycle(
      this.#options,
      'tesseract_js_ocr',
      this.#options.languages.join('+'),
      'generating'
    )
    try {
      const result = await worker.recognize(image as never)
      const confidence =
        typeof result.data.confidence === 'number' ? result.data.confidence : undefined
      emitLifecycle(
        this.#options,
        'tesseract_js_ocr',
        this.#options.languages.join('+'),
        'complete'
      )
      return { text: result.data.text, confidence }
    } catch (err) {
      emitLifecycle(this.#options, 'tesseract_js_ocr', this.#options.languages.join('+'), 'error', {
        error: err,
      })
      throw new E_TESSERACT_JS_OCR_ENGINE_ERROR([isError(err) ? err.message : String(err)], {
        cause: err,
      })
    }
  }
}

/** Order-insensitive equality of two language lists. */
const sameLanguages = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((lang, i) => lang === sortedB[i])
}
