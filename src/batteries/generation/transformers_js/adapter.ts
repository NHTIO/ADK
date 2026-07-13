/**
 * transformers.js (on-device, EXPERIMENTAL) Generation adapter battery — DeepSeek Janus text→image.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js/adapter
 *
 * @remarks
 * Media-generation battery backed by transformers.js's Janus (`MultiModalityCausalLM`) model family
 * (documented reference model: `onnx-community/Janus-Pro-1B-ONNX`). **Environment-neutral** — runs in
 * Node (via `onnxruntime-node`) and the browser (via `onnxruntime-web` / WebGPU), auto-selected by the
 * package; there is no WebGPU requirement.
 *
 * **EXPERIMENTAL.** Janus is a ~2GB multimodal model; on WASM/CPU a single image can take minutes to
 * generate. This battery exists for completeness of the on-device story, not as a fast path — prefer
 * the OpenAI/Gemini engines unless running fully offline is the point.
 *
 * There is no `pipeline('text-to-image')` task in transformers.js (verified against the installed
 * `@huggingface/transformers` source — no such task is registered in `src/pipelines.js`). The only
 * image-generation surface is `MultiModalityCausalLM.generate_images(options)`
 * (`src/models/multi_modality/modeling_multi_modality.js`), fed by `VLChatProcessor`
 * (`src/models/janus/processing_janus.js`) — both exported from the package root, per the official
 * `onnx-community/Janus-Pro-1B-ONNX` model card:
 *
 * ```javascript
 * import { AutoProcessor, MultiModalityCausalLM } from "@huggingface/transformers"
 * const processor = await AutoProcessor.from_pretrained(model_id)
 * const model = await MultiModalityCausalLM.from_pretrained(model_id)
 * const inputs = await processor([{ role: "<|User|>", content: prompt }], { chat_template: "text_to_image" })
 * const outputs = await model.generate_images({ ...inputs, min_new_tokens: processor.num_image_tokens, max_new_tokens: processor.num_image_tokens, do_sample: true })
 * ```
 *
 * This adapter mirrors that shape exactly, with every knob overridable per-call (see
 * `./types` for the full source-verified knob provenance) and both the model and processor typed
 * **structurally** (duck-typed local interfaces, never a hard import of the peer's classes) so
 * fake-model/fake-processor unit tests never load the real peer.
 *
 * **`generate_images` returns `RawImage[]`** — raw decoded pixel data, not encoded bytes. Encoding to
 * PNG is env-branched (browser `toBlob('image/png')` / Node `toSharp().png().toBuffer()`), handled by
 * {@link @nhtio/adk/batteries/generation/transformers_js/helpers!rawImageToEncodedBytes}, which also
 * accepts an injectable `encodeImage` override — the primary hermetic-test seam.
 *
 * **`edit()` is unsupported.** Janus's only generation entry point (`generate_images`) is
 * text-conditioned; there is no image-conditioned edit/inpaint surface in the installed
 * `@huggingface/transformers` API. Calling `edit()` throws
 * {@link @nhtio/adk/batteries/generation/transformers_js/exceptions!E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION}.
 *
 * `@huggingface/transformers` is an optional peer dependency, imported lazily (only inside the default
 * model/processor factories, i.e. only when no `janusModel`/`processor`/`createModel`/`createProcessor`
 * override is supplied).
 */

import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { rawImageToEncodedBytes } from './helpers'
import { emitLifecycle } from '../../llm/chat_common/lifecycle'
import { withModelSource } from '../../llm/transformers_js/model_source'
import {
  E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS,
  E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR,
  E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION,
} from './exceptions'
import type { EditOptions, GeneratedMediaOutput } from '../openai/types'
import type {
  TransformersJsGenerationAdapterOptions,
  TransformersJsGenerationModel,
  TransformersJsGenerationProcessor,
  TransformersJsGenerateOptions,
  CreateTransformersJsGenerationModel,
  CreateTransformersJsGenerationProcessor,
} from './types'

const DEFAULT_ROLE = '<|User|>'
const DEFAULT_CHAT_TEMPLATE = 'text_to_image'

const makeDefaultCreateModel = (
  modelSource: TransformersJsGenerationAdapterOptions['modelSource']
): CreateTransformersJsGenerationModel => {
  return async ({ model, device, dtype, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { MultiModalityCausalLM, env } = transformers as unknown as {
      MultiModalityCausalLM: {
        from_pretrained: (model: string, opts?: unknown) => Promise<unknown>
      }
      env: unknown
    }
    const load = async () =>
      (await MultiModalityCausalLM.from_pretrained(model, {
        ...(device ? { device } : {}),
        ...(dtype ? { dtype } : {}),
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      })) as unknown as TransformersJsGenerationModel
    // When a custom model source is configured, serve files through it behind the global-`env` mutex.
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

const makeDefaultCreateProcessor = (
  modelSource: TransformersJsGenerationAdapterOptions['modelSource']
): CreateTransformersJsGenerationProcessor => {
  return async ({ model, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { AutoProcessor, env } = transformers as unknown as {
      AutoProcessor: { from_pretrained: (model: string, opts?: unknown) => Promise<unknown> }
      env: unknown
    }
    const load = async () =>
      (await AutoProcessor.from_pretrained(model, {
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      })) as unknown as TransformersJsGenerationProcessor
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

/**
 * Media generation adapter for transformers.js's Janus (`MultiModalityCausalLM`) text→image model
 * family.
 *
 * @remarks
 * Reusable: construct once, call {@link TransformersJsGenerationAdapter.generate} as many times as
 * needed. The model + processor are resolved lazily on first use (or via {@link preload}) and cached
 * with single-flight semantics so concurrent calls share one load. {@link edit} always throws — see
 * the module remarks.
 */
export class TransformersJsGenerationAdapter {
  readonly #options: TransformersJsGenerationAdapterOptions
  #model: TransformersJsGenerationModel | undefined
  #processor: TransformersJsGenerationProcessor | undefined
  #loadPromise:
    | Promise<{
        model: TransformersJsGenerationModel
        processor: TransformersJsGenerationProcessor
      }>
    | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer — there is no WebGPU requirement.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#model = this.#options.janusModel
    this.#processor = this.#options.processor
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TransformersJsGenerationAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the model + processor so the first `generate` call is fast. Idempotent. */
  async preload(): Promise<void> {
    await this.#resolve()
  }

  /** Drops the cached model/processor and in-flight load so the next call reloads. */
  reset(): void {
    this.#model = undefined
    this.#processor = undefined
    this.#loadPromise = undefined
  }

  async #resolve(): Promise<{
    model: TransformersJsGenerationModel
    processor: TransformersJsGenerationProcessor
  }> {
    if (this.#model && this.#processor) {
      return { model: this.#model, processor: this.#processor }
    }
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS([
        'the transformers.js generation battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#loadPromise ??= (async () => {
      emitLifecycle(opts, 'transformers_js_generation', opts.model, 'loading', {
        detail: 'loading Janus model + processor',
      })
      const hasLifecycle =
        opts.onLifecycle ?? opts.onLoading ?? opts.onReady ?? opts.onGenerating ?? opts.onError
      const forwardedInitProgress = hasLifecycle
        ? (info: unknown) => {
            const p = (info as { progress?: number } | undefined)?.progress
            emitLifecycle(opts, 'transformers_js_generation', opts.model, 'loading', {
              ...(typeof p === 'number' ? { progress: p / 100 } : {}),
              raw: info,
            })
            opts.onInitProgress?.(info as never)
          }
        : opts.onInitProgress
      const createModel = opts.createModel ?? makeDefaultCreateModel(opts.modelSource)
      const createProcessor = opts.createProcessor ?? makeDefaultCreateProcessor(opts.modelSource)
      try {
        emitLifecycle(opts, 'transformers_js_generation', opts.model, 'compiling', {
          detail: 'compiling Janus graph',
        })
        const [model, processor] = await Promise.all([
          this.#model ??
            createModel({
              model: opts.model,
              device: opts.device,
              dtype: opts.dtype,
              onInitProgress: forwardedInitProgress,
            }),
          this.#processor ??
            createProcessor({ model: opts.model, onInitProgress: forwardedInitProgress }),
        ])
        this.#model = model
        this.#processor = processor
        emitLifecycle(opts, 'transformers_js_generation', opts.model, 'ready', {
          detail: 'Janus model + processor ready',
        })
        return { model, processor }
      } catch (err) {
        this.#loadPromise = undefined
        emitLifecycle(opts, 'transformers_js_generation', opts.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR([
          `could not load the transformers.js Janus model/processor: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#loadPromise
  }

  /**
   * Generates image(s) from a text prompt via Janus's `generate_images`.
   *
   * @param prompt - The text prompt describing the desired image.
   * @param opts - Per-call knob overrides — see {@link TransformersJsGenerateOptions}.
   * @returns The generated image(s), each PNG-encoded.
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR} when the call fails
   *   or returns no usable images.
   */
  async generate(
    prompt: string,
    opts?: TransformersJsGenerateOptions
  ): Promise<GeneratedMediaOutput[]> {
    const { model, processor } = await this.#resolve()
    const merged = this.#options

    const role = opts?.role ?? merged.role ?? DEFAULT_ROLE
    const chatTemplate = opts?.chatTemplate ?? merged.chatTemplate ?? DEFAULT_CHAT_TEMPLATE

    emitLifecycle(merged, 'transformers_js_generation', merged.model, 'generating')

    let images: Array<{ toBlob?: unknown; toSharp?: unknown }>
    try {
      const inputs = await processor([{ role, content: prompt }], { chat_template: chatTemplate })
      const numImageTokens = processor.num_image_tokens

      const doSample = opts?.doSample ?? merged.doSample ?? true
      const temperature = opts?.temperature ?? merged.temperature
      const topK = opts?.topK ?? merged.topK
      const guidanceScale = opts?.guidanceScale ?? merged.guidanceScale
      const repetitionPenalty = opts?.repetitionPenalty ?? merged.repetitionPenalty
      const minNewTokens = opts?.minNewTokens ?? numImageTokens
      const maxNewTokens = opts?.maxNewTokens ?? numImageTokens

      const generateOptions: Record<string, unknown> = {
        ...inputs,
        do_sample: doSample,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof topK === 'number' ? { top_k: topK } : {}),
        ...(typeof guidanceScale === 'number' ? { guidance_scale: guidanceScale } : {}),
        ...(typeof repetitionPenalty === 'number' ? { repetition_penalty: repetitionPenalty } : {}),
        ...(typeof minNewTokens === 'number' ? { min_new_tokens: minNewTokens } : {}),
        ...(typeof maxNewTokens === 'number' ? { max_new_tokens: maxNewTokens } : {}),
      }

      images = (await model.generate_images(generateOptions)) as unknown as Array<{
        toBlob?: unknown
        toSharp?: unknown
      }>
    } catch (err) {
      emitLifecycle(merged, 'transformers_js_generation', merged.model, 'error', { error: err })
      throw new E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR([
        isError(err) ? err.message : String(err),
      ])
    }

    if (!Array.isArray(images) || images.length === 0) {
      const error = new Error('generate_images returned no images')
      emitLifecycle(merged, 'transformers_js_generation', merged.model, 'error', { error })
      throw new E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR([
        'the Janus model returned no images — an empty result is an engine failure, not a valid empty generation',
      ])
    }

    let outputs: GeneratedMediaOutput[]
    try {
      outputs = await Promise.all(
        images.map(async (image, i) => {
          const bytes = await rawImageToEncodedBytes(image as never, merged.encodeImage as never)
          return {
            kind: 'image' as const,
            mimeType: 'image/png',
            bytes,
            filename: `generated-${i + 1}.png`,
          }
        })
      )
    } catch (err) {
      emitLifecycle(merged, 'transformers_js_generation', merged.model, 'error', { error: err })
      throw new E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR([
        isError(err) ? err.message : String(err),
      ])
    }

    emitLifecycle(merged, 'transformers_js_generation', merged.model, 'complete')
    return outputs
  }

  /**
   * Unsupported. Janus's only generation entry point (`generate_images`) is text-conditioned; there is
   * no image-conditioned edit/inpaint surface in the installed `@huggingface/transformers` API.
   *
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION} always.
   */
  async edit(
    _image: unknown,
    _prompt: string,
    _opts?: EditOptions
  ): Promise<GeneratedMediaOutput[]> {
    throw new E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION([
      'edit',
      'Janus (MultiModalityCausalLM.generate_images) is text-conditioned image generation only — there is no image-conditioned edit/inpaint entry point in the installed @huggingface/transformers API',
    ])
  }
}
