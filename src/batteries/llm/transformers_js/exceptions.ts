/**
 * Battery-scoped exception constructors for the transformers.js LLM adapter.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`) LLM adapter,
 * minted via `createException` from `@nhtio/adk/factories` and re-exported from the battery barrel.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.transformersJs`) fail validation against `transformersJsOptionsSchema`.
 */
export const E_INVALID_TRANSFORMERS_JS_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_OPTIONS',
  'Invalid transformers.js adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`. Only raised
 * when `tokenEncoding` is non-null.
 */
export const E_TRANSFORMERS_JS_CONTEXT_OVERFLOW = createException<[number, number, string, string]>(
  'E_TRANSFORMERS_JS_CONTEXT_OVERFLOW',
  'transformers.js request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_TRANSFORMERS_JS_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the transformers.js pipeline fails to load (e.g. the `@huggingface/transformers` peer
 * is not installed) or the generation call errors. Non-fatal — surfaced via `ctx.nack(...)`.
 */
export const E_TRANSFORMERS_JS_STREAM_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_STREAM_ERROR',
  'transformers.js generation error: %s',
  'E_TRANSFORMERS_JS_STREAM_ERROR',
  502,
  false
)

/**
 * Raised when a tool call parsed out of model output carries malformed arguments (not a JSON object).
 *
 * @remarks
 * Non-fatal. The adapter does NOT throw it — it instantiates it inside `executeAndPersistToolCall`,
 * pulls `.message` into a {@link @nhtio/adk!Tokenizable}, and persists a `ToolCall` with
 * `isError: true` so the model can self-correct. Printf args: `[reasonHeadline, rawArgs]`.
 */
export const E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when the model emitted text that looked like a tool call but no configured parser could
 * extract a well-formed call from it.
 *
 * @remarks
 * Non-fatal. The adapter persists a `ToolCall` with `isError: true` carrying this message so the
 * model self-corrects on the next iteration (e.g. switch the `toolCallParser` option to match the
 * model family, or supply a custom parser). Printf args: `[parserName, rawTextExcerpt]`.
 */
export const E_TRANSFORMERS_JS_TOOL_PARSE_FAILED = createException<[string, string]>(
  'E_TRANSFORMERS_JS_TOOL_PARSE_FAILED',
  'transformers.js: model output looked like a tool call but parser "%s" could not extract one. Output excerpt: %s. Configure the `toolCallParser` option to match the model family, or supply a custom parser function.',
  'E_TRANSFORMERS_JS_TOOL_PARSE_FAILED',
  422,
  false
)

/**
 * Raised when a {@link @nhtio/adk!Media} instance whose modality the configured model cannot consume
 * reaches the adapter under `unsupportedMediaPolicy: 'throw'`.
 *
 * @remarks
 * Printf args: `[kind, mimeType, filename]`.
 */
export const E_UNSUPPORTED_MEDIA_MODALITY = createException<[string, string, string]>(
  'E_UNSUPPORTED_MEDIA_MODALITY',
  'transformers.js does not support media of kind %s (mime=%s, filename=%s) for the configured model. Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
