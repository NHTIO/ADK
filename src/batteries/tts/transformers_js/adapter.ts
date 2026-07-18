/**
 * transformers.js (ONNX, dual-environment) TTS (text-to-speech) adapter battery.
 *
 * @module @nhtio/adk/batteries/tts/transformers_js/adapter
 *
 * @remarks
 * Battery backed by transformers.js's `text-to-speech` (TextToAudio) pipeline. **Environment-neutral**
 * — runs in Node (via `onnxruntime-node`) and the browser (via `onnxruntime-web` / WebGPU), auto-selected
 * by the package; there is no WebGPU requirement, mirroring the transformers.js STT and Embeddings
 * batteries this adapter is modeled on.
 *
 * Accepts plain text input, resolves speaker embeddings / speed / inference steps from the merged
 * constructor + per-call options, and returns a WAV-encoded {@link GeneratedMediaOutput}.
 *
 * `@huggingface/transformers` is an optional peer dependency, imported lazily.
 */

import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { emitLifecycle } from '../../llm/chat_common/lifecycle'
import { withModelSource } from '../../llm/transformers_js/model_source'
import {
  E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS,
  E_TRANSFORMERS_JS_TTS_ENGINE_ERROR,
} from './exceptions'
import type { RawAudioLike, GeneratedMediaOutput } from '../_shared'
import type {
  TransformersJsTtsAdapterOptions,
  TransformersJsTtsPipeline,
  CreateTransformersJsTtsPipeline,
  TransformersJsSynthesizeOptions,
} from './types'

const makeDefaultCreatePipeline = (
  modelSource: TransformersJsTtsAdapterOptions['modelSource']
): CreateTransformersJsTtsPipeline => {
  return async ({ model, device, dtype, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { pipeline, env } = transformers
    const load = async () =>
      (await pipeline('text-to-speech', model, {
        ...(device ? { device } : {}),
        ...(dtype ? { dtype } : {}),
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      } as never)) as unknown as TransformersJsTtsPipeline
    // When a custom model source is configured, serve files through it behind the global-`env` mutex.
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

/**
 * TTS adapter for transformers.js's text-to-speech (TextToAudio) pipeline.
 *
 * @remarks
 * Reusable: construct once, call {@link TransformersJsTtsAdapter.synthesize} as many times as needed.
 * The pipeline is resolved lazily on first use (or via {@link preload}) and cached with single-flight
 * semantics so concurrent calls share one load.
 */
export class TransformersJsTtsAdapter {
  readonly #options: TransformersJsTtsAdapterOptions
  #pipeline: TransformersJsTtsPipeline | undefined
  #pipelinePromise: Promise<TransformersJsTtsPipeline> | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer — there is no WebGPU requirement.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#pipeline = this.#options.pipeline
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TransformersJsTtsAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the pipeline so the first `synthesize` call is fast. Idempotent. */
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
   * `reset()` only nulls the JS reference; the native ONNX Runtime sessions and WebGPU/wasm device
   * memory stay alive until GC. `TextToAudioPipeline` extends `Pipeline`, which exposes `dispose()` —
   * this awaits it so the memory is reclaimed between loads, swallows a disposal error (teardown must
   * not throw), and finishes with `reset()`. Idempotent.
   */
  async dispose(): Promise<void> {
    const pipeline = this.#pipeline ?? (await this.#pipelinePromise?.catch(() => undefined))
    const pipeWithDispose = pipeline as { dispose?: () => Promise<unknown> } | undefined
    if (typeof pipeWithDispose?.dispose === 'function') {
      await Promise.resolve(pipeWithDispose.dispose()).catch(() => undefined)
    }
    this.reset()
  }

  async #resolvePipeline(): Promise<TransformersJsTtsPipeline> {
    if (this.#pipeline) return this.#pipeline
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS([
        'the transformers.js TTS battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#pipelinePromise ??= (async () => {
      emitLifecycle(opts, 'transformers_js_tts', opts.model, 'loading', {
        detail: 'loading text-to-speech pipeline',
      })
      // Forward each provider download event into a normalized `loading` lifecycle report.
      const hasLifecycle =
        opts.onLifecycle ?? opts.onLoading ?? opts.onReady ?? opts.onGenerating ?? opts.onError
      const forwardedInitProgress = hasLifecycle
        ? (info: unknown) => {
            const p = (info as { progress?: number } | undefined)?.progress
            emitLifecycle(opts, 'transformers_js_tts', opts.model, 'loading', {
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
        // (fetch + compile overlap inside the call), consistent with the LLM/embeddings/STT batteries.
        emitLifecycle(opts, 'transformers_js_tts', opts.model, 'compiling', {
          detail: 'compiling text-to-speech graph',
        })
        const pipe = await createPipeline({
          model: opts.model,
          device: opts.device,
          dtype: opts.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#pipeline = pipe
        emitLifecycle(opts, 'transformers_js_tts', opts.model, 'ready', {
          detail: 'text-to-speech pipeline ready',
        })
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        emitLifecycle(opts, 'transformers_js_tts', opts.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_TTS_ENGINE_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /**
   * Synthesizes text into a WAV audio clip.
   *
   * @param text - The text to speak. Passed verbatim to the pipeline.
   * @param opts - Per-call options; each field overrides the constructor default of the same name.
   * @returns A {@link GeneratedMediaOutput} descriptor with `kind: 'audio'`, `mimeType: 'audio/wav'`,
   *   and the WAV bytes.
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_TTS_ENGINE_ERROR} when the pipeline fails to
   *   load, the synthesis call throws, or the returned audio lacks `toBlob()`.
   */
  async synthesize(
    text: string,
    opts?: TransformersJsSynthesizeOptions
  ): Promise<GeneratedMediaOutput> {
    const pipe = await this.#resolvePipeline()

    const eff = {
      voice: opts?.voice ?? this.#options.voice,
      rate: opts?.rate ?? this.#options.rate,
      speakerEmbeddings: opts?.speakerEmbeddings ?? this.#options.speakerEmbeddings,
      numInferenceSteps: opts?.numInferenceSteps ?? this.#options.numInferenceSteps,
    }

    // Explicit Float32Array/URL wins; a string voice is forwarded as a speaker-embedding
    // identifier (the documented transformers.js usage for string references).
    const speakerEmbeddings =
      eff.speakerEmbeddings ?? (typeof eff.voice === 'string' ? eff.voice : undefined)

    emitLifecycle(this.#options, 'transformers_js_tts', this.#options.model, 'generating')

    let result: unknown
    try {
      result = await (
        pipe as unknown as (text: string, options: Record<string, unknown>) => Promise<unknown>
      )(text, {
        ...(typeof speakerEmbeddings !== 'undefined'
          ? { speaker_embeddings: speakerEmbeddings }
          : {}),
        ...(typeof eff.rate === 'number' ? { speed: eff.rate } : {}),
        ...(typeof eff.numInferenceSteps === 'number'
          ? { num_inference_steps: eff.numInferenceSteps }
          : {}),
      })
    } catch (err) {
      emitLifecycle(this.#options, 'transformers_js_tts', this.#options.model, 'error', {
        error: err,
      })
      throw new E_TRANSFORMERS_JS_TTS_ENGINE_ERROR([isError(err) ? err.message : String(err)])
    }

    // Encode the result to WAV bytes. A null/undefined result, a missing/throwing `toBlob`, or a
    // rejecting `arrayBuffer()` all funnel through the SAME error path: emit `error` + throw
    // E_TRANSFORMERS_JS_TTS_ENGINE_ERROR (never a raw exception escaping the contract).
    let bytes: Uint8Array
    let mimeType: string
    try {
      const rawAudio = result as Partial<RawAudioLike> | null | undefined
      if (!rawAudio || typeof rawAudio.toBlob !== 'function') {
        throw new Error('text-to-speech returned a result without a toBlob method')
      }
      const blob = rawAudio.toBlob()
      bytes = new Uint8Array(await blob.arrayBuffer())
      mimeType = blob.type || 'audio/wav'
    } catch (err) {
      emitLifecycle(this.#options, 'transformers_js_tts', this.#options.model, 'error', {
        error: err,
      })
      throw new E_TRANSFORMERS_JS_TTS_ENGINE_ERROR([isError(err) ? err.message : String(err)])
    }

    emitLifecycle(this.#options, 'transformers_js_tts', this.#options.model, 'complete')
    return {
      kind: 'audio',
      mimeType,
      bytes,
      filename: 'speech.wav',
    }
  }
}
