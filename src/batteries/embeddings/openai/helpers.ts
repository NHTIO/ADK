/**
 * Shared, engine-agnostic helpers for the embeddings batteries.
 *
 * @module @nhtio/adk/batteries/embeddings/openai/helpers
 *
 * @remarks
 * Owned by the OpenAI Embeddings battery (the environment-neutral one) and re-used by the WebLLM
 * Embeddings battery, so query/document prefixing behaves identically across both — the engine is
 * the only difference between the batteries.
 */

import type { BaseEmbeddingsAdapterOptions, EmbeddingKind } from './types'

/**
 * Applies the configured query/document instruction prefix to a batch of inputs.
 *
 * @remarks
 * `kind: 'query'` → prepend `queryPrefix` (if set); `kind: 'document'` → prepend `documentPrefix`
 * (if set). When the relevant prefix is unset, inputs pass through verbatim. This is the single
 * source of truth for prefix handling shared by both batteries.
 *
 * @param texts - The raw inputs to embed.
 * @param kind - Whether these are queries or documents.
 * @param options - Carries `queryPrefix` / `documentPrefix`.
 * @returns A new array with prefixes applied (never mutates the input).
 */
export const applyEmbeddingPrefix = (
  texts: readonly string[],
  kind: EmbeddingKind,
  options: Pick<BaseEmbeddingsAdapterOptions, 'queryPrefix' | 'documentPrefix'>
): string[] => {
  const prefix = kind === 'query' ? options.queryPrefix : options.documentPrefix
  if (!prefix) return texts.slice()
  return texts.map((t) => `${prefix}${t}`)
}
