import { serveIsolated } from '@nhtio/adk/batteries/isolation'
import { embeddingsPipelineSpec } from './embeddings_pipeline_spec'

/**
 * Guest entry point (WP5 Proof B) hosting a FAKE `feature-extraction`-shaped pipeline out-of-process —
 * no `@huggingface/transformers` import, no ONNX runtime. Implements {@link embeddingsPipelineSpec}'s
 * `embed` with deterministic hash-derived floats (one 8-dim vector per input string), so `embed`/
 * `embedMany` assertions never depend on a real model. Prebundled by `prebundle_child.ts` before
 * `fork()` (raw TS is not runnable by `child_process.fork()`).
 */
const HASH_DIMS = 8
const hashVector = (text: string): number[] =>
  Array.from({ length: HASH_DIMS }, (_, i) => {
    let h = i + 1
    for (let j = 0; j < text.length; j += 1) h = (h * 31 + text.charCodeAt(j)) % 997
    return h / 997
  })

serveIsolated(embeddingsPipelineSpec, () => ({
  embed: (texts: string[]) => ({ vectors: texts.map(hashVector) }),
}))
