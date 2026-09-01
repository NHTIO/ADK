/**
 * Battery-scoped exception constructors for the OpenAI Responses adapter.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the OpenAI Responses adapter. These exceptions are owned by
 * the battery (not the ADK core) and are minted via `createException` from `@nhtio/adk/factories`.
 * Re-exported from the battery's barrel. The status codes and fatal split mirror the sibling
 * `openai_chat_completions` and `anthropic_messages` batteries.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.openaiResponses`) fail validation against `openAIResponsesOptionsSchema`.
 */
export const E_INVALID_OPENAI_RESPONSES_OPTIONS = createException<[string]>(
  'E_INVALID_OPENAI_RESPONSES_OPTIONS',
  'Invalid OpenAI Responses adapter options: %s',
  'E_INVALID_OPENAI_RESPONSES_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`. Only raised
 * when `tokenEncoding` is non-null. Carries `{ total, contextWindow, tokenEncoding, perBucket }` in
 * the message so middleware can target shedding.
 */
export const E_OPENAI_RESPONSES_CONTEXT_OVERFLOW = createException<
  [number, number, string, string]
>(
  'E_OPENAI_RESPONSES_CONTEXT_OVERFLOW',
  'OpenAI Responses request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_OPENAI_RESPONSES_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the upstream Responses endpoint returns a non-2xx response. Non-fatal — surfaced via
 * `ctx.nack(...)` so middleware can decide retry / fail.
 */
export const E_OPENAI_RESPONSES_HTTP_ERROR = createException<[number, string]>(
  'E_OPENAI_RESPONSES_HTTP_ERROR',
  'OpenAI Responses HTTP error %d: %s',
  'E_OPENAI_RESPONSES_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the SSE stream emits a malformed chunk, the transport throws mid-stream, or an
 * explicit upstream `response.failed` / `error` terminal event arrives.
 *
 * @remarks
 * NOT thrown when the stream reaches EOF without ever observing a terminal event. The Responses
 * SSE stream has no `[DONE]` sentinel, so a truncated-looking stream is indistinguishable from a
 * short one: the adapter warn-logs (`kind: 'sse-eof-without-terminal-event'`) and drains whatever
 * it accumulated, rather than discarding a usable partial turn.
 */
export const E_OPENAI_RESPONSES_STREAM_ERROR = createException<[string]>(
  'E_OPENAI_RESPONSES_STREAM_ERROR',
  'OpenAI Responses stream error: %s',
  'E_OPENAI_RESPONSES_STREAM_ERROR',
  502,
  false
)

/**
 * Thrown when the SSE stream goes silent for longer than `streamIdleTimeoutMs`. Non-fatal —
 * surfaced via `ctx.nack(...)` with partial-state details so middleware can recover.
 */
export const E_OPENAI_RESPONSES_STREAM_STALLED = createException<[number]>(
  'E_OPENAI_RESPONSES_STREAM_STALLED',
  'OpenAI Responses stream stalled (no chunk for %dms)',
  'E_OPENAI_RESPONSES_STREAM_STALLED',
  504,
  false
)

/**
 * Thrown when the initial request handshake (TCP connect, TLS, response headers) does not complete
 * before `requestTimeoutMs`. Non-fatal — surfaced via `ctx.nack(...)`. Eligible for retry on the
 * same footing as a retriable 5xx.
 */
export const E_OPENAI_RESPONSES_REQUEST_TIMEOUT = createException<[number]>(
  'E_OPENAI_RESPONSES_REQUEST_TIMEOUT',
  'OpenAI Responses request timed out after %dms (before response headers)',
  'E_OPENAI_RESPONSES_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Raised when a tool-call's `arguments` string emitted by the model is not a JSON object — either
 * non-parseable JSON, or parseable JSON whose root is not an object (e.g. a bare string, number,
 * array, or `null`).
 *
 * @remarks
 * Non-fatal. The adapter does NOT throw this — it instantiates it inside
 * `executeAndPersistToolCall`, pulls `.message` into a {@link @nhtio/adk!Tokenizable}, and persists a
 * `ToolCall` record with `isError: true`. The model sees the formatted message in the next
 * iteration's history and can self-correct. Consumers introspecting persisted error results can
 * match on the `E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS` code substring.
 *
 * Printf args: `[reasonHeadline, rawArgs]`.
 *   - `reasonHeadline` — short reason such as `'are not valid JSON'` or
 *     `'must be a JSON object; received array'`.
 *   - `rawArgs` — the raw `arguments` string the model emitted, echoed back verbatim so the model
 *     can see what it sent.
 */
export const E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when a {@link @nhtio/adk!Media} instance whose modality cannot be natively represented in
 * the OpenAI Responses wire format reaches the adapter under `unsupportedMediaPolicy: 'throw'`.
 *
 * @remarks
 * Today `audio` and `video` trigger this — the Responses input-content union has no audio member
 * (confirmed against the `openai` SDK's own type definitions) and no video member either. Consumers
 * can opt out of the throw by switching to `'fallback-stash'` or `'synthetic-description'` (see
 * {@link @nhtio/adk/batteries/llm/openai_responses/types!UnsupportedMediaPolicy}).
 *
 * Printf args: `[kind, mimeType, filename]`.
 */
export const E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY = createException<
  [string, string, string]
>(
  'E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY',
  'OpenAI Responses does not natively support media of kind %s (mime=%s, filename=%s). Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)

/**
 * Thrown when the upstream Responses API rejects the request because a replayed `reasoning` item
 * violates the undocumented reasoning/output-item pairing constraint (`openai/openai-node#1791`) —
 * detected by matching the upstream error body against known phrases (e.g. "of type 'reasoning'
 * was provided without" / "Items are not persisted when store is set to false").
 *
 * @remarks
 * Non-fatal — surfaced via `ctx.nack(...)`. Names the offending item and suggests
 * `reasoningReplay: 'off'` as a mitigation, rather than surfacing a generic HTTP error.
 *
 * Printf args: `[itemId, upstreamMessage]`.
 */
export const E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED = createException<[string, string]>(
  'E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED',
  'OpenAI Responses rejected a replayed reasoning item (%s): %s. Consider setting reasoningReplay to "off".',
  'E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED',
  422,
  false
)
