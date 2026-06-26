/**
 * transformers.js (ONNX, dual-environment) Embeddings adapter battery.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js/adapter
 *
 * @remarks
 * Embeddings battery backed by transformers.js's `feature-extraction` pipeline. **Environment-neutral**
 * — runs in Node (via `onnxruntime-node`) and the browser (via `onnxruntime-web` / WebGPU), auto-
 * selected by the package; there is no WebGPU requirement, so this battery is surfaced from the
 * environment-neutral `@nhtio/adk/batteries/embeddings` barrel alongside the OpenAI one.
 *
 * Same user-facing surface as the OpenAI / WebLLM embeddings batteries (`isAvailable` / `dimensions` /
 * `preload` / `reset` / `embed` / `embedMany`), same `number[]` return shape, same query/document
 * prefix handling (the shared `applyEmbeddingPrefix`).
 *
 * `@huggingface/transformers` is an optional peer dependency, imported lazily.
 *
 * **Cross-runtime vector caveat:** embeddings produced here are not guaranteed bit-identical to those
 * from a different runtime (WebLLM/MLC, or even node-ONNX vs web-ONNX for the same model). A vector
 * corpus must be embedded AND queried by one backend.
 */

import { isError } from '@nhtio/adk/guards'
import { poolAndNormalize } from './pooling'
import { validateOptions } from './validation'
import { applyEmbeddingPrefix } from '../openai/helpers'
import { emitLifecycle } from '../../llm/chat_common/lifecycle'
import { withModelSource } from '../../llm/transformers_js/model_source'
import {
  E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS,
  E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR,
} from './exceptions'
import type { EmbedOptions } from '../openai/types'
import type {
  TransformersJsEmbeddingsAdapterOptions,
  TransformersJsEmbeddingsPipeline,
  CreateTransformersJsEmbeddingsPipeline,
} from './types'

const makeDefaultCreatePipeline = (
  modelSource: TransformersJsEmbeddingsAdapterOptions['modelSource']
): CreateTransformersJsEmbeddingsPipeline => {
  return async ({ model, device, dtype, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { pipeline, env } = transformers
    const load = async () =>
      (await pipeline('feature-extraction', model, {
        ...(device ? { device } : {}),
        ...(dtype ? { dtype } : {}),
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      } as never)) as unknown as TransformersJsEmbeddingsPipeline
    // When a custom model source is configured, serve files through it behind the global-`env` mutex.
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

/**
 * Embeddings adapter for transformers.js's feature-extraction pipeline.
 *
 * @remarks
 * Reusable: construct once, call {@link TransformersJsEmbeddingsAdapter.embed} / {@link embedMany} as
 * many times as needed. The pipeline is resolved lazily on first use (or via {@link preload}) and
 * cached with single-flight semantics so concurrent calls share one load.
 */
export class TransformersJsEmbeddingsAdapter {
  readonly #options: TransformersJsEmbeddingsAdapterOptions
  #pipeline: TransformersJsEmbeddingsPipeline | undefined
  #pipelinePromise: Promise<TransformersJsEmbeddingsPipeline> | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer — there is no WebGPU requirement.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#pipeline = this.#options.pipeline
  }

  /** Declared output dimensionality (from options), or `undefined` if not configured. */
  get dimensions(): number | undefined {
    return this.#options.dimensions
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TransformersJsEmbeddingsAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the pipeline so the first `embed` call is fast. Idempotent. */
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
   * stay alive until GC. Loading many embedding models back-to-back in one browser session (e.g. a full
   * matrix run) accumulates those sessions until the heap is exhausted. `FeatureExtractionPipeline`
   * extends `Pipeline`, which exposes `dispose()` — this awaits it so the memory is reclaimed between
   * loads, swallows a disposal error (teardown must not throw), and finishes with `reset()`. Idempotent.
   */
  async dispose(): Promise<void> {
    const pipeline = this.#pipeline ?? (await this.#pipelinePromise?.catch(() => undefined))
    const pipeWithDispose = pipeline as { dispose?: () => Promise<unknown> } | undefined
    if (typeof pipeWithDispose?.dispose === 'function') {
      await Promise.resolve(pipeWithDispose.dispose()).catch(() => undefined)
    }
    this.reset()
  }

  async #resolvePipeline(): Promise<TransformersJsEmbeddingsPipeline> {
    if (this.#pipeline) return this.#pipeline
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS([
        'the transformers.js embeddings battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#pipelinePromise ??= (async () => {
      emitLifecycle(opts, 'transformers_js_embed', opts.model, 'loading', {
        detail: 'loading feature-extraction pipeline',
      })
      // Forward each provider download event into a normalized `loading` lifecycle report.
      const hasLifecycle =
        opts.onLifecycle ?? opts.onLoading ?? opts.onReady ?? opts.onGenerating ?? opts.onError
      const forwardedInitProgress = hasLifecycle
        ? (info: unknown) => {
            const p = (info as { progress?: number } | undefined)?.progress
            emitLifecycle(opts, 'transformers_js_embed', opts.model, 'loading', {
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
        // (fetch + compile overlap inside the call), consistent with the LLM batteries.
        emitLifecycle(opts, 'transformers_js_embed', opts.model, 'compiling', {
          detail: 'compiling feature-extraction graph',
        })
        const pipe = await createPipeline({
          model: opts.model,
          device: opts.device,
          dtype: opts.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#pipeline = pipe
        emitLifecycle(opts, 'transformers_js_embed', opts.model, 'ready', {
          detail: 'feature-extraction pipeline ready',
        })
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        emitLifecycle(opts, 'transformers_js_embed', opts.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /**
   * Embeds a single string.
   *
   * @param text - The input text.
   * @param opts - Per-call options (`kind`).
   * @returns The embedding vector as a plain `number[]`.
   */
  async embed(text: string, opts?: EmbedOptions): Promise<number[]> {
    const [vec] = await this.embedMany([text], opts)
    return vec
  }

  /**
   * Embeds a batch of strings in a single pipeline call.
   *
   * @param texts - The input texts.
   * @param opts - Per-call options (`kind`). Defaults to `kind: 'document'`.
   * @returns One embedding vector per input, in input order, each a plain `number[]`.
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR} when the call fails
   *   or returns a malformed result.
   */
  async embedMany(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return []
    const kind = opts?.kind ?? 'document'
    const input = applyEmbeddingPrefix(texts, kind, this.#options)

    const pipe = await this.#resolvePipeline()
    const pooling = this.#options.pooling ?? 'mean'
    const normalize = this.#options.normalize ?? true
    const battery = (this.#options.poolingOwner ?? 'engine') === 'battery'

    emitLifecycle(this.#options, 'transformers_js_embed', this.#options.model, 'generating')

    let tensor: { tolist: () => unknown; dims?: number[] }
    try {
      tensor = (await (pipe as unknown as (i: unknown, o: unknown) => Promise<unknown>)(
        input,
        // 'battery' owner: request RAW token states (no engine pooling/normalize) and do it ourselves
        // in deterministic JS. 'engine' owner: delegate to the pipeline exactly as before.
        battery ? { pooling: 'none' } : { pooling, normalize }
      )) as { tolist: () => unknown; dims?: number[] }
    } catch (err) {
      emitLifecycle(this.#options, 'transformers_js_embed', this.#options.model, 'error', {
        error: err,
      })
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        isError(err) ? err.message : String(err),
      ])
    }

    if (!tensor || typeof tensor.tolist !== 'function') {
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        'feature-extraction returned a non-Tensor result',
      ])
    }

    const list = tensor.tolist()
    let vectors: number[][]
    if (battery) {
      // Raw states: tolist() → [batch, seq, hidden]. A single ungrouped input may come back as
      // [seq, hidden] → wrap to a batch of one. Pool + normalize deterministically.
      const states = list as unknown[]
      const tokenStates = (
        Array.isArray(states) &&
        Array.isArray(states[0]) &&
        Array.isArray((states[0] as unknown[])[0])
          ? states
          : [states]
      ) as number[][][]
      vectors = poolAndNormalize(tokenStates, pooling, normalize)
    } else {
      // With engine pooling, the Tensor is [batch, hidden] → tolist() yields number[][].
      vectors =
        Array.isArray(list) && Array.isArray(list[0]) ? (list as number[][]) : [list as number[]]
    }

    if (vectors.length !== input.length) {
      emitLifecycle(this.#options, 'transformers_js_embed', this.#options.model, 'error', {
        error: new Error(`expected ${input.length} vectors, got ${vectors.length}`),
      })
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        `expected ${input.length} vectors, got ${vectors.length}`,
      ])
    }
    emitLifecycle(this.#options, 'transformers_js_embed', this.#options.model, 'complete')
    return vectors
  }
}
