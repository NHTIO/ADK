/**
 * Option and wire-shape types for the OpenAI media generation adapter, plus the shared generation
 * battery base type both current and future generation batteries build on.
 *
 * @module @nhtio/adk/batteries/generation/openai/types
 *
 * @remarks
 * This module owns the **shared** generation option base ({@link BaseGenerationAdapterOptions})
 * and the shared call shapes ({@link GenerateOptions}, {@link EditOptions}). Future generation
 * batteries (Gemini, transformers.js) re-export and `extend` these rather than redefining them, so
 * every generation battery differs only in its engine — exactly how the WebLLM Embeddings battery
 * extends the OpenAI Embeddings option type.
 */

import type { GenerationImageInput } from '../_shared'
import type { GeneratedMediaOutput } from '../../llm/chat_common/types'

/**
 * A single piece of generated media (an image today) returned from `generate`/`edit`. Re-exported
 * type-only from the LLM Chat Completions battery's shared types so generation adapters and LLM
 * batteries describe generated media identically — see {@link GeneratedMediaOutput}.
 */
export type { GeneratedMediaOutput }

/**
 * Retry/backoff configuration for HTTP-backed generation batteries. Mirrors the embeddings
 * battery's `EmbeddingsRetryConfig` so behavior is consistent across the bundled batteries.
 */
export interface GenerationRetryConfig {
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
 * Options shared by **every** generation battery's `generate` call, regardless of engine.
 */
export interface GenerateOptions {
  /** Number of images to generate. Engine-defaulted when omitted. */
  n?: number
}

/**
 * Options shared by **every** generation battery's `edit` call, regardless of engine.
 */
export interface EditOptions {
  /** Number of edited images to generate. Engine-defaulted when omitted. */
  n?: number
}

/**
 * Options shared by **every** generation battery, regardless of engine.
 *
 * @remarks
 * Engine-specific batteries extend this with their own transport/engine fields. `model` is
 * **required with no default** — naming the generation model is the caller's responsibility,
 * never the battery's.
 */
export interface BaseGenerationAdapterOptions {
  /**
   * Model id to generate/edit images with. **Required, no default.** For OpenAI this is e.g.
   * `gpt-image-1` or `dall-e-3`.
   */
  model: string
}

/**
 * Constructor options for {@link @nhtio/adk/batteries/generation/openai/adapter!OpenAIGenerationAdapter}.
 *
 * @remarks
 * Extends {@link BaseGenerationAdapterOptions} with the HTTP transport fields plus OpenAI's
 * image-generation-specific knobs.
 */
export interface OpenAIGenerationAdapterOptions extends BaseGenerationAdapterOptions {
  /** Bearer token. Sent as `Authorization: Bearer <apiKey>` unless overridden by `headers`. */
  apiKey?: string
  /** API base URL. Default `https://api.openai.com/v1`. A trailing slash is trimmed. */
  baseURL?: string
  /** Extra request headers. Override built defaults (including `Authorization`) key-by-key. */
  headers?: Record<string, string>
  /** Custom `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Retry/backoff configuration. Default: a single attempt (no retry). */
  retry?: GenerationRetryConfig
  /** Per-request handshake timeout in ms. `0`/unset disables the timeout. */
  requestTimeoutMs?: number
  /** Default image size (e.g. `'1024x1024'`), applied when a call omits its own `size`. */
  size?: string
  /** Default rendering quality, applied when a call omits its own `quality`. */
  quality?: 'low' | 'medium' | 'high' | 'auto'
  /** Default output image format, applied when a call omits its own `outputFormat`. */
  outputFormat?: 'png' | 'jpeg' | 'webp'
  /** Default background handling, applied when a call omits its own `background`. */
  background?: 'transparent' | 'opaque' | 'auto'
  /**
   * Controls whether the request body includes `response_format: 'b64_json'`.
   *
   * @remarks
   * - `'auto'` (default) — include it only when `model` starts with `'dall-e'`. `dall-e-*` models
   *   default to returning a hosted URL unless told otherwise; `gpt-image-*` models always return
   *   base64 and reject the parameter.
   * - `'send'` — always include it, regardless of model.
   * - `'omit'` — never include it.
   */
  responseFormatMode?: 'auto' | 'send' | 'omit'
}

/**
 * Per-call options accepted by {@link @nhtio/adk/batteries/generation/openai/adapter!OpenAIGenerationAdapter.generate}.
 */
export interface OpenAIGenerateOptions extends GenerateOptions {
  /** Image size (e.g. `'1024x1024'`). Falls back to the adapter's configured default. */
  size?: string
  /** Rendering quality. Falls back to the adapter's configured default. */
  quality?: 'low' | 'medium' | 'high' | 'auto'
  /** Output image format. Falls back to the adapter's configured default. */
  outputFormat?: 'png' | 'jpeg' | 'webp'
  /** Background handling. Falls back to the adapter's configured default. */
  background?: 'transparent' | 'opaque' | 'auto'
}

/**
 * Per-call options accepted by {@link @nhtio/adk/batteries/generation/openai/adapter!OpenAIGenerationAdapter.edit}.
 */
export interface OpenAIEditOptions extends EditOptions {
  /** Optional mask image marking the editable region; transparent pixels are edited. */
  mask?: GenerationImageInput
  /** Image size (e.g. `'1024x1024'`). Falls back to the adapter's configured default. */
  size?: string
  /** Rendering quality. Falls back to the adapter's configured default. */
  quality?: 'low' | 'medium' | 'high' | 'auto'
}

/**
 * The JSON request body POSTed to `/v1/images/generations`.
 */
export interface OpenAIImagesGenerationRequestBody {
  /** ID of the image generation model to use. */
  model: string
  /** The text prompt describing the desired image(s). */
  prompt: string
  /** Number of images to generate. */
  n?: number
  /** Requested image size (e.g. `'1024x1024'`). */
  size?: string
  /** Requested rendering quality. */
  quality?: string
  /** Requested output image format. */
  output_format?: string
  /** Requested background handling. */
  background?: string
  /** Requested response encoding; `'b64_json'` when present. */
  response_format?: string
}

/**
 * The relevant subset of the `/v1/images/generations` and `/v1/images/edits` JSON response shape.
 */
export interface OpenAIImagesResponse {
  /** The generated/edited images, each carrying a base64-encoded payload. */
  data: Array<{ b64_json?: string }>
}
