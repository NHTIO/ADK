/**
 * Battery-scoped exception constructors for the native Bedrock Converse adapter.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse/exceptions
 *
 * @remarks
 * Two Converse-specific classifications earn their own exceptions because both are ACTIONABLE and
 * both arrive as a generic validation error otherwise:
 * {@link E_CONVERSE_MISSING_TOOL_CONFIG} and {@link E_CONVERSE_ALTERNATION_VIOLATION}.
 */

import { createException } from '@nhtio/adk/factories'

/** Resolved options failed validation. */
export const E_INVALID_BEDROCK_CONVERSE_OPTIONS = createException<[string]>(
  'E_INVALID_BEDROCK_CONVERSE_OPTIONS',
  'Invalid Bedrock Converse adapter options: %s',
  'E_INVALID_BEDROCK_CONVERSE_OPTIONS',
  529,
  true
)

/** The provider returned a non-2xx status. */
export const E_CONVERSE_REQUEST_FAILED = createException<[number, string]>(
  'E_CONVERSE_REQUEST_FAILED',
  'Bedrock Converse request failed with status %s: %s',
  'E_CONVERSE_REQUEST_FAILED',
  502,
  false
)

/**
 * Converse rejected the request because `toolUse`/`toolResult` blocks appeared with no `toolConfig`.
 *
 * @remarks
 * Classified separately because the fix is specific and non-obvious: `toolConfig` must be present
 * whenever the TRANSCRIPT contains a tool block, even when no tools are offered for this turn and
 * the calls are pure history. The battery declares it automatically; this fires when a custom
 * `buildConverseRequest` omits it.
 */
export const E_CONVERSE_MISSING_TOOL_CONFIG = createException<[string]>(
  'E_CONVERSE_MISSING_TOOL_CONFIG',
  'Bedrock Converse requires toolConfig when toolUse/toolResult blocks are present: %s',
  'E_CONVERSE_MISSING_TOOL_CONFIG',
  400,
  false
)

/**
 * Converse rejected the request for non-alternating roles.
 *
 * @remarks
 * Only reachable under `alternationPolicy: 'reject'`, which exists precisely so this error can be
 * OBSERVED rather than silently repaired — a repair applied before dispatch is invisible in the
 * response, which makes a client-side fix indistinguishable from vendor tolerance.
 */
export const E_CONVERSE_ALTERNATION_VIOLATION = createException<[string]>(
  'E_CONVERSE_ALTERNATION_VIOLATION',
  'Bedrock Converse rejected non-alternating roles: %s',
  'E_CONVERSE_ALTERNATION_VIOLATION',
  400,
  false
)

/** A transport error or malformed frame killed the stream. */
export const E_CONVERSE_STREAM_ERROR = createException<[string]>(
  'E_CONVERSE_STREAM_ERROR',
  'Bedrock Converse stream error: %s',
  'E_CONVERSE_STREAM_ERROR',
  502,
  false
)

/** A `toolUse` block carried an `input` value that is not a plain object. */
export const E_CONVERSE_INVALID_TOOL_INPUT = createException<[string]>(
  'E_CONVERSE_INVALID_TOOL_INPUT',
  'Bedrock Converse toolUse input is not a plain object: %s',
  'E_CONVERSE_INVALID_TOOL_INPUT',
  422,
  false
)
