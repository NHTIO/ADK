/**
 * Battery-scoped exception constructors for the transformers.js Embeddings adapter.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`) Embeddings
 * adapter, minted via `createException` from `@nhtio/adk/factories`. Categories mirror the OpenAI and
 * WebLLM embeddings batteries one-to-one — only the engine-specific failure differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `transformersJsEmbeddingsOptionsSchema` — e.g. a missing/empty `model` or an unknown option key.
 * Fatal: config bugs fail loud, not at embed time.
 */
export const E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS',
  'Invalid transformers.js Embeddings adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the transformers.js pipeline fails to load (e.g. the `@huggingface/transformers` peer
 * is not installed) or the `feature-extraction` call throws/returns a malformed result. Non-fatal.
 * Printf arg: `[detail]`.
 */
export const E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR',
  'transformers.js Embeddings engine error: %s',
  'E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR',
  502,
  false
)
