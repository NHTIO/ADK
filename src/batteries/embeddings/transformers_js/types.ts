/**
 * Option and pipeline types for the transformers.js Embeddings adapter.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js/types
 *
 * @remarks
 * Builds on the **shared** embeddings option base owned by the OpenAI Embeddings battery
 * ({@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions}). Adds the
 * transformers.js feature-extraction knobs. transformers.js is **environment-neutral** (Node +
 * browser, ONNX Runtime auto-selected) — no WebGPU requirement.
 *
 * Pipeline/dtype/device shapes are **local aliases** of `@huggingface/transformers` types, never
 * direct re-exports of the externalized peer.
 */

import type { BaseEmbeddingsAdapterOptions } from '../openai/types'
import type {
  FeatureExtractionPipeline,
  DataType as TransformersDataType,
  DeviceType as TransformersDeviceType,
  ProgressCallback,
} from '@huggingface/transformers'

// Re-export the shared base shapes so consumers can import everything embeddings-related from
// this battery's barrel without reaching into the OpenAI battery.
export type { EmbeddingKind, EmbedOptions, BaseEmbeddingsAdapterOptions } from '../openai/types'

/** The transformers.js feature-extraction pipeline this battery drives. */
export type TransformersJsEmbeddingsPipeline = FeatureExtractionPipeline
/** Quantization/precision dtype: `'auto'|'fp32'|'fp16'|'q8'|'q4'|…`. */
export type TransformersJsEmbeddingsDataType = TransformersDataType
/** Inference device: `'auto'|'webgpu'|'wasm'|'cpu'|'gpu'|…`. */
export type TransformersJsEmbeddingsDeviceType = TransformersDeviceType
/** Model-load progress callback. */
export type TransformersJsEmbeddingsProgressCallback = ProgressCallback

/** The pooling method applied to the model's per-token hidden states to produce one sentence vector. */
export type TransformersJsPooling = 'none' | 'mean' | 'cls' | 'first_token' | 'eos' | 'last_token'

/**
 * Factory for lazily creating a feature-extraction pipeline. Defaults to a dynamic import of
 * `@huggingface/transformers` + `pipeline('feature-extraction', …)`; override to inject a pre-built
 * pipeline or a test double.
 */
export type CreateTransformersJsEmbeddingsPipeline = (input: {
  model: string
  device?: TransformersJsEmbeddingsDeviceType
  dtype?: TransformersJsEmbeddingsDataType
  onInitProgress?: TransformersJsEmbeddingsProgressCallback
}) => Promise<TransformersJsEmbeddingsPipeline>

/**
 * Constructor options for the transformers.js Embeddings adapter.
 *
 * @remarks
 * Extends the shared {@link BaseEmbeddingsAdapterOptions} (required `model` + prefix options) with
 * transformers.js pipeline fields. `model` accepts any ONNX feature-extraction model id (e.g.
 * `onnx-community/all-MiniLM-L6-v2-ONNX`) — there is no default.
 */
export interface TransformersJsEmbeddingsAdapterOptions extends BaseEmbeddingsAdapterOptions {
  /** A pre-built pipeline. When provided, the battery uses it directly and skips lazy creation. */
  pipeline?: TransformersJsEmbeddingsPipeline
  /** Override the pipeline factory. Default: `pipeline('feature-extraction', …)` via dynamic import. */
  createPipeline?: CreateTransformersJsEmbeddingsPipeline
  /** Inference device forwarded to `pipeline()`. Default: transformers.js environment default. */
  device?: TransformersJsEmbeddingsDeviceType
  /** Quantization/precision dtype forwarded to `pipeline()`. */
  dtype?: TransformersJsEmbeddingsDataType
  /** Pooling method (default `'mean'`). */
  pooling?: TransformersJsPooling
  /** L2-normalise the embeddings (default `true`). */
  normalize?: boolean
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsEmbeddingsProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean
}
