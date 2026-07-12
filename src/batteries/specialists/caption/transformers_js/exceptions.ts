/**
 * Battery-scoped exception constructors for the transformers.js Caption specialist adapter.
 *
 * @module @nhtio/adk/batteries/specialists/caption/transformers_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`) Caption
 * (image-to-text) adapter, minted via `createException` from `@nhtio/adk/factories`. Categories mirror
 * the embeddings/STT specialist batteries one-to-one — only the engine-specific failure differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `transformersJsCaptionOptionsSchema` — e.g. a missing/empty `model` or an unknown option key.
 * Fatal: config bugs fail loud, not at describe time.
 */
export const E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS',
  'Invalid transformers.js Caption adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS',
  529,
  true
)

/**
 * Thrown when the transformers.js pipeline fails to load (e.g. the `@huggingface/transformers` peer
 * is not installed), the `image-to-text` call throws, or the result is malformed/empty (a captioner
 * that returns no text is an engine failure, not a valid empty caption). Non-fatal. Printf arg:
 * `[detail]`.
 */
export const E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR',
  'transformers.js Caption engine error: %s',
  'E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR',
  502,
  false
)
