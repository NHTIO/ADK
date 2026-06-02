/**
 * Battery-scoped exception constructors for WebLLM Embeddings adapter failures.
 *
 * @module @nhtio/adk/batteries/embeddings/webllm/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the WebLLM Embeddings adapter, minted via `createException`
 * from `@nhtio/adk/factories`. The categories mirror the OpenAI Embeddings battery one-to-one —
 * only the engine-specific failure exception differs (engine error vs HTTP error).
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `webLLMEmbeddingsOptionsSchema` — e.g. a missing/empty `model`, an unknown option key, or no
 * WebGPU support in the current runtime. Fatal: config bugs fail loud, not at embed time.
 */
export const E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS = createException<[string]>(
  'E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS',
  'Invalid WebLLM Embeddings adapter options: %s',
  'E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the WebLLM engine fails to load or `engine.embeddings.create()` throws/returns a
 * malformed result. Non-fatal. Printf arg: `[detail]`.
 */
export const E_WEBLLM_EMBEDDINGS_ENGINE_ERROR = createException<[string]>(
  'E_WEBLLM_EMBEDDINGS_ENGINE_ERROR',
  'WebLLM Embeddings engine error: %s',
  'E_WEBLLM_EMBEDDINGS_ENGINE_ERROR',
  502,
  false
)
