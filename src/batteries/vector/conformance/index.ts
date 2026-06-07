/**
 * Shared conformance suite for vector-store adapters. Drive any adapter through
 * {@link runVectorStoreConformance} to verify it honours the same contract all shipped adapters do.
 * Public, deep-import-only (`@nhtio/adk/batteries/vector/conformance`) — it imports `vitest`, an
 * optional peer you install to run the suite; it is never pulled in by the battery barrel.
 *
 * @module @nhtio/adk/batteries/vector/conformance
 */

import { describe, expect, it } from 'vitest'
import type { CallableVectorStore } from '../contract'

// A deterministic stub encoder: 3-dim vector from text features.
export const stubEncoder = async (
  texts: string[],
  _kind: 'query' | 'document'
): Promise<number[][]> =>
  texts.map((tx) => [tx.length, tx.includes('cat') ? 1 : 0, tx.includes('dog') ? 1 : 0])

// A dimension-padding encoder factory: wraps the 3-feature stub and zero-extends to `dim`.
// Used by backends that enforce a minimum dimension (e.g. Cloudflare Vectorize requires 32–1536).
export const paddedStubEncoder =
  (dim: number) =>
  async (texts: string[], kind: 'query' | 'document'): Promise<number[][]> => {
    const base = await stubEncoder(texts, kind)
    return base.map((v) => padVector(v, dim))
  }

// Zero-extend (or truncate) a vector to exactly `dim` entries. dim===3 (the default) returns the
// vector unchanged, so existing callers are byte-for-byte identical.
const padVector = (v: number[], dim: number): number[] => {
  if (v.length === dim) return v
  if (v.length > dim) return v.slice(0, dim)
  return [...v, ...new Array(dim - v.length).fill(0)]
}

// makeStore: () => Promise<CallableVectorStore> | CallableVectorStore  (already connected +
// collection 'docs' created with the matching dimension). `dim` defaults to 3 — pass a larger
// value for backends with a dimension floor (the harness pads every test vector to `dim`, and the
// store's collection must be created at the same `dim`).
//
// `opts.retry` / `opts.timeout` are forwarded to every `it()`. Both default to vitest's defaults
// (retry 0), so existing callers are unchanged. They exist for aggressively eventually-consistent
// managed backends (e.g. Cloudflare Vectorize) whose read-after-write can flap for seconds: a
// retried attempt re-runs `makeStore()` (re-clearing state) against an index that's had more time
// to settle, turning transient-consistency flake into deterministic green without weakening any
// assertion. Each `it` re-derives its store via makeStore, so retries are self-contained.
export const runVectorStoreConformance = (
  label: string,
  makeStore: () => Promise<CallableVectorStore>,
  dim = 3,
  opts: { retry?: number; timeout?: number } = {}
): void => {
  const p = (v: number[]): number[] => padVector(v, dim)
  const io = { retry: opts.retry ?? 0, timeout: opts.timeout ?? 5000 }
  describe('conformance: ' + label, () => {
    it('upserts vectors and searches by nearVector with [0,1] score', io, async () => {
      const vs = await makeStore()
      await vs('docs').upsert([
        { id: '1', vector: p([3, 1, 0]), metadata: { kind: 'animal' } },
        { id: '2', vector: p([3, 0, 1]), metadata: { kind: 'animal' } },
      ])
      const res = await vs('docs')
        .nearVector(p([3, 1, 0]))
        .select('id', 'score')
        .limit(2)
      expect(res.length).toBe(2)
      expect(res[0].id).toBeDefined()
      expect(typeof res[0].score).toBe('number')
      expect(res[0].score! >= 0 && res[0].score! <= 1).toBe(true)
    })
    it('encodes text on upsert+nearText when an encoder is configured', io, async () => {
      const vs = await makeStore()
      await vs('docs').upsert([{ id: 'c', document: 'cat', metadata: {} }])
      const res = await vs('docs').nearText('cat').select('id').limit(1)
      expect(res.length).toBe(1)
      expect(res[0].id).toBe('c')
    })
    it('requires .select() on reads', io, async () => {
      const vs = await makeStore()
      await expect(
        (async () => {
          await vs('docs').nearVector(p([1, 1, 1]))
        })()
      ).rejects.toThrow()
    })
    it('filter-scan (no near) returns rows without score', io, async () => {
      const vs = await makeStore()
      await vs('docs').upsert([{ id: '1', vector: p([1, 0, 0]), metadata: { kind: 'x' } }])
      const res = await vs('docs').where('kind', 'x').select('id', 'metadata').limit(10)
      expect(res.length).toBe(1)
      expect(res[0].score).toBeUndefined()
    })
    it('nested filter A AND (B OR C) selects the right subset', io, async () => {
      const vs = await makeStore()
      // Every record carries all three fields so the test probes nested AND/OR routing, not
      // backend-specific missing-field semantics (e.g. Chroma's $or excludes records missing a
      // referenced key, where the JS evaluator treats that clause as merely false).
      await vs('docs').upsert([
        { id: 'a', vector: p([1, 0, 0]), metadata: { kind: 'doc', year: 2024, pinned: false } }, // kept (year arm)
        { id: 'b', vector: p([0, 1, 0]), metadata: { kind: 'doc', year: 2010, pinned: false } }, // dropped (neither arm)
        { id: 'c', vector: p([0, 0, 1]), metadata: { kind: 'doc', year: 2010, pinned: true } }, // kept (pinned arm)
        { id: 'd', vector: p([1, 1, 0]), metadata: { kind: 'other', year: 2024, pinned: true } }, // dropped (kind mismatch)
      ])
      // kind = 'doc' AND (year >= 2024 OR pinned = true)
      const res = await vs('docs')
        .where('kind', 'doc')
        .andWhere((qb) => qb.where('year', '>=', 2024).orWhere('pinned', true))
        .select('id')
        .limit(10)
      expect(res.map((r) => r.id).sort()).toEqual(['a', 'c'])
    })
    it('projection: vector excluded unless selected', io, async () => {
      const vs = await makeStore()
      await vs('docs').upsert([{ id: '1', vector: p([1, 0, 0]) }])
      const noVec = await vs('docs')
        .nearVector(p([1, 0, 0]))
        .select('id')
        .limit(1)
      expect(noVec[0].vector).toBeUndefined()
      const withVec = await vs('docs')
        .nearVector(p([1, 0, 0]))
        .select('id', 'vector')
        .limit(1)
      expect(Array.isArray(withVec[0].vector)).toBe(true)
    })
    it('deletes by id', io, async () => {
      const vs = await makeStore()
      await vs('docs').upsert([
        { id: '1', vector: p([1, 0, 0]) },
        { id: '2', vector: p([0, 1, 0]) },
      ])
      await vs('docs').whereIn('id', ['1']).delete()
      const all = await vs('docs').select('id').limit(10)
      expect(all.length).toBe(1)
    })
    it('throws transaction-unsupported when capabilities.transactions is false', io, async () => {
      const vs = await makeStore()
      if (!vs.capabilities.transactions) {
        await expect(vs.transaction(async () => {})).rejects.toThrow()
      }
    })
  })
}
