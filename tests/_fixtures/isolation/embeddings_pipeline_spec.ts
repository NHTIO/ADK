import { method, resolveIsolatedServiceSpec } from '@nhtio/adk/batteries/isolation'

/**
 * Shared isolated-service spec (WP5 Proof B): a single `embed` method mirroring the exact call shape
 * the REAL `TransformersJsEmbeddingsAdapter` makes against a transformers.js `feature-extraction`
 * pipeline — `pipe(texts, {pooling, normalize})` → a Tensor-like. Returns `{ vectors }` (plain JSON;
 * the adapter-facing `{tolist(), dims}` reconstruction happens host-side, since functions cannot cross
 * the wire as data). Shared by the guest (`embeddings_pipeline_child.ts`) and the host spec so both
 * sides can't drift. Bypasses validating `defineIsolatedService` per this suite's convention.
 */
export const embeddingsPipelineSpec = resolveIsolatedServiceSpec({
  name: 'embeddings-pipeline-fixture',
  methods: {
    /** Mirrors `pipe(texts, {pooling, normalize})`. */
    embed: method<[string[], { pooling?: string; normalize?: boolean }], { vectors: number[][] }>(),
  },
})
