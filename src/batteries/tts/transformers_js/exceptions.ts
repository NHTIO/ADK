/**
 * Battery-scoped exception constructors for the transformers.js TTS adapter.
 *
 * @module @nhtio/adk/batteries/tts/transformers_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`)
 * text-to-speech adapter, minted via `createException` from `@nhtio/adk/factories`. Categories mirror
 * the transformers.js STT battery one-to-one — only the engine-specific failure differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `transformersJsTtsOptionsSchema` — e.g. a missing/empty `model` or an unknown option key.
 * Fatal: config bugs fail loud, not at synthesize time.
 */
export const E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS',
  'Invalid transformers.js TTS adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the transformers.js pipeline fails to load (e.g. the `@huggingface/transformers` peer
 * is not installed) or the `text-to-speech` call throws/returns a malformed result. Non-fatal.
 * Printf arg: `[detail]`.
 */
export const E_TRANSFORMERS_JS_TTS_ENGINE_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_TTS_ENGINE_ERROR',
  'transformers.js TTS engine error: %s',
  'E_TRANSFORMERS_JS_TTS_ENGINE_ERROR',
  502,
  false
)
