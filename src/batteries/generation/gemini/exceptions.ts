/**
 * Battery-scoped exception constructors for Gemini media generation adapter failures.
 *
 * @module @nhtio/adk/batteries/generation/gemini/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the Gemini media generation adapter. These exceptions are
 * owned by the battery (not the ADK core) and are minted via `createException` from
 * `@nhtio/adk/factories`. Re-exported from the battery's barrel.
 *
 * The categories mirror the OpenAI Generation battery one-to-one so batteries across engines fail
 * with parallel semantics — only the engine-specific transport exception differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `geminiGenerationOptionsSchema` — e.g. a missing/empty `model`, an unknown option key, or an
 * invalid `responseModalities` entry. Fatal: config bugs fail loud at construction time, not at
 * generate/edit time.
 */
export const E_INVALID_GEMINI_GENERATION_OPTIONS = createException<[string]>(
  'E_INVALID_GEMINI_GENERATION_OPTIONS',
  'Invalid Gemini Generation adapter options: %s',
  'E_INVALID_GEMINI_GENERATION_OPTIONS',
  529,
  true
)

/**
 * Thrown when the upstream `/models/{model}:generateContent` endpoint returns a non-2xx response
 * (after retries are exhausted), or the transport throws. Non-fatal. Printf args:
 * `[status, detail]` — `status` is `0` for a transport-level failure with no HTTP response.
 */
export const E_GEMINI_GENERATION_HTTP_ERROR = createException<[number, string]>(
  'E_GEMINI_GENERATION_HTTP_ERROR',
  'Gemini Generation HTTP error %d: %s',
  'E_GEMINI_GENERATION_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the request handshake does not complete before `requestTimeoutMs` (and retries are
 * exhausted). Non-fatal. Printf arg: `[requestTimeoutMs]`.
 */
export const E_GEMINI_GENERATION_REQUEST_TIMEOUT = createException<[number]>(
  'E_GEMINI_GENERATION_REQUEST_TIMEOUT',
  'Gemini Generation request timed out after %dms',
  'E_GEMINI_GENERATION_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Thrown when a 2xx response body cannot be parsed into the expected candidates/parts shape, or
 * when it contains zero image parts (e.g. a safety refusal returning text only). In the
 * zero-image case the detail string includes any text parts' content so refusals surface legibly.
 * Non-fatal. Printf arg: `[detail]`.
 */
export const E_GEMINI_GENERATION_MALFORMED_RESPONSE = createException<[string]>(
  'E_GEMINI_GENERATION_MALFORMED_RESPONSE',
  'Gemini Generation response malformed: %s',
  'E_GEMINI_GENERATION_MALFORMED_RESPONSE',
  502,
  false
)
