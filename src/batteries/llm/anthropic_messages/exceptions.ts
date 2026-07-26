/**
 * Battery-scoped exception constructors for the Anthropic Messages adapter.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the Anthropic Messages adapter. These exceptions are owned
 * by the battery, not the ADK core, and are minted via `createException` from
 * `@nhtio/adk/factories`. The status codes and fatal split mirror the pure HTTP Ollama battery.
 *
 * Important provenance rule: ADK convention uses status 529 on fatal option and context-overflow
 * exceptions raised by the adapter itself. Anthropic also returns a real upstream HTTP 529
 * `overloaded_error`, which is transient and retriable. An upstream 529 must be classified by
 * provenance as `E_ANTHROPIC_MESSAGES_HTTP_ERROR`, with retry eligibility decided by the retry
 * config. Never route a provider 529 into the fatal same-numbered ADK-side exceptions.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when resolved Anthropic Messages adapter options fail validation.
 */
export const E_INVALID_ANTHROPIC_MESSAGES_OPTIONS = createException<[string]>(
  'E_INVALID_ANTHROPIC_MESSAGES_OPTIONS',
  'Invalid Anthropic Messages adapter options: %s',
  'E_INVALID_ANTHROPIC_MESSAGES_OPTIONS',
  529,
  true
)

/**
 * Thrown when the total token weight of the resolved request exceeds `contextWindow`.
 */
export const E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW = createException<
  [number, number, string, string]
>(
  'E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW',
  'Anthropic Messages request token weight (%d) exceeds context window (%d) under encoding %s. Per-bucket breakdown: %s',
  'E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW',
  529,
  true
)

/**
 * Thrown when the upstream Messages endpoint returns an API error.
 */
export const E_ANTHROPIC_MESSAGES_HTTP_ERROR = createException<[number, string]>(
  'E_ANTHROPIC_MESSAGES_HTTP_ERROR',
  'Anthropic Messages HTTP error %d: %s',
  'E_ANTHROPIC_MESSAGES_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when a streaming Messages request emits a provider or transport failure mid-stream.
 */
export const E_ANTHROPIC_MESSAGES_STREAM_ERROR = createException<[string]>(
  'E_ANTHROPIC_MESSAGES_STREAM_ERROR',
  'Anthropic Messages stream error: %s',
  'E_ANTHROPIC_MESSAGES_STREAM_ERROR',
  502,
  false
)

/**
 * Thrown when the Messages stream goes silent for longer than `streamIdleTimeoutMs`.
 */
export const E_ANTHROPIC_MESSAGES_STREAM_STALLED = createException<[number]>(
  'E_ANTHROPIC_MESSAGES_STREAM_STALLED',
  'Anthropic Messages stream stalled (no event for %dms)',
  'E_ANTHROPIC_MESSAGES_STREAM_STALLED',
  504,
  false
)

/**
 * Thrown when the request does not complete before `requestTimeoutMs`.
 */
export const E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT = createException<[number]>(
  'E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT',
  'Anthropic Messages request timed out after %dms',
  'E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Instantiated for invalid model-emitted tool arguments and persisted as an error `ToolCall`.
 *
 * @remarks
 * The adapter must not throw this exception. It creates the exception, copies the message into a
 * tool-result payload, and persists a failed `ToolCall` so the model can self-correct on the next
 * iteration.
 */
export const E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS = createException<[string, string]>(
  'E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS',
  'Tool arguments %s. Raw value: %s',
  'E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS',
  422,
  false
)

/**
 * Raised when an ADK media instance cannot be represented by the Anthropic Messages wire.
 */
export const E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY = createException<
  [string, string, string]
>(
  'E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY',
  'Anthropic Messages supports image and selected document media; media of kind %s (mime=%s, filename=%s) is unsupported. Configure adapter `unsupportedMediaPolicy` to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
