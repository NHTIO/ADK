/**
 * transformers.js (ONNX, dual-environment) Caption (image-to-text) specialist adapter battery.
 *
 * @module @nhtio/adk/batteries/specialists/caption/transformers_js/adapter
 *
 * @remarks
 * Image-captioning battery backed by transformers.js's `image-to-text` pipeline (the documented
 * reference model is `Xenova/vit-gpt2-image-captioning`). **Environment-neutral** — runs in Node (via
 * `onnxruntime-node`) and the browser (via `onnxruntime-web` / WebGPU), auto-selected by the package;
 * there is no WebGPU requirement.
 *
 * Same shape as the transformers.js Embeddings battery: eager constructor validation, a required
 * `model` (no default), a lazily-imported/single-flight peer, `preload()` / `reset()` / `dispose()`,
 * and the shared lifecycle hooks.
 *
 * **Image input:** {@link @nhtio/adk/batteries/specialists/_shared!toBytes} normalizes the accepted
 * {@link @nhtio/adk/batteries/specialists/_shared!SpecialistImageInput} forms (bytes / bytes+mime /
 * media-like) to plain bytes + an optional MIME type. Those bytes become a plain `Blob` — the
 * `image-to-text` pipeline's `ImageInput` union directly accepts `Blob` (verified against the
 * installed `@huggingface/transformers` 4.2.0 type declarations, alongside `string | RawImage | URL |
 * HTMLCanvasElement | OffscreenCanvas`), so building a `Blob` needs no peer import at all — `Blob` is a
 * cross-env global (Node 18+ and every browser). This keeps the adapter's hot path peer-free until the
 * pipeline itself is resolved, and means fake-pipeline unit tests never load `@huggingface/transformers`.
 *
 * `@huggingface/transformers` is an optional peer dependency, imported lazily (only inside
 * {@link makeDefaultCreatePipeline}, i.e. only when no `pipeline`/`createPipeline` override is supplied).
 */

import { toBytes } from '../../_shared'
import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { emitLifecycle } from '../../../llm/chat_common/lifecycle'
import { withModelSource } from '../../../llm/transformers_js/model_source'
import {
  E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS,
  E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR,
} from './exceptions'
import type { SpecialistImageInput } from '../../_shared'
import type {
  DescribeOptions,
  DescribeResult,
  TransformersJsCaptionAdapterOptions,
  TransformersJsCaptionPipeline,
  CreateTransformersJsCaptionPipeline,
} from './types'

const makeDefaultCreatePipeline = (
  modelSource: TransformersJsCaptionAdapterOptions['modelSource']
): CreateTransformersJsCaptionPipeline => {
  return async ({ model, device, dtype, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { pipeline, env } = transformers
    const load = async () =>
      (await pipeline('image-to-text', model, {
        ...(device ? { device } : {}),
        ...(dtype ? { dtype } : {}),
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      } as never)) as unknown as TransformersJsCaptionPipeline
    // When a custom model source is configured, serve files through it behind the global-`env` mutex.
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

/** A single `image-to-text` output element, before/after batching is unwrapped. */
interface CaptionResultLike {
  generated_text?: unknown
}

/**
 * Unwrap the pipeline's result — a single `{ generated_text }`, a flat array (one image), or a nested
 * array (a batch) — down to the first element's `generated_text`.
 *
 * @param result - The raw pipeline output.
 * @returns The first result's `generated_text` field, or `undefined` if none could be found.
 */
const firstGeneratedText = (result: unknown): unknown => {
  let candidate: unknown = result
  // Unwrap up to two levels of array nesting (flat batch of one, or a batch-of-images nested array).
  for (let i = 0; i < 2 && Array.isArray(candidate); i++) {
    candidate = candidate[0]
  }
  return (candidate as CaptionResultLike | undefined)?.generated_text
}

/**
 * Caption (image-to-text) adapter for transformers.js's `image-to-text` pipeline.
 *
 * @remarks
 * Reusable: construct once, call {@link TransformersJsCaptionAdapter.describe} as many times as
 * needed. The pipeline is resolved lazily on first use (or via {@link preload}) and cached with
 * single-flight semantics so concurrent calls share one load.
 */
export class TransformersJsCaptionAdapter {
  readonly #options: TransformersJsCaptionAdapterOptions
  #pipeline: TransformersJsCaptionPipeline | undefined
  #pipelinePromise: Promise<TransformersJsCaptionPipeline> | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer — there is no WebGPU requirement.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#pipeline = this.#options.pipeline
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TransformersJsCaptionAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the pipeline so the first `describe` call is fast. Idempotent. */
  async preload(): Promise<void> {
    await this.#resolvePipeline()
  }

  /** Drops the cached pipeline and in-flight load so the next call reloads. */
  reset(): void {
    this.#pipeline = undefined
    this.#pipelinePromise = undefined
  }

  /**
   * Release the loaded model's ONNX sessions + GPU/wasm buffers, then drop the cached pipeline.
   *
   * @remarks
   * `reset()` only nulls the JS reference; the native ONNX Runtime sessions and WebGPU/wasm device memory
   * stay alive until GC. `ImageToTextPipeline` extends `Pipeline`, which exposes `dispose()` — this
   * awaits it so the memory is reclaimed between loads, swallows a disposal error (teardown must not
   * throw), and finishes with `reset()`. Idempotent.
   */
  async dispose(): Promise<void> {
    const pipeline = this.#pipeline ?? (await this.#pipelinePromise?.catch(() => undefined))
    const pipeWithDispose = pipeline as { dispose?: () => Promise<unknown> } | undefined
    if (typeof pipeWithDispose?.dispose === 'function') {
      await Promise.resolve(pipeWithDispose.dispose()).catch(() => undefined)
    }
    this.reset()
  }

  async #resolvePipeline(): Promise<TransformersJsCaptionPipeline> {
    if (this.#pipeline) return this.#pipeline
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS([
        'the transformers.js caption battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#pipelinePromise ??= (async () => {
      emitLifecycle(opts, 'transformers_js_caption', opts.model, 'loading', {
        detail: 'loading image-to-text pipeline',
      })
      // Forward each provider download event into a normalized `loading` lifecycle report.
      const hasLifecycle =
        opts.onLifecycle ?? opts.onLoading ?? opts.onReady ?? opts.onGenerating ?? opts.onError
      const forwardedInitProgress = hasLifecycle
        ? (info: unknown) => {
            const p = (info as { progress?: number } | undefined)?.progress
            emitLifecycle(opts, 'transformers_js_caption', opts.model, 'loading', {
              ...(typeof p === 'number' ? { progress: p / 100 } : {}),
              raw: info,
            })
            opts.onInitProgress?.(info as never)
          }
        : opts.onInitProgress
      const createPipeline = opts.createPipeline ?? makeDefaultCreatePipeline(opts.modelSource)
      try {
        // `from_pretrained` covers both fetch (reported via progress_callback → `loading`) and the
        // ONNX-graph / WebGPU-WASM warmup. Mark the latter as `compiling` — a COARSE upper-bound marker
        // (fetch + compile overlap inside the call), consistent with the LLM/embeddings batteries.
        emitLifecycle(opts, 'transformers_js_caption', opts.model, 'compiling', {
          detail: 'compiling image-to-text graph',
        })
        const pipe = await createPipeline({
          model: opts.model,
          device: opts.device,
          dtype: opts.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#pipeline = pipe
        emitLifecycle(opts, 'transformers_js_caption', opts.model, 'ready', {
          detail: 'image-to-text pipeline ready',
        })
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        emitLifecycle(opts, 'transformers_js_caption', opts.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /**
   * Generates a caption for an image.
   *
   * @param input - The image in any {@link @nhtio/adk/batteries/specialists/_shared!SpecialistImageInput}
   *   form (bytes / bytes+mime / media-like).
   * @param opts - Per-call options (`maxNewTokens`, forwarded as `max_new_tokens`; omitted when unset).
   * @returns The normalized `{ text }` caption result.
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR} when the call fails or
   *   the pipeline returns no usable caption text (an empty/missing caption is treated as an engine
   *   failure, not a valid empty result — a captioner that produces nothing didn't do its job).
   */
  async describe(input: SpecialistImageInput, opts?: DescribeOptions): Promise<DescribeResult> {
    const { bytes, mimeType } = await toBytes(input)
    // `Blob` is a cross-env global (Node 18+ and every browser) — the `image-to-text` pipeline's
    // `ImageInput` union accepts it directly, so no `RawImage`/peer import is needed to build it.
    const image = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType ?? '' })

    const pipe = await this.#resolvePipeline()

    emitLifecycle(this.#options, 'transformers_js_caption', this.#options.model, 'generating')

    let result: unknown
    try {
      result = await pipe(
        image,
        typeof opts?.maxNewTokens === 'number' ? { max_new_tokens: opts.maxNewTokens } : undefined
      )
    } catch (err) {
      emitLifecycle(this.#options, 'transformers_js_caption', this.#options.model, 'error', {
        error: err,
      })
      throw new E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR([isError(err) ? err.message : String(err)])
    }

    const text = firstGeneratedText(result)
    if (typeof text !== 'string' || text.length === 0) {
      const error = new Error('image-to-text pipeline returned no caption text')
      emitLifecycle(this.#options, 'transformers_js_caption', this.#options.model, 'error', {
        error,
      })
      throw new E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR([
        'the image-to-text pipeline returned an empty or missing generated_text — a captioner that produces no text is an engine failure, not a valid empty caption',
      ])
    }

    emitLifecycle(this.#options, 'transformers_js_caption', this.#options.model, 'complete')
    return { text }
  }
}
