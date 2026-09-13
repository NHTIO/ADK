/**
 * Shared conformance suite for vector-store adapters. Drive any adapter through
 * {@link runVectorStoreConformance} to verify it honours the same contract all shipped adapters do.
 * Public, deep-import-only (`@nhtio/adk/batteries/vector/conformance`). The suite has no test-runner
 * dependency: callers invoke it and await the returned promise from any test framework.
 *
 * @module @nhtio/adk/batteries/vector/conformance
 */

import type { CallableVectorStore } from '../contract'

/** A deterministic stub encoder producing a 3-dim vector from simple text features. */
export const stubEncoder = async (
  texts: string[],
  _kind: 'query' | 'document'
): Promise<number[][]> =>
  texts.map((tx) => [tx.length, tx.includes('cat') ? 1 : 0, tx.includes('dog') ? 1 : 0])

/**
 * A dimension-padding encoder factory: wraps {@link stubEncoder} and zero-extends to `dim`. Used by
 * backends that enforce a minimum dimension (e.g. Cloudflare Vectorize requires 32–1536).
 */
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

/**
 * Drive a vector-store adapter through the shared contract suite.
 *
 * @remarks
 * `makeStore` must return an already-connected store whose `'docs'` collection is created at the
 * matching dimension; it is re-invoked per test so retries are self-contained. `dim` defaults to 3
 * — pass a larger value for backends with a dimension floor (the harness pads every test vector to
 * `dim`). `opts.retry` / `opts.timeout` are forwarded to every `it()` (defaults: retry 0, 5s) and
 * exist for aggressively eventually-consistent managed backends whose read-after-write can flap for
 * seconds — a retried attempt re-runs `makeStore()` against an index that has had more time to
 * settle, without weakening any assertion.
 *
 * @param label - Human-readable label for the suite (the adapter name).
 * @param makeStore - Factory returning a fresh, connected store with the `'docs'` collection.
 * @param dim - Vector dimensionality the harness pads to (default 3).
 * @param opts - Per-`it` retry/timeout overrides.
 */
const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const equal = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  )
    return false
  if (Array.isArray(actual) !== Array.isArray(expected)) return false
  const actualRecord = actual as Record<string, unknown>
  const expectedRecord = expected as Record<string, unknown>
  const keysA = Object.keys(actualRecord)
  const keysB = Object.keys(expectedRecord)
  if (keysA.length !== keysB.length) return false
  return keysA.every(
    (key) => Object.hasOwn(expectedRecord, key) && equal(actualRecord[key], expectedRecord[key])
  )
}
const match = (actual: unknown, expected: unknown): boolean => {
  if (expected === null || typeof expected !== 'object') return equal(actual, expected)
  if (actual === null || typeof actual !== 'object') return false
  return Object.entries(expected).every(([key, value]) =>
    match((actual as Record<string, unknown>)[key], value)
  )
}
const expectValue = (actual: unknown) => ({
  toBe: (expected: unknown) =>
    assert(equal(actual, expected), `expected ${String(actual)} to be ${String(expected)}`),
  toEqual: (expected: unknown) => assert(equal(actual, expected), 'values were not equal'),
  toMatchObject: (expected: unknown) =>
    assert(match(actual, expected), 'value did not match expected object'),
  toBeDefined: () => assert(actual !== undefined, 'value was undefined'),
  toBeUndefined: () => assert(actual === undefined, 'value was defined'),
  toHaveLength: (length: number) =>
    assert((actual as { length: number }).length === length, 'unexpected length'),
  rejects: {
    toThrow: async () => {
      try {
        await (actual as Promise<unknown>)
      } catch {
        return
      }
      throw new Error('expected promise to reject')
    },
  },
})

/**
 * Run the framework-free vector-store conformance suite against a consumer implementation.
 *
 * Each check creates a fresh store through `makeStore`; the returned promise rejects when any
 * contract assertion fails. Consumers can await this function from any test runner without
 * importing a test framework from the conformance module.
 *
 * @param label - Human-readable name used to identify the implementation under test.
 * @param makeStore - Factory returning a fresh, connected store with the `docs` collection.
 * @param dim - Vector dimensionality used by the suite (defaults to 3).
 * @param opts - Retry count and per-attempt timeout in milliseconds for eventually consistent stores.
 */
export const runVectorStoreConformance = async (
  label: string,
  makeStore: () => Promise<CallableVectorStore>,
  dim = 3,
  opts: { retry?: number; timeout?: number } = {}
): Promise<void> => {
  const p = (v: number[]): number[] => padVector(v, dim)
  const pending: Array<() => Promise<void>> = []
  const retry = opts.retry ?? 0
  const timeout = opts.timeout ?? 5000
  const runCase = async (test: () => Promise<void>): Promise<void> => {
    let last: unknown
    for (let attempt = 0; attempt <= retry; attempt++) {
      let timedOut = false
      const operation = Promise.resolve().then(test)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`conformance check timed out after ${timeout}ms`))
        }, timeout)
      })
      try {
        await Promise.race([operation, deadline])
        return
      } catch (error) {
        // A timeout cannot cancel an arbitrary backend operation. Drain it before retrying so a
        // late write/read from this attempt cannot race the fresh store made by the next attempt.
        if (timedOut) {
          last = error
          break
        }
        last = error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    throw last
  }
  const it = (_name: string, _io: unknown, test: () => Promise<void>) => {
    pending.push(() => runCase(test))
  }
  const describe = (_name: string, suite: () => void) => suite()
  const expect = expectValue
  const io = undefined
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
  for (const fn of pending) {
    await fn()
  }
}
