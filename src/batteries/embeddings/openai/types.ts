/**
 * Option and wire-shape types for the OpenAI Embeddings adapter, plus the shared embeddings
 * battery base type both bundled embeddings batteries build on.
 *
 * @module @nhtio/adk/batteries/embeddings/openai/types
 *
 * @remarks
 * This module owns the **shared** embeddings option base ({@link BaseEmbeddingsAdapterOptions})
 * and the shared call shapes ({@link EmbeddingKind}, {@link EmbedOptions}). The WebLLM Embeddings
 * battery re-exports and `extends` these rather than redefining them, so the two batteries differ
 * only in their engine — exactly how the WebLLM Chat Completions battery extends the OpenAI Chat
 * Completions option type.
 */

/**
 * Whether a piece of text is being embedded as a search **query** or as a corpus **document**.
 *
 * @remarks
 * Asymmetric-embedding models (e.g. Snowflake Arctic Embed) expect a short instruction prefix on
 * queries but not on documents. The battery prepends {@link BaseEmbeddingsAdapterOptions.queryPrefix}
 * when `kind === 'query'` and {@link BaseEmbeddingsAdapterOptions.documentPrefix} when
 * `kind === 'document'` — each only if the corresponding prefix option is set. Defaults to
 * `'document'`, so the neutral (un-prefixed, unless a document prefix is configured) path is taken
 * when a caller does not specify.
 */
export type EmbeddingKind = 'query' | 'document'

/**
 * Per-call options accepted by `embed` / `embedMany`. Identical across both batteries.
 */
export interface EmbedOptions {
  /** Whether the input is a query or a document. Defaults to `'document'`. */
  kind?: EmbeddingKind
}

/**
 * Retry/backoff configuration for HTTP-backed embeddings batteries. Mirrors the chat battery's
 * `ChatCompletionsRetryConfig` so behavior is consistent across the bundled batteries.
 */
export interface EmbeddingsRetryConfig {
  /** Max total attempts (including the first). Default `1` (no retry). */
  maxAttempts?: number
  /** Base backoff delay in ms; doubled each attempt. Default `500`. */
  baseDelayMs?: number
  /** Backoff ceiling in ms. Default `30_000`. */
  maxDelayMs?: number
  /** HTTP statuses eligible for retry. Default `[429, 500, 502, 503, 504]`. */
  retriableStatuses?: number[]
  /** Honor an upstream `Retry-After` header when present. Default `true`. */
  honorRetryAfter?: boolean
}

/**
 * Options shared by **every** embeddings battery, regardless of engine.
 *
 * @remarks
 * Engine-specific batteries extend this with their own transport/engine fields. `model` is
 * **required with no default** — naming the embedding model is the caller's responsibility, never
 * the battery's.
 */
export interface BaseEmbeddingsAdapterOptions {
  /**
   * Model id to embed with. **Required, no default.** For OpenAI this is e.g.
   * `text-embedding-3-small`; for WebLLM it is an MLC embedding model id (e.g.
   * `snowflake-arctic-embed-m-q0f32-MLC`).
   */
  model: string
  /**
   * Instruction prefix prepended to inputs embedded with `kind: 'query'`. Unset → no prefix.
   * For Snowflake Arctic Embed, the documented value is
   * `'Represent this sentence for searching relevant passages: '`.
   */
  queryPrefix?: string
  /**
   * Instruction prefix prepended to inputs embedded with `kind: 'document'`. Unset → no prefix.
   * Most asymmetric models (including Arctic) use no document prefix; exposed for symmetry and
   * the models that do.
   */
  documentPrefix?: string
  /**
   * Declared output dimensionality, surfaced via `adapter.dimensions`. Optional metadata for
   * callers that pre-allocate buffers; the battery does not enforce it against responses.
   */
  dimensions?: number
}

/**
 * Constructor options for {@link @nhtio/adk/batteries/embeddings/openai/adapter!OpenAIEmbeddingsAdapter}.
 *
 * @remarks
 * Extends {@link BaseEmbeddingsAdapterOptions} with the HTTP transport fields the WebLLM battery
 * deliberately omits. Targets any OpenAI-`/v1/embeddings`-compatible endpoint (OpenAI proper,
 * Azure-behind-proxy, vLLM, Together, a local gateway, etc.).
 */
export interface OpenAIEmbeddingsAdapterOptions extends BaseEmbeddingsAdapterOptions {
  /** Bearer token. Sent as `Authorization: Bearer <apiKey>` unless overridden by `headers`. */
  apiKey?: string
  /** API base URL. Default `https://api.openai.com/v1`. A trailing slash is trimmed. */
  baseURL?: string
  /** Extra request headers. Override built defaults (including `Authorization`) key-by-key. */
  headers?: Record<string, string>
  /** Custom `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Retry/backoff configuration. Default: a single attempt (no retry). */
  retry?: EmbeddingsRetryConfig
  /** Per-request handshake timeout in ms. `0`/unset disables the timeout. */
  requestTimeoutMs?: number
}

/**
 * The JSON request body POSTed to `/v1/embeddings`.
 */
export interface OpenAIEmbeddingsRequestBody {
  /** ID of the embedding model to use. */
  model: string
  /** The batch of texts to embed. */
  input: string[]
  /** Wire encoding for the returned vectors; always `'float'`. */
  encoding_format: 'float'
  /** Optional output dimensionality for models that support truncation. */
  dimensions?: number
}

/**
 * The relevant subset of the `/v1/embeddings` JSON response shape.
 */
export interface OpenAIEmbeddingsResponseBody {
  /** The embedding vectors, each tagged with its input `index`. */
  data: Array<{ embedding: number[]; index: number }>
  /** Model that produced the embeddings. */
  model?: string
  /** Object type reported by the API (e.g. `'list'`). */
  object?: string
}
