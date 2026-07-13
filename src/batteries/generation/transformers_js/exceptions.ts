/**
 * Battery-scoped exception constructors for the transformers.js Generation (on-device text→image)
 * adapter.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the transformers.js (`@huggingface/transformers`) Generation
 * adapter, minted via `createException` from `@nhtio/adk/factories`. Categories mirror the
 * embeddings/caption transformers.js batteries' `E_INVALID_*`/`E_*_ENGINE_ERROR` pair, plus a third
 * `E_*_UNSUPPORTED_OPERATION` exception (mirroring
 * `@nhtio/adk/batteries/vector!E_VECTOR_STORE_UNSUPPORTED_OPERATION`'s `[operation, reason]` shape)
 * for `edit()`, which this engine cannot perform — Janus (DeepSeek `MultiModalityCausalLM`) only
 * exposes text-conditioned `generate_images`, no image-conditioned edit/inpaint entry point.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `transformersJsGenerationOptionsSchema` — e.g. a missing/empty `model` or an unknown option key.
 * Fatal: config bugs fail loud, not at generate time.
 */
export const E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS = createException<[string]>(
  'E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS',
  'Invalid transformers.js Generation adapter options: %s',
  'E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS',
  529,
  true
)

/**
 * Thrown when the transformers.js model/processor fail to load (e.g. the `@huggingface/transformers`
 * peer is not installed), the `generate_images` call throws, or the result is malformed/empty (no
 * images returned is an engine failure, not a valid empty result). Non-fatal. Printf arg: `[detail]`.
 */
export const E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR = createException<[string]>(
  'E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR',
  'transformers.js Generation engine error: %s',
  'E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR',
  502,
  false
)

/**
 * Thrown when a caller invokes an operation this engine does not support — today, only `edit()`.
 * Janus (`MultiModalityCausalLM.generate_images`) is text-conditioned image generation only; there is
 * no image-conditioned edit/inpaint entry point in the installed `@huggingface/transformers` API
 * surface. Fatal: the caller must not retry an operation the engine structurally cannot perform.
 * Printf args: `[operation, reason]`.
 */
export const E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION = createException<[string, string]>(
  'E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION',
  'Operation "%s" is unsupported by the transformers.js Generation adapter: %s',
  'E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION',
  501,
  true
)
