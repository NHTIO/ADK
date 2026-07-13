/**
 * Battery-scoped exception constructors for OpenAI media generation adapter failures.
 *
 * @module @nhtio/adk/batteries/generation/openai/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the OpenAI media generation adapter. These exceptions are
 * owned by the battery (not the ADK core) and are minted via `createException` from
 * `@nhtio/adk/factories`. Re-exported from the battery's barrel.
 *
 * The categories mirror the OpenAI Embeddings battery one-to-one so batteries across domains fail
 * with parallel semantics — only the engine-specific transport exception differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `openAIGenerationOptionsSchema` — e.g. a missing/empty `model`, an unknown option key, or an
 * invalid enum value. Fatal: config bugs fail loud at construction time, not at generate/edit time.
 */
export const E_INVALID_OPENAI_GENERATION_OPTIONS = createException<[string]>(
  'E_INVALID_OPENAI_GENERATION_OPTIONS',
  'Invalid OpenAI Generation adapter options: %s',
  'E_INVALID_OPENAI_GENERATION_OPTIONS',
  529,
  true
)

/**
 * Thrown when the upstream `/v1/images/generations` or `/v1/images/edits` endpoint returns a
 * non-2xx response (after retries are exhausted), or the transport throws. Non-fatal. Printf args:
 * `[status, detail]` — `status` is `0` for a transport-level failure with no HTTP response.
 */
export const E_OPENAI_GENERATION_HTTP_ERROR = createException<[number, string]>(
  'E_OPENAI_GENERATION_HTTP_ERROR',
  'OpenAI Generation HTTP error %d: %s',
  'E_OPENAI_GENERATION_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the request handshake does not complete before `requestTimeoutMs` (and retries are
 * exhausted). Non-fatal. Printf arg: `[requestTimeoutMs]`.
 */
export const E_OPENAI_GENERATION_REQUEST_TIMEOUT = createException<[number]>(
  'E_OPENAI_GENERATION_REQUEST_TIMEOUT',
  'OpenAI Generation request timed out after %dms',
  'E_OPENAI_GENERATION_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Thrown when a 2xx response body cannot be parsed into the expected `{ data: [{ b64_json }] }`
 * shape (malformed JSON, missing/empty `data`, or an entry missing `b64_json`). Non-fatal. Printf
 * arg: `[detail]`.
 */
export const E_OPENAI_GENERATION_MALFORMED_RESPONSE = createException<[string]>(
  'E_OPENAI_GENERATION_MALFORMED_RESPONSE',
  'OpenAI Generation response malformed: %s',
  'E_OPENAI_GENERATION_MALFORMED_RESPONSE',
  502,
  false
)
