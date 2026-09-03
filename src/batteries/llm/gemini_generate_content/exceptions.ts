/**
 * Battery-scoped exception constructors for the native Gemini `generateContent` adapter.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/exceptions
 *
 * @remarks
 * Owned by the battery, not the ADK core, and minted via `createException` from
 * `@nhtio/adk/factories`. The set mirrors the other chat batteries with one Gemini-specific
 * addition: {@link E_GEMINI_MISSING_THOUGHT_SIGNATURE}, which classifies the vendor's own hard
 * rejection of unsigned historical function calls so a caller can tell it apart from a generic
 * invalid-request — Gemini's error body is otherwise an opaque `INVALID_ARGUMENT`.
 */

import { createException } from '@nhtio/adk/factories'

/** Resolved options (constructor, executor overrides, or `stash.geminiGenerateContent`) failed validation. */
export const E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS = createException<[string]>(
  'E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS',
  'Invalid Gemini generateContent adapter options: %s',
  'E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS',
  529,
  true
)

/** The provider returned a non-2xx status. */
export const E_GEMINI_REQUEST_FAILED = createException<[number, string]>(
  'E_GEMINI_REQUEST_FAILED',
  'Gemini generateContent request failed with status %s: %s',
  'E_GEMINI_REQUEST_FAILED',
  502,
  false
)

/**
 * Gemini rejected the request because a historical `functionCall` part carried no
 * `thoughtSignature`.
 *
 * @remarks
 * Distinguished from a generic invalid-request because it is ACTIONABLE: the caller either replays
 * a genuine signature, or opts into the documented sentinel via
 * `thoughtSignatureSentinel`. Gemini 3+ enforces this; 2.5 treats it as advisory.
 */
export const E_GEMINI_MISSING_THOUGHT_SIGNATURE = createException<[string]>(
  'E_GEMINI_MISSING_THOUGHT_SIGNATURE',
  'Gemini rejected a historical functionCall with no thoughtSignature: %s',
  'E_GEMINI_MISSING_THOUGHT_SIGNATURE',
  400,
  false
)

/** A transport error or malformed frame killed the stream mid-generation. */
export const E_GEMINI_STREAM_ERROR = createException<[string]>(
  'E_GEMINI_STREAM_ERROR',
  'Gemini generateContent stream error: %s',
  'E_GEMINI_STREAM_ERROR',
  502,
  false
)

/** A `functionCall` part carried an `args` value that is not a plain object. */
export const E_GEMINI_INVALID_TOOL_CALL_ARGS = createException<[string]>(
  'E_GEMINI_INVALID_TOOL_CALL_ARGS',
  'Gemini functionCall args are not a plain object: %s',
  'E_GEMINI_INVALID_TOOL_CALL_ARGS',
  422,
  false
)
