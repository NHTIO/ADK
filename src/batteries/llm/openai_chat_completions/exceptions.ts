/**
 * Battery-scoped exception constructors for OpenAI Chat Completions adapter failures.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the OpenAI Chat Completions adapter. These exceptions
 * are owned by the battery (not the ADK core) and are minted via `createException` from
 * `@nhtio/adk/factories`. Re-exported from the battery's barrel.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.openaiChatCompletions`) fail validation against `openAIChatCompletionsOptionsSchema`.
 */
export const E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS = createException<[string]>(
  'E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS',
  'Invalid OpenAI Chat Completions adapter options: %s',
  'E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`. Only
 * raised when `tokenEncoding` is non-null. Carries `{ total, contextWindow, tokenEncoding,
 * perBucket }` in the message so middleware can target shedding.
 */
export const E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW = createException<
  [number, number, string, string]
>(
  'E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW',
  'OpenAI Chat Completions request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the upstream Chat Completions endpoint returns a non-2xx response. Non-fatal —
 * surfaced via `ctx.nack(...)` so middleware can decide retry / fail.
 */
export const E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR = createException<[number, string]>(
  'E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR',
  'OpenAI Chat Completions HTTP error %d: %s',
  'E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the SSE stream emits a malformed chunk or the transport throws mid-stream.
 * Non-fatal — surfaced via `ctx.nack(...)`.
 */
export const E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR = createException<[string]>(
  'E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR',
  'OpenAI Chat Completions stream error: %s',
  'E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR',
  502,
  false
)

/**
 * Thrown when the SSE stream goes silent for longer than `streamIdleTimeoutMs`. Non-fatal —
 * surfaced via `ctx.nack(...)` with partial-state details so middleware can recover.
 */
export const E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED = createException<[number]>(
  'E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED',
  'OpenAI Chat Completions stream stalled (no chunk for %dms)',
  'E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED',
  504,
  false
)

/**
 * Thrown when the initial request handshake (TCP connect, TLS, response headers) does not
 * complete before `requestTimeoutMs`. Non-fatal — surfaced via `ctx.nack(...)`. Eligible for
 * retry on the same footing as a retriable 5xx.
 */
export const E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT = createException<[number]>(
  'E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT',
  'OpenAI Chat Completions request timed out after %dms (before response headers)',
  'E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Raised when a tool-call's `arguments` string emitted by the model is not a JSON object —
 * either non-parseable JSON, or parseable JSON whose root is not an object (e.g. a bare string,
 * number, array, or `null`).
 *
 * @remarks
 * Non-fatal. The adapter does NOT throw this — it instantiates it inside
 * `executeAndPersistToolCall`, pulls `.message` into a {@link @nhtio/adk!Tokenizable}, and persists a
 * `ToolCall` record with `isError: true`. The model sees the formatted message in the next
 * iteration's history and can self-correct. Consumers introspecting persisted error results
 * can match on the `E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS` code substring.
 *
 * Printf args: `[reasonHeadline, rawArgs]`.
 *   - `reasonHeadline` — short reason such as `'are not valid JSON'` or
 *     `'must be a JSON object; received array'`.
 *   - `rawArgs` — the raw `arguments` string the model emitted, echoed back verbatim so
 *     the model can see what it sent.
 */
export const E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when a {@link @nhtio/adk!Media} instance whose modality cannot be natively represented in the
 * OpenAI Chat Completions wire format reaches the adapter under `unsupportedMediaPolicy: 'throw'`.
 *
 * @remarks
 * Today only `kind: 'video'` triggers this — Chat Completions natively supports `image`,
 * `audio`, and `document` content blocks but has no video block. Consumers can opt out of the
 * throw by switching to `'fallback-stash'` or `'synthetic-description'` (see
 * {@link @nhtio/adk/batteries/llm/openai_chat_completions/types!UnsupportedMediaPolicy}).
 *
 * Printf args: `[kind, mimeType, filename]`.
 */
export const E_UNSUPPORTED_MEDIA_MODALITY = createException<[string, string, string]>(
  'E_UNSUPPORTED_MEDIA_MODALITY',
  'OpenAI Chat Completions does not natively support media of kind %s (mime=%s, filename=%s). Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
