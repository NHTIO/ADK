/**
 * Cross-environment OpenAI Embeddings adapter battery.
 *
 * @module @nhtio/adk/batteries/embeddings/openai/adapter
 *
 * @remarks
 * Opinionated embeddings battery for the OpenAI `/v1/embeddings` wire shape. Ships an
 * {@link OpenAIEmbeddingsAdapter} that targets any OpenAI-`/v1/embeddings`-compatible endpoint
 * (OpenAI proper, Azure-behind-proxy, vLLM, Together, a local gateway, etc.) over raw `fetch` —
 * no SDK dependency, so it runs unchanged in Node, the browser, edge runtimes, and workers.
 *
 * The class shares its method surface, return types, prefix handling, and option base with the
 * WebLLM Embeddings battery: the two differ only in their engine. See
 * {@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions}.
 *
 * Construction validates options eagerly via {@link @nhtio/adk/batteries/embeddings/openai/validation!validateOptions} and throws
 * {@link @nhtio/adk/batteries/embeddings/openai/exceptions!E_INVALID_OPENAI_EMBEDDINGS_OPTIONS} on failure — config bugs fail loud, not at embed time.
 */

import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { applyEmbeddingPrefix } from './helpers'
// Accepted-shared-runtime tier (see CONTRIBUTING.md → Design Decisions → #13 Battery design):
// pure, class-free retry primitives shared with the Chat Completions LLM batteries. No core class
// coupling — same tier as guards/createException — so this deep relative reach is accepted as-is,
// not re-exported through a shim.
import { computeBackoff, sleepWithJitter, parseRetryAfter } from '../../../lib/utils/retry'
import {
  E_OPENAI_EMBEDDINGS_HTTP_ERROR,
  E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE,
} from './exceptions'
import type {
  EmbedOptions,
  EmbeddingsRetryConfig,
  OpenAIEmbeddingsAdapterOptions,
  OpenAIEmbeddingsRequestBody,
  OpenAIEmbeddingsResponseBody,
} from './types'

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Embeddings adapter for the OpenAI `/v1/embeddings` wire shape.
 *
 * @remarks
 * Reusable: construct once, call {@link OpenAIEmbeddingsAdapter.embed} / {@link embedMany} as many
 * times as needed. `embedMany` issues one request per call (OpenAI embeds a batch in a single
 * round-trip); `embed` is sugar over `embedMany([text])`.
 */
export class OpenAIEmbeddingsAdapter {
  readonly #options: OpenAIEmbeddingsAdapterOptions

  /**
   * Whether this battery can run in the current environment. For the HTTP-backed OpenAI battery
   * this is always `true` (a `fetch` is always resolvable); present for surface-parity with the
   * WebLLM battery's WebGPU gate.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries/embeddings/openai/exceptions!E_INVALID_OPENAI_EMBEDDINGS_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries/embeddings/openai/validation!openAIEmbeddingsOptionsSchema} (e.g. missing `model`).
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
  }

  /** Declared output dimensionality (from options), or `undefined` if not configured. */
  get dimensions(): number | undefined {
    return this.#options.dimensions
  }

  /** See {@link OpenAIEmbeddingsAdapter.isAvailable}. Instance alias for surface-parity. */
  isAvailable(): boolean {
    return OpenAIEmbeddingsAdapter.isAvailable()
  }

  /**
   * No-op warm-up. The OpenAI battery has no engine to preload; present for surface-parity with
   * the WebLLM battery so callers can treat the two interchangeably.
   */
  async preload(): Promise<void> {
    // intentionally empty — nothing to warm for an HTTP-backed battery
  }

  /**
   * No-op state reset. Present for surface-parity with the WebLLM battery.
   */
  reset(): void {
    // intentionally empty — the OpenAI battery holds no engine state
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
   * Embeds a batch of strings in a single request.
   *
   * @param texts - The input texts.
   * @param opts - Per-call options (`kind`). Defaults to `kind: 'document'`.
   * @returns One embedding vector per input, in input order, each a plain `number[]`.
   * @throws {@link @nhtio/adk/batteries/embeddings/openai/exceptions!E_OPENAI_EMBEDDINGS_HTTP_ERROR} on a non-2xx response or transport failure.
   * @throws {@link @nhtio/adk/batteries/embeddings/openai/exceptions!E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT} when the handshake exceeds `requestTimeoutMs`.
   * @throws {@link @nhtio/adk/batteries/embeddings/openai/exceptions!E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE} when the 2xx body is not the expected shape.
   */
  async embedMany(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) return []
    const kind = opts?.kind ?? 'document'
    const input = applyEmbeddingPrefix(texts, kind, this.#options)

    const body: OpenAIEmbeddingsRequestBody = {
      model: this.#options.model,
      input,
      encoding_format: 'float',
      ...(this.#options.dimensions !== undefined ? { dimensions: this.#options.dimensions } : {}),
    }

    const rawBase = this.#options.baseURL ?? 'https://api.openai.com/v1'
    const baseURL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
    const url = `${baseURL}/embeddings`

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.#options.apiKey) {
      headers['Authorization'] = `Bearer ${this.#options.apiKey}`
    }
    if (this.#options.headers) {
      Object.assign(headers, this.#options.headers)
    }

    const retryCfg: Required<EmbeddingsRetryConfig> = {
      maxAttempts: this.#options.retry?.maxAttempts ?? 1,
      baseDelayMs: this.#options.retry?.baseDelayMs ?? 500,
      maxDelayMs: this.#options.retry?.maxDelayMs ?? 30_000,
      retriableStatuses: this.#options.retry?.retriableStatuses ?? [429, 500, 502, 503, 504],
      honorRetryAfter: this.#options.retry?.honorRetryAfter ?? true,
    }

    const fetchFn = this.#options.fetch ?? globalThis.fetch
    const requestTimeoutMs = this.#options.requestTimeoutMs ?? 0
    const maxAttempts = retryCfg.maxAttempts

    let attempt = 1
    while (attempt <= maxAttempts) {
      const controller = new AbortController()
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      if (requestTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs)
      }

      let response: Response
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (err) {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (controller.signal.aborted) {
          // Timed out before headers — retry if attempts remain.
          if (attempt < maxAttempts) {
            await sleepWithJitter(computeBackoff(attempt, retryCfg))
            attempt += 1
            continue
          }
          throw new E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT([requestTimeoutMs])
        }
        // Generic transport failure — retry if attempts remain, else surface as status 0.
        if (attempt < maxAttempts) {
          await sleepWithJitter(computeBackoff(attempt, retryCfg))
          attempt += 1
          continue
        }
        throw new E_OPENAI_EMBEDDINGS_HTTP_ERROR([0, isError(err) ? err.message : String(err)])
      }
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

      if (!response.ok) {
        const status = response.status
        const retriable = retryCfg.retriableStatuses.includes(status)
        if (retriable && attempt < maxAttempts) {
          let delay = computeBackoff(attempt, retryCfg)
          if (retryCfg.honorRetryAfter) {
            const ra = response.headers.get('Retry-After')
            if (ra) {
              const raMs = parseRetryAfter(ra)
              if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs)
            }
          }
          await sleepWithJitter(delay)
          attempt += 1
          continue
        }
        const detail = await response.text().catch(() => '')
        throw new E_OPENAI_EMBEDDINGS_HTTP_ERROR([status, detail])
      }

      let parsed: OpenAIEmbeddingsResponseBody
      try {
        parsed = (await response.json()) as OpenAIEmbeddingsResponseBody
      } catch (err) {
        throw new E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE([isError(err) ? err.message : String(err)])
      }
      if (!parsed || !Array.isArray(parsed.data) || parsed.data.length !== input.length) {
        throw new E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE([
          `expected ${input.length} vectors, got ${parsed?.data?.length ?? 'none'}`,
        ])
      }
      // OpenAI may return data out of order; sort by `index` to restore input order.
      return parsed.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding)
    }

    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw new E_OPENAI_EMBEDDINGS_HTTP_ERROR([0, 'retry loop exhausted without a response'])
  }
}
