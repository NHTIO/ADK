/**
 * Battery-scoped exception constructors for LiteRT-LM adapter failures.
 *
 * @module @nhtio/adk/batteries/llm/litert_lm/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the LiteRT-LM adapter. These exceptions are owned by the
 * battery (not the ADK core) and are minted via `createException` from `@nhtio/adk/factories`.
 * Re-exported from the battery's barrel.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.liteRtLm`) fail validation against `liteRtLmOptionsSchema`.
 */
export const E_INVALID_LITERT_LM_OPTIONS = createException<[string]>(
  'E_INVALID_LITERT_LM_OPTIONS',
  'Invalid LiteRT-LM adapter options: %s',
  'E_INVALID_LITERT_LM_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`. Only raised
 * when `tokenEncoding` is non-null. Carries `{ total, contextWindow, tokenEncoding, perBucket }` in
 * the message so middleware can target shedding.
 */
export const E_LITERT_LM_CONTEXT_OVERFLOW = createException<[number, number, string, string]>(
  'E_LITERT_LM_CONTEXT_OVERFLOW',
  'LiteRT-LM request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_LITERT_LM_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the LiteRT-LM engine call or response stream fails. Non-fatal — surfaced via
 * `ctx.nack(...)`.
 */
export const E_LITERT_LM_STREAM_ERROR = createException<[string]>(
  'E_LITERT_LM_STREAM_ERROR',
  'LiteRT-LM stream error: %s',
  'E_LITERT_LM_STREAM_ERROR',
  502,
  false
)

/**
 * Raised when a tool-call emitted by the model carries malformed `arguments`.
 *
 * @remarks
 * Unlike OpenAI-wire batteries (where tool-call `arguments` arrive as a JSON **string** that may
 * fail to parse), LiteRT-LM delivers `ToolCall.function.arguments` already as a parsed object
 * (`Record<string, JsonValue>`). This exception therefore guards the rarer case where that field is
 * present but is not a plain object (e.g. an array or a primitive slipped through the wire shape).
 *
 * Non-fatal. The adapter does NOT throw this — it instantiates it inside `executeAndPersistToolCall`,
 * pulls `.message` into a {@link @nhtio/adk!Tokenizable}, and persists a `ToolCall` record with
 * `isError: true` so the model can self-correct on the next iteration.
 *
 * Printf args: `[reasonHeadline, rawArgs]`.
 */
export const E_LITERT_LM_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_LITERT_LM_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_LITERT_LM_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when a {@link @nhtio/adk!Media} instance whose modality cannot be represented for the
 * LiteRT-LM model reaches the adapter under `unsupportedMediaPolicy: 'throw'`.
 *
 * @remarks
 * The `@litert-lm/core` types expose `audioModalityEnabled` / `visionModalityEnabled`, but the
 * preview `.litertlm` models are text-in/text-out today. Media this adapter cannot map (or that the
 * configured model does not accept) triggers this under the `'throw'` policy; switch to
 * `'fallback-stash'` or `'synthetic-description'` to degrade to a text representation instead.
 *
 * Printf args: `[kind, mimeType, filename]`.
 */
export const E_UNSUPPORTED_MEDIA_MODALITY = createException<[string, string, string]>(
  'E_UNSUPPORTED_MEDIA_MODALITY',
  'LiteRT-LM does not support media of kind %s (mime=%s, filename=%s) for the configured model. Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
