/**
 * WebLLM (WebGPU, in-process) Embeddings adapter battery.
 *
 * @module @nhtio/adk/batteries/embeddings/webllm/adapter
 *
 * @remarks
 * Embeddings battery backed by WebLLM's in-process `engine.embeddings.create()` (the OpenAI-style
 * embeddings API exposed by `@mlc-ai/web-llm`). Runs entirely in the browser on WebGPU — no
 * network round-trip, no API key.
 *
 * This class is the **same battery** as {@link @nhtio/adk/batteries/embeddings/openai!OpenAIEmbeddingsAdapter}
 * in every user-facing respect — identical method surface (`isAvailable` / `dimensions` /
 * `preload` / `reset` / `embed` / `embedMany`), identical `number[]` return shape, identical
 * query/document prefix handling (the shared `applyEmbeddingPrefix` helper) — differing only in
 * the engine. Construction validates eagerly and throws
 * {@link @nhtio/adk/batteries/embeddings/webllm/exceptions!E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS} on failure.
 *
 * `@mlc-ai/web-llm` is an optional peer dependency, imported lazily so non-WebGPU consumers pay
 * nothing for it.
 */

import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { applyEmbeddingPrefix } from '../openai/helpers'
import { E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS, E_WEBLLM_EMBEDDINGS_ENGINE_ERROR } from './exceptions'
import type { EmbedOptions } from '../openai/types'
import type {
  WebLLMEmbeddingsAdapterOptions,
  WebLLMEmbeddingsEngine,
  CreateWebLLMEmbeddingsEngine,
} from './types'

const defaultCreateEngine: CreateWebLLMEmbeddingsEngine = async ({
  model,
  engineConfig,
  chatOptions,
  onInitProgress,
}) => {
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
  return (await CreateMLCEngine(
    model,
    { ...(engineConfig ?? {}), initProgressCallback: onInitProgress },
    chatOptions
  )) as WebLLMEmbeddingsEngine
}

/**
 * Embeddings adapter for WebLLM's in-process embeddings API.
 *
 * @remarks
 * Reusable: construct once, call {@link WebLLMEmbeddingsAdapter.embed} / {@link embedMany} as many
 * times as needed. The engine is resolved lazily on first use (or via {@link preload}) and cached
 * with single-flight semantics so concurrent calls share one load.
 */
export class WebLLMEmbeddingsAdapter {
  readonly #options: WebLLMEmbeddingsAdapterOptions
  #engine: WebLLMEmbeddingsEngine | undefined
  #enginePromise: Promise<WebLLMEmbeddingsEngine> | undefined

  /**
   * Whether WebGPU — and therefore this battery — is available in the current runtime.
   */
  public static isAvailable(): boolean {
    return (
      typeof globalThis.navigator !== 'undefined' &&
      'gpu' in globalThis.navigator &&
      typeof (globalThis.navigator as { gpu?: unknown }).gpu !== 'undefined'
    )
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries/embeddings/webllm/exceptions!E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries/embeddings/webllm/validation!webLLMEmbeddingsOptionsSchema} (e.g. missing `model`).
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#engine = this.#options.engine
  }

  /** Declared output dimensionality (from options), or `undefined` if not configured. */
  get dimensions(): number | undefined {
    return this.#options.dimensions
  }

  /** Whether WebGPU is available, honoring an injected `isWebGPUAvailable` probe. */
  isAvailable(): boolean {
    return (this.#options.isWebGPUAvailable ?? WebLLMEmbeddingsAdapter.isAvailable)()
  }

  /**
   * Eagerly loads (and caches) the engine so the first `embed` call is fast. Idempotent.
   *
   * @throws {@link @nhtio/adk/batteries/embeddings/webllm/exceptions!E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS} when no WebGPU is available and no engine
   *   was injected.
   * @throws {@link @nhtio/adk/batteries/embeddings/webllm/exceptions!E_WEBLLM_EMBEDDINGS_ENGINE_ERROR} when engine creation fails.
   */
  async preload(): Promise<void> {
    await this.#resolveEngine()
  }

  /** Drops the cached engine and in-flight load so the next call reloads. */
  reset(): void {
    this.#engine = undefined
    this.#enginePromise = undefined
  }

  async #resolveEngine(): Promise<WebLLMEmbeddingsEngine> {
    if (this.#engine) return this.#engine
    if (!this.isAvailable()) {
      throw new E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS([
        'WebLLM requires a browser/runtime with WebGPU support',
      ])
    }
    this.#enginePromise ??= (async () => {
      const createEngine = this.#options.createEngine ?? defaultCreateEngine
      try {
        const engine = await createEngine({
          model: this.#options.model,
          engineConfig: this.#options.engineConfig,
          chatOptions: this.#options.chatOptions,
          onInitProgress: this.#options.onInitProgress,
        })
        this.#engine = engine
        return engine
      } catch (err) {
        // Clear the cached promise so a later call can retry a transient load failure.
        this.#enginePromise = undefined
        throw new E_WEBLLM_EMBEDDINGS_ENGINE_ERROR([isError(err) ? err.message : String(err)])
      }
    })()
    return this.#enginePromise
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
   * Embeds a batch of strings in a single engine call.
   *
   * @param texts - The input texts.
   * @param opts - Per-call options (`kind`). Defaults to `kind: 'document'`.
   * @returns One embedding vector per input, in input order, each a plain `number[]`.
   * @throws {@link @nhtio/adk/batteries/embeddings/webllm/exceptions!E_WEBLLM_EMBEDDINGS_ENGINE_ERROR} when the engine call fails or returns a
   *   malformed result.
   */
  async embedMany(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return []
    const kind = opts?.kind ?? 'document'
    const input = applyEmbeddingPrefix(texts, kind, this.#options)

    const engine = await this.#resolveEngine()

    let response: { data?: Array<{ embedding: number[]; index: number }> }
    try {
      response = await engine.embeddings.create({ model: this.#options.model, input })
    } catch (err) {
      throw new E_WEBLLM_EMBEDDINGS_ENGINE_ERROR([isError(err) ? err.message : String(err)])
    }

    if (!response || !Array.isArray(response.data) || response.data.length !== input.length) {
      throw new E_WEBLLM_EMBEDDINGS_ENGINE_ERROR([
        `expected ${input.length} vectors, got ${response?.data?.length ?? 'none'}`,
      ])
    }
    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding)
  }
}
