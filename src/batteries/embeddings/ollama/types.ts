/**
 * Option and wire-shape types for the Ollama Embeddings adapter.
 *
 * @module @nhtio/adk/batteries/embeddings/ollama/types
 *
 * @remarks
 * This module builds on the **shared** embeddings option base owned by the OpenAI Embeddings
 * battery ({@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions}). The
 * Ollama Embeddings battery re-exports and `extends` these rather than redefining them — exactly
 * how the WebLLM Embeddings battery extends the shared base.
 */

import type { BaseEmbeddingsAdapterOptions, EmbeddingsRetryConfig } from '../openai/types'

// Re-export the shared base shapes so consumers can import everything embeddings-related from
// this battery's barrel without reaching into the OpenAI battery.
export type {
  EmbeddingKind,
  EmbedOptions,
  BaseEmbeddingsAdapterOptions,
  EmbeddingsRetryConfig,
} from '../openai/types'

/**
 * Runtime options for Ollama's `/api/embed` endpoint. These map directly to the `options` field
 * in the Ollama request body.
 */
export interface OllamaEmbeddingsRuntimeOptions {
  /** Context size override for the embedding model. */
  num_ctx?: number
  /** Number of threads to use for inference. */
  num_thread?: number
}

/**
 * Constructor options for {@link @nhtio/adk/batteries/embeddings/ollama/adapter!OllamaEmbeddingsAdapter}.
 *
 * @remarks
 * Extends {@link BaseEmbeddingsAdapterOptions} with the HTTP transport fields for targeting an
 * Ollama instance. `model` is **required with no default** — naming the embedding model is the
 * caller's responsibility, never the battery's.
 */
export interface OllamaEmbeddingsAdapterOptions extends BaseEmbeddingsAdapterOptions {
  /** Bearer token. Sent as `Authorization: Bearer <apiKey>` unless overridden by `headers`. */
  apiKey?: string
  /** API base URL. Default `http://localhost:11434`. A trailing slash is trimmed. */
  baseURL?: string
  /** Extra request headers. Override built defaults (including `Authorization`) key-by-key. */
  headers?: Record<string, string>
  /** Custom `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Retry/backoff configuration. Default: a single attempt (no retry). */
  retry?: EmbeddingsRetryConfig
  /** Per-request handshake timeout in ms. `0`/unset disables the timeout. */
  requestTimeoutMs?: number
  /** Whether to truncate inputs that exceed the model's context window. Default `false`. */
  truncate?: boolean
  /** How long to keep the model loaded after the request. Accepts a duration string or number (ms). */
  keepAlive?: string | number
  /** Runtime options forwarded to Ollama's `options` field in the request body. */
  options?: OllamaEmbeddingsRuntimeOptions
}

/**
 * The JSON request body POSTed to `/api/embed`.
 */
export interface OllamaEmbeddingsRequestBody {
  /** ID of the embedding model to use. */
  model: string
  /** The batch of texts to embed. Always an array, even for a single input. */
  input: string[]
  /** Optional output dimensionality for models that support truncation. */
  dimensions?: number
  /** Whether to truncate inputs that exceed the model's context window. */
  truncate?: boolean
  /** How long to keep the model loaded after the request. */
  keep_alive?: string | number
  /** Runtime options for the embedding model. */
  options?: OllamaEmbeddingsRuntimeOptions
}

/**
 * The relevant subset of the `/api/embed` JSON response shape.
 */
export interface OllamaEmbeddingsResponseBody {
  /** Model that produced the embeddings. */
  model?: string
  /** The embedding vectors, returned in input order (positional, no index field). */
  embeddings: number[][]
}
