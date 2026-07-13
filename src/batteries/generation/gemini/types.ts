/**
 * Option and wire-shape types for the Gemini media generation adapter.
 *
 * @module @nhtio/adk/batteries/generation/gemini/types
 *
 * @remarks
 * Builds on the **shared** generation option base owned by the OpenAI Generation battery
 * ({@link @nhtio/adk/batteries/generation/openai/types!BaseGenerationAdapterOptions},
 * {@link @nhtio/adk/batteries/generation/openai/types!GenerateOptions},
 * {@link @nhtio/adk/batteries/generation/openai/types!EditOptions}). This battery re-exports those
 * shared shapes and `extend`s them with the Gemini `generativelanguage` REST engine's own
 * transport/wire fields — exactly how the transformers.js Embeddings battery extends the OpenAI
 * Embeddings option type.
 */

// Re-export the shared base shapes so consumers can import everything generation-related from
// this battery's barrel without reaching into the OpenAI battery.
export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
} from '../openai/types'

import type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
} from '../openai/types'

/**
 * The response modalities Gemini is asked to return. `'IMAGE'` is what actually yields generated
 * media; `'TEXT'` is included by default alongside it so refusal/safety text (when present)
 * arrives in the same response instead of a separate call.
 */
export type GeminiResponseModality = 'TEXT' | 'IMAGE'

/**
 * Constructor options for {@link @nhtio/adk/batteries/generation/gemini/adapter!GeminiGenerationAdapter}.
 *
 * @remarks
 * Extends {@link BaseGenerationAdapterOptions} with the HTTP transport fields plus Gemini's
 * `generateContent` knobs. Targets the native `generativelanguage.googleapis.com` REST surface
 * directly over raw `fetch` — no `@google/genai` SDK dependency.
 */
export interface GeminiGenerationAdapterOptions extends BaseGenerationAdapterOptions {
  /** API key. Sent as `x-goog-api-key: <apiKey>` unless overridden by `headers`. */
  apiKey?: string
  /**
   * API base URL. Default `https://generativelanguage.googleapis.com/v1beta`. A trailing slash is
   * trimmed.
   */
  baseURL?: string
  /** Extra request headers. Override built defaults (including `x-goog-api-key`) key-by-key. */
  headers?: Record<string, string>
  /** Custom `fetch` implementation. Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Retry/backoff configuration. Default: a single attempt (no retry). */
  retry?: GenerationRetryConfig
  /** Per-request handshake timeout in ms. `0`/unset disables the timeout. */
  requestTimeoutMs?: number
  /**
   * Response modalities requested from `generateContent`. Default `['TEXT', 'IMAGE']` — probe-
   * confirmed as the shape that reliably yields an `inlineData` image part.
   */
  responseModalities?: GeminiResponseModality[]
  /** Default aspect ratio (e.g. `'16:9'`), applied when a call omits its own `aspectRatio`. */
  aspectRatio?: string
}

/**
 * Per-call options accepted by {@link @nhtio/adk/batteries/generation/gemini/adapter!GeminiGenerationAdapter.generate}.
 */
export interface GeminiGenerateOptions extends GenerateOptions {
  /** Aspect ratio (e.g. `'16:9'`). Falls back to the adapter's configured default. */
  aspectRatio?: string
}

/**
 * Per-call options accepted by {@link @nhtio/adk/batteries/generation/gemini/adapter!GeminiGenerationAdapter.edit}.
 */
export interface GeminiEditOptions extends EditOptions {
  /** Aspect ratio (e.g. `'16:9'`). Falls back to the adapter's configured default. */
  aspectRatio?: string
}

/**
 * A single content part in a Gemini `generateContent` request. Requests always send **camelCase**
 * `inlineData` — probe-confirmed to be accepted whether the request is routed through the LB or
 * hits Google directly.
 */
export type GeminiRequestPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

/**
 * A single entry in the `contents` array of a `generateContent` request.
 */
export interface GeminiContent {
  /** The role producing this content. Always `'user'` for this battery's requests. */
  role: 'user'
  /** The ordered parts making up this content (image parts, if any, then the text prompt). */
  parts: GeminiRequestPart[]
}

/**
 * The `generationConfig` block of a `generateContent` request.
 */
export interface GeminiGenerationConfig {
  /** Requested response modalities. */
  responseModalities?: GeminiResponseModality[]
  /** Best-effort requested candidate count — some models ignore this. */
  candidateCount?: number
  /** Image-specific generation knobs. */
  imageConfig?: { aspectRatio?: string }
}

/**
 * The JSON request body POSTed to `/models/{model}:generateContent`.
 */
export interface GeminiGenerateContentRequestBody {
  /** The conversation contents — for this battery, always a single user turn. */
  contents: GeminiContent[]
  /** Generation configuration (response modalities, candidate count, image config). */
  generationConfig?: GeminiGenerationConfig
}

/**
 * A single content part in a Gemini `generateContent` **response**. Tolerates both the canonical
 * camelCase `inlineData` and a defensive snake_case `inline_data` — response-only tolerance; this
 * battery's requests always send camelCase.
 */
export type GeminiResponsePart =
  | { text: string }
  | { inlineData: { mimeType?: string; data: string } }
  | { inline_data: { mimeType?: string; data: string } }

/**
 * The relevant subset of the `/models/{model}:generateContent` JSON response shape.
 */
export interface GeminiGenerateContentResponse {
  /** Generated candidates, each carrying its own content parts. */
  candidates?: Array<{
    content?: {
      parts?: GeminiResponsePart[]
    }
  }>
}
