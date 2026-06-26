// Real-model matrix runner (transformers.js EMBEDDINGS, Node) — proves each embedding family loads,
// produces unit-norm vectors, and is deterministic across identical inputs. Also measures the
// poolingOwner parity hypothesis: it embeds the same text under both 'engine' and 'battery' and reports
// their cosine (a single-runtime sanity check here; the node↔browser cross-runtime number comes from
// the browser matrix). Gated on TEST_MODEL_MATRIX=1.
//
//   pnpm run test:matrix

import { describe, expect, it } from 'vitest'
import { nodeEmbedEntries } from '../../../../_fixtures/model_matrix'
import { TransformersJsEmbeddingsAdapter } from '@nhtio/adk/batteries/embeddings/transformers_js'

const RUN = process.env.TEST_MODEL_MATRIX === '1'
const ONLY = (process.env.TEST_MODEL_MATRIX_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const entries = nodeEmbedEntries().filter((e) => ONLY.length === 0 || ONLY.includes(e.id))

const isUnitNorm = (v: number[]): boolean => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return Math.abs(norm - 1) < 1e-3
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [i, element] of a.entries()) {
    dot += element * b[i]
    na += element * element
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

describe.skipIf(!RUN)('transformers.js embeddings — real-model matrix (Node, gated)', () => {
  for (const entry of entries) {
    it(`${entry.id} (${entry.family}) — deterministic unit-norm`, async () => {
      const adapter = new TransformersJsEmbeddingsAdapter({
        model: entry.modelRef,
        ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
      })
      const [a, b] = await adapter.embedMany([entry.prompt, entry.prompt])
      expect(a.length).toBeGreaterThan(0)
      expect(isUnitNorm(a), `vector not unit-norm (${entry.id})`).toBe(true)
      // Identical input → identical vector (determinism).
      expect(cosine(a, b)).toBeGreaterThan(0.9999)
    }, 900_000)

    it(`${entry.id} — poolingOwner engine vs battery cosine (parity probe)`, async () => {
      const engine = new TransformersJsEmbeddingsAdapter({
        model: entry.modelRef,
        ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
        poolingOwner: 'engine',
      })
      const battery = new TransformersJsEmbeddingsAdapter({
        model: entry.modelRef,
        ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
        poolingOwner: 'battery',
      })
      const ve = await engine.embed(entry.prompt)
      const vb = await battery.embed(entry.prompt)
      const cos = cosine(ve, vb)

      console.log(`[matrix:embed] ${entry.id} engine↔battery cosine = ${cos.toFixed(6)}`)
      // Same runtime + same pooling math → should be effectively identical (sanity bound; the
      // interesting cross-runtime number is measured in the browser matrix).
      expect(cos).toBeGreaterThan(0.99)
    }, 900_000)
  }
})

describe('transformers.js embeddings matrix — gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'} (${entries.length} entries selected)`, () => {
    expect(Array.isArray(entries)).toBe(true)
  })
})
