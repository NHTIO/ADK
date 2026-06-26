/**
 * Deterministic, battery-owned pooling + L2-normalization for the transformers.js embeddings battery.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js/pooling
 *
 * @remarks
 * Used when `poolingOwner: 'battery'`. The pipeline is asked for raw `pooling:'none'` token states —
 * a `[batch, seq, hidden]` tensor — and this module pools them into one vector per input in pure JS,
 * identically across Node and the browser. That removes the per-runtime post-processing variance that
 * widens the node↔browser cosine gap; only the irreducible ONNX-Runtime kernel floor remains.
 *
 * Pooling strategies mirror the transformers.js feature-extraction options:
 * - `mean` — attention-unaware mean over the sequence axis (matches the pipeline's `'mean'`, which
 *   also means over all positions for a single ungrouped sequence).
 * - `cls` / `first_token` — the first token's hidden state.
 * - `eos` / `last_token` — the last token's hidden state.
 * - `none` — no pooling (caller already has the vector); returned unchanged per row.
 */

/** A 3-D `[batch, seq, hidden]` nested array (raw token states from `pooling:'none'`). */
export type TokenStates3D = number[][][]
/** A 2-D `[batch, hidden]` nested array (already-pooled vectors). */
export type Pooled2D = number[][]

/**
 * Mean-pool a `[seq, hidden]` matrix into a `[hidden]` vector.
 *
 * @param rows - The per-token hidden-state rows.
 */
const meanPool = (rows: number[][]): number[] => {
  const seq = rows.length
  if (seq === 0) return []
  const hidden = rows[0].length
  const out = new Array<number>(hidden).fill(0)
  for (const row of rows) {
    for (let h = 0; h < hidden; h++) out[h] += row[h]
  }
  for (let h = 0; h < hidden; h++) out[h] /= seq
  return out
}

/**
 * L2-normalize a vector in place-safe fashion (returns a new array). A zero vector is returned
 * unchanged (no divide-by-zero).
 *
 * @param vec - The vector to normalize.
 */
export const l2Normalize = (vec: number[]): number[] => {
  let sumSq = 0
  for (const v of vec) sumSq += v * v
  const norm = Math.sqrt(sumSq)
  if (norm === 0) return vec.slice()
  return vec.map((v) => v / norm)
}

/**
 * Pool a single `[seq, hidden]` matrix into one `[hidden]` vector per the strategy.
 *
 * @param rows - The per-token hidden-state rows for one input.
 * @param pooling - The pooling strategy.
 */
const poolOne = (rows: number[][], pooling: string): number[] => {
  switch (pooling) {
    case 'cls':
    case 'first_token':
      return (rows[0] ?? []).slice()
    case 'eos':
    case 'last_token':
      return (rows[rows.length - 1] ?? []).slice()
    case 'none':
      // No pooling requested but we have token states — fall back to mean so a vector still results.
      return meanPool(rows)
    case 'mean':
    default:
      return meanPool(rows)
  }
}

/**
 * Pool raw `[batch, seq, hidden]` token states into `[batch, hidden]` vectors and optionally
 * L2-normalize — the deterministic battery-owned path (`poolingOwner: 'battery'`).
 *
 * @param tokenStates - The `[batch, seq, hidden]` raw states from `pooling:'none'`.
 * @param pooling - The pooling strategy (`'mean'` default).
 * @param normalize - Whether to L2-normalize each pooled vector (default `true`).
 * @returns One pooled (and optionally normalized) vector per batch row.
 */
export const poolAndNormalize = (
  tokenStates: TokenStates3D,
  pooling: string,
  normalize: boolean
): Pooled2D =>
  tokenStates.map((rows) => {
    const pooled = poolOne(rows, pooling)
    return normalize ? l2Normalize(pooled) : pooled
  })

/** Default {@link poolAndNormalize}. */
export const defaultPoolAndNormalize = poolAndNormalize
