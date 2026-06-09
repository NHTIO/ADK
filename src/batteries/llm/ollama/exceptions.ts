/**
 * Battery-scoped exception constructors for the native Ollama `/api/chat` adapter.
 *
 * @module @nhtio/adk/batteries/llm/ollama/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the native Ollama adapter. These exceptions are owned by
 * the battery (not the ADK core) and are minted via `createException` from `@nhtio/adk/factories`.
 * Re-exported from the battery's barrel. They mirror the OpenAI Chat Completions battery's
 * exception set (same status codes, same fatal/non-fatal split) with two deliberate divergences:
 *
 * - `E_OLLAMA_INVALID_TOOL_CALL_ARGS` — native `/api/chat` returns tool-call `arguments` as a JSON
 *   **object**, not a string, so there is no `JSON.parse` failure path. This fires only when the
 *   `arguments` value is present but is not a plain object (array / null / primitive — defensive
 *   against a non-conformant server or proxy).
 * - `E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY` — native `/api/chat` supports only base64 `images[]`, so
 *   its "unsupported" set is wider than the OpenAI battery's (audio, document, and video all fall
 *   through here under `unsupportedMediaPolicy: 'throw'`).
 *
 * Malformed NDJSON lines are NOT a distinct exception — they are swallowed and surfaced via
 * `helpers.log.trace` (matching the OpenAI battery's `sse-parse-failure` policy); only a transport
 * throw mid-stream raises `E_OLLAMA_STREAM_ERROR`.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.ollama`) fail validation against `ollamaOptionsSchema`.
 */
export const E_INVALID_OLLAMA_OPTIONS = createException<[string]>(
  'E_INVALID_OLLAMA_OPTIONS',
  'Invalid Ollama adapter options: %s',
  'E_INVALID_OLLAMA_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`. Only raised
 * when `tokenEncoding` is non-null. Carries `{ total, contextWindow, tokenEncoding, perBucket }` in
 * the message so middleware can target shedding.
 *
 * @remarks
 * This is the ADK-side token-budget guard and is independent of Ollama's server-side `num_ctx`
 * (KV-cache size) runtime option; the adapter does not auto-sync the two.
 */
export const E_OLLAMA_CONTEXT_OVERFLOW = createException<[number, number, string, string]>(
  'E_OLLAMA_CONTEXT_OVERFLOW',
  'Ollama request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_OLLAMA_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the upstream `/api/chat` endpoint returns a non-2xx response. Non-fatal — surfaced
 * via `ctx.nack(...)` so middleware can decide retry / fail.
 */
export const E_OLLAMA_HTTP_ERROR = createException<[number, string]>(
  'E_OLLAMA_HTTP_ERROR',
  'Ollama HTTP error %d: %s',
  'E_OLLAMA_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the NDJSON stream emits a transport-level failure mid-stream (the reader throws).
 * Non-fatal — surfaced via `ctx.nack(...)`. A single malformed NDJSON line is NOT this error — it
 * is swallowed + logged at `trace`.
 */
export const E_OLLAMA_STREAM_ERROR = createException<[string]>(
  'E_OLLAMA_STREAM_ERROR',
  'Ollama stream error: %s',
  'E_OLLAMA_STREAM_ERROR',
  502,
  false
)

/**
 * Thrown when the NDJSON stream goes silent for longer than `streamIdleTimeoutMs`. Non-fatal —
 * surfaced via `ctx.nack(...)` so middleware can recover.
 */
export const E_OLLAMA_STREAM_STALLED = createException<[number]>(
  'E_OLLAMA_STREAM_STALLED',
  'Ollama stream stalled (no chunk for %dms)',
  'E_OLLAMA_STREAM_STALLED',
  504,
  false
)

/**
 * Thrown when the initial request handshake (TCP connect, TLS, response headers) does not complete
 * before `requestTimeoutMs`. Non-fatal — surfaced via `ctx.nack(...)`. Eligible for retry on the
 * same footing as a retriable 5xx.
 */
export const E_OLLAMA_REQUEST_TIMEOUT = createException<[number]>(
  'E_OLLAMA_REQUEST_TIMEOUT',
  'Ollama request timed out after %dms (before response headers)',
  'E_OLLAMA_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Raised when a tool-call's `arguments` value emitted by the model is present but is not a JSON
 * object (e.g. an array, `null`, or a primitive).
 *
 * @remarks
 * Non-fatal. Native `/api/chat` delivers `arguments` already parsed as an object, so — unlike the
 * OpenAI battery — there is no JSON-parse failure mode; this fires only on the not-an-object case.
 * The adapter does NOT throw it: it instantiates it inside `executeAndPersistToolCall`, pulls
 * `.message` into a {@link @nhtio/adk!Tokenizable}, and persists a `ToolCall` record with
 * `isError: true` so the model can self-correct on the next iteration.
 *
 * Printf args: `[reasonHeadline, rawArgs]`.
 *   - `reasonHeadline` — short reason such as `'must be a JSON object; received array'`.
 *   - `rawArgs` — `JSON.stringify(arguments)` of what the model sent, echoed back so it can see it.
 */
export const E_OLLAMA_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_OLLAMA_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_OLLAMA_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when a {@link @nhtio/adk!Media} instance whose modality cannot be natively represented in
 * the Ollama `/api/chat` wire format reaches the adapter under `unsupportedMediaPolicy: 'throw'`.
 *
 * @remarks
 * Native `/api/chat` supports only base64 `images[]` — it has no audio, document, or video
 * representation — so this triggers for every non-image modality (a wider set than the OpenAI
 * battery, which natively supports audio and document blocks). Consumers can opt out of the throw
 * by switching to `'fallback-stash'` or `'synthetic-description'`.
 *
 * Printf args: `[kind, mimeType, filename]`.
 */
export const E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY = createException<[string, string, string]>(
  'E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY',
  'Ollama /api/chat natively supports only images; media of kind %s (mime=%s, filename=%s) is unsupported. Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
