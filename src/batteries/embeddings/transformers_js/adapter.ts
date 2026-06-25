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
import { validateOptions } from './validation'
import { applyEmbeddingPrefix } from '../openai/helpers'
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

const defaultCreatePipeline: CreateTransformersJsEmbeddingsPipeline = async ({
  model,
  device,
  dtype,
  onInitProgress,
}) => {
  const { pipeline } = await import('@huggingface/transformers')
  return (await pipeline('feature-extraction', model, {
    ...(device ? { device } : {}),
    ...(dtype ? { dtype } : {}),
    ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
  } as never)) as unknown as TransformersJsEmbeddingsPipeline
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

  async #resolvePipeline(): Promise<TransformersJsEmbeddingsPipeline> {
    if (this.#pipeline) return this.#pipeline
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS([
        'the transformers.js embeddings battery is not available in this runtime',
      ])
    }
    this.#pipelinePromise ??= (async () => {
      const createPipeline = this.#options.createPipeline ?? defaultCreatePipeline
      try {
        const pipe = await createPipeline({
          model: this.#options.model,
          device: this.#options.device,
          dtype: this.#options.dtype,
          onInitProgress: this.#options.onInitProgress,
        })
        this.#pipeline = pipe
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
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

    let tensor: { tolist: () => unknown; dims?: number[] }
    try {
      tensor = (await (pipe as unknown as (i: unknown, o: unknown) => Promise<unknown>)(input, {
        pooling: this.#options.pooling ?? 'mean',
        normalize: this.#options.normalize ?? true,
      })) as { tolist: () => unknown; dims?: number[] }
    } catch (err) {
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        isError(err) ? err.message : String(err),
      ])
    }

    if (!tensor || typeof tensor.tolist !== 'function') {
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        'feature-extraction returned a non-Tensor result',
      ])
    }

    // With pooling, the Tensor is [batch, hidden] → tolist() yields number[][].
    const list = tensor.tolist()
    const vectors =
      Array.isArray(list) && Array.isArray(list[0]) ? (list as number[][]) : [list as number[]]

    if (vectors.length !== input.length) {
      throw new E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR([
        `expected ${input.length} vectors, got ${vectors.length}`,
      ])
    }
    return vectors
  }
}
