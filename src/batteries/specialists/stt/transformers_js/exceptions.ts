/**
 * Battery-scoped exception constructors for the transformers.js STT adapter.
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`)
 * speech-to-text adapter, minted via `createException` from `@nhtio/adk/factories`. Categories mirror
 * the transformers.js Embeddings battery one-to-one — only the engine-specific failure differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `transformersJsSttAdapterOptionsSchema` — e.g. a missing/empty `model` or an unknown option key.
 * Fatal: config bugs fail loud, not at transcribe time.
 */
export const E_INVALID_TRANSFORMERS_JS_STT_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_STT_OPTIONS',
  'Invalid transformers.js STT adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_STT_OPTIONS',
  529,
  true
)

/**
 * Thrown when the transformers.js pipeline fails to load (e.g. the `@huggingface/transformers` peer
 * is not installed) or the `automatic-speech-recognition` call throws/returns a malformed result.
 * Non-fatal. Printf arg: `[detail]`.
 */
export const E_TRANSFORMERS_JS_STT_ENGINE_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_STT_ENGINE_ERROR',
  'transformers.js STT engine error: %s',
  'E_TRANSFORMERS_JS_STT_ENGINE_ERROR',
  502,
  false
)
