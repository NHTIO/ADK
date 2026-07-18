/**
 * Battery-scoped exception constructors for Ollama Embeddings adapter failures.
 *
 * @module @nhtio/adk/batteries/embeddings/ollama/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the Ollama Embeddings adapter. These exceptions are owned
 * by the battery (not the ADK core) and are minted via `createException` from
 * `@nhtio/adk/factories`. Re-exported from the battery's barrel.
 *
 * The categories mirror the OpenAI Embeddings battery one-to-one so the two batteries fail with
 * parallel semantics — only the engine-specific transport exception differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `ollamaEmbeddingsOptionsSchema` — e.g. a missing/empty `model`, or an unknown option key.
 * Fatal: config bugs fail loud at construction time, not at embed time.
 */
export const E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS = createException<[string]>(
  'E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS',
  'Invalid Ollama Embeddings adapter options: %s',
  'E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the upstream `/api/embed` endpoint returns a non-2xx response (after retries
 * are exhausted), or the transport throws. Non-fatal. Printf args: `[status, detail]` — `status`
 * is `0` for a transport-level failure with no HTTP response.
 */
export const E_OLLAMA_EMBEDDINGS_HTTP_ERROR = createException<[number, string]>(
  'E_OLLAMA_EMBEDDINGS_HTTP_ERROR',
  'Ollama Embeddings HTTP error %d: %s',
  'E_OLLAMA_EMBEDDINGS_HTTP_ERROR',
  502,
  false
)

/**
 * Thrown when the request handshake does not complete before `requestTimeoutMs` (and retries are
 * exhausted). Non-fatal. Printf arg: `[requestTimeoutMs]`.
 */
export const E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT = createException<[number]>(
  'E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT',
  'Ollama Embeddings request timed out after %dms',
  'E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT',
  504,
  false
)

/**
 * Thrown when a 2xx response body cannot be parsed into the expected
 * `{ embeddings: number[][] }` shape (malformed JSON, missing `embeddings`, wrong vector
 * count). Non-fatal. Printf arg: `[detail]`.
 */
export const E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE = createException<[string]>(
  'E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE',
  'Ollama Embeddings response malformed: %s',
  'E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE',
  502,
  false
)
