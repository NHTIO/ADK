/**
 * Environment-neutral aggregate barrel for bundled media generation batteries.
 *
 * @module @nhtio/adk/batteries/generation
 *
 * @remarks
 * Aggregate barrel for the generation domain: media generation (text→image + image editing)
 * batteries — adapter classes a consumer calls from their own BYO `Tool`. Mirrors
 * `@nhtio/adk/batteries/embeddings` in shape: one shared option base
 * ({@link @nhtio/adk/batteries/generation/openai/types!BaseGenerationAdapterOptions}) owned by the
 * first engine battery, extended by every later one, plus an identical method surface
 * (`generate`/`edit`/`isAvailable`/`preload`/`reset`) across engines.
 *
 * Today this barrel re-exports:
 *
 * - `@nhtio/adk/batteries/generation/openai` — the OpenAI `/v1/images/generations` +
 *   `/v1/images/edits` battery (raw `fetch`, runs anywhere), and owner of the shared option base.
 * - `@nhtio/adk/batteries/generation/gemini` — the native Gemini `generativelanguage`
 *   `generateContent` battery (raw `fetch`, runs anywhere).
 * - `@nhtio/adk/batteries/generation/transformers_js` — EXPERIMENTAL on-device text→image via
 *   transformers.js's DeepSeek Janus (`MultiModalityCausalLM.generate_images`) family. No
 *   WebGPU requirement (environment-neutral, ONNX Runtime auto-selected), but a ~2GB model and
 *   minutes-per-image on WASM/CPU — prefer the OpenAI/Gemini engines unless offline is the point.
 * - `@nhtio/adk/batteries/generation/_shared` — the structural contracts and normalization helper
 *   (`GenerationMediaLike`, `GenerationImageInput`, `toBytes`) shared across every engine.
 *
 * `_shared`'s `toBytes` is re-exported under the domain-qualified name
 * `toGenerationBytes` (not a bare `export *`) because `@nhtio/adk/batteries/specialists` already
 * threads its own structurally-identical `toBytes` helper through this same top-level
 * `@nhtio/adk/batteries` aggregate — mirroring the `validateOptions` rename pattern every battery
 * barrel already uses to stay collision-free.
 */

export type { GenerationMediaLike, GenerationBytesInput, GenerationImageInput } from './_shared'
export { toBytes as toGenerationBytes } from './_shared'

export { OpenAIGenerationAdapter, EDIT_IMAGE_FIELD_NAME } from './openai'

export { openAIGenerationOptionsSchema } from './openai'
export { validateOptions as validateOpenAIGenerationOptions } from './openai'

export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
  OpenAIGenerationAdapterOptions,
  OpenAIGenerateOptions,
  OpenAIEditOptions,
  OpenAIImagesGenerationRequestBody,
  OpenAIImagesResponse,
} from './openai'

export {
  E_INVALID_OPENAI_GENERATION_OPTIONS,
  E_OPENAI_GENERATION_HTTP_ERROR,
  E_OPENAI_GENERATION_REQUEST_TIMEOUT,
  E_OPENAI_GENERATION_MALFORMED_RESPONSE,
} from './openai'

// ─── Gemini engine (WP-2) ──────────────────────────────────────────────────────

export { GeminiGenerationAdapter } from './gemini'

export { geminiGenerationOptionsSchema } from './gemini'
export { validateOptions as validateGeminiGenerationOptions } from './gemini'

export type {
  GeminiResponseModality,
  GeminiGenerationAdapterOptions,
  GeminiGenerateOptions,
  GeminiEditOptions,
  GeminiRequestPart,
  GeminiContent,
  GeminiGenerationConfig,
  GeminiGenerateContentRequestBody,
  GeminiResponsePart,
  GeminiGenerateContentResponse,
} from './gemini'

export {
  E_INVALID_GEMINI_GENERATION_OPTIONS,
  E_GEMINI_GENERATION_HTTP_ERROR,
  E_GEMINI_GENERATION_REQUEST_TIMEOUT,
  E_GEMINI_GENERATION_MALFORMED_RESPONSE,
} from './gemini'

// ─── transformers.js engine (WP-4, EXPERIMENTAL on-device Janus text→image) ────────────────────

export { TransformersJsGenerationAdapter } from './transformers_js'

export { transformersJsGenerationOptionsSchema } from './transformers_js'
export { validateOptions as validateTransformersJsGenerationOptions } from './transformers_js'

export type {
  TransformersJsGenerationAdapterOptions,
  TransformersJsGenerateOptions,
  TransformersJsGenerationDataType,
  TransformersJsGenerationDeviceType,
  TransformersJsGenerationProgressCallback,
  TransformersJsRawImageLike,
  TransformersJsGenerationModel,
  TransformersJsGenerationProcessor,
  TransformersJsGenerationModelSource,
  CreateTransformersJsGenerationModel,
  CreateTransformersJsGenerationProcessor,
  EncodeRawImageFn,
} from './transformers_js'

export {
  E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS,
  E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR,
  E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION,
} from './transformers_js'
