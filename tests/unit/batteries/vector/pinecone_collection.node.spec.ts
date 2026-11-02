import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E_VECTOR_STORE_COLLECTION_FAILED } from '../../../../src/batteries/vector/exceptions'
import {
  PineconeVectorStore,
  type PineconeVectorStoreOptions,
} from '../../../../src/batteries/vector/pinecone'

const fake = vi.hoisted(() => ({
  describeIndex: vi.fn(),
  describeIndexStats: vi.fn(),
  namespace: vi.fn(),
  listPaginated: vi.fn(),
  deleteNamespace: vi.fn(),
  deleteMany: vi.fn(),
  fetch: vi.fn(),
  upsert: vi.fn(),
  listNamespaces: vi.fn(),
  describeNamespace: vi.fn(),
}))

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: class {
    index() {
      return fake
    }
    describeIndex(name: string) {
      return fake.describeIndex(name)
    }
  },
}))

const makeStore = () =>
  new PineconeVectorStore({
    apiKey: 'test-key',
    index: 'test-index',
    namespacePrefix: 'test',
    dimensions: 3,
  } as PineconeVectorStoreOptions)

// describeIndexStats defaults to the namespace being present, so hasCollection() guards pass.
// The deployment type decides the drop path, so every case sets it explicitly.
const serverlessIndex = () =>
  fake.describeIndex.mockResolvedValue({ spec: { serverless: { cloud: 'aws', region: 'us' } } })
const podIndex = () =>
  fake.describeIndex.mockResolvedValue({ spec: { pod: { environment: 'us', podType: 'p1' } } })
const undescribableIndex = () => fake.describeIndex.mockRejectedValue(new Error('describe failed'))

// Namespace-API responses (SDK 7.2.0: describeNamespace / paginated listNamespaces), which the
// serverless existence checks use instead of describeIndexStats(). Defaults mirror a PRESENT
// namespace. `beforeEach` recreates both fns so tests that remove or break them cannot leak
// that state into later tests.
const presentNamespace = () => {
  fake.describeNamespace.mockResolvedValue({ name: 'test__docs', recordCount: 1 })
  fake.listNamespaces
    .mockResolvedValueOnce({ namespaces: [{ name: 'other' }], pagination: { next: 'p2' } })
    .mockResolvedValue({ namespaces: [{ name: 'test__docs', recordCount: 1 }] })
}
const absentNamespace = () => {
  // Skippable when a test removed the SDK method to exercise a fallback path.
  if (typeof fake.describeNamespace === 'function') {
    fake.describeNamespace.mockRejectedValue({ name: 'PineconeNotFoundError' })
  }
  if (typeof fake.listNamespaces === 'function') {
    fake.listNamespaces.mockResolvedValue({ namespaces: [{ name: 'other' }] })
  }
}

// Model the serverless semantics the settle loop relies on: deleting the namespace removes it
// from the index stats the settle poll reads AND from the namespace enumeration the strong-mode
// confirm uses. Tests that need the SETTLE to fail override this implementation and keep the
// namespace listed.
const deleteNamespaceRemovesNamespace = () => {
  fake.deleteNamespace.mockImplementation(async (name: string) => {
    const stats = (await fake.describeIndexStats()) as
      | { namespaces?: Record<string, unknown> }
      | undefined
    if (stats?.namespaces) delete stats.namespaces[name]
    absentNamespace()
  })
}

describe('PineconeVectorStore.dropCollection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fake.describeIndexStats.mockResolvedValue({ namespaces: { test__docs: { vectorCount: 1 } } })
    fake.namespace.mockReturnValue(fake)
    fake.listPaginated
      .mockResolvedValueOnce({ vectors: [{ id: 'a' }], pagination: { next: 'page-2' } })
      .mockResolvedValueOnce({ vectors: [{ id: 'b' }] })
      .mockResolvedValue({ vectors: [] })
    fake.fetch.mockResolvedValue({ records: {} })
    fake.describeIndex.mockResolvedValue({ spec: { serverless: {} } })
    fake.describeNamespace = vi.fn()
    fake.listNamespaces = vi.fn()
    presentNamespace()
    deleteNamespaceRemovesNamespace()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops a serverless namespace outright: deleteNamespace only, no vector sweep', async () => {
    await makeStore().dropCollection('docs', true)
    // deleteNamespace removes the namespace and all of its records, so listPaginated/deleteMany
    // must not run at all on the serverless drop path.
    expect(fake.listPaginated).not.toHaveBeenCalled()
    expect(fake.deleteMany).not.toHaveBeenCalled()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    // The deployment type is resolved exactly once (hasCollection resolves it, the drop reuses
    // the cache).
    expect(fake.describeIndex).toHaveBeenCalledExactlyOnceWith('test-index')
  })

  it('resolves the deployment type once and caches it on the store instance', async () => {
    const store = makeStore()
    await store.dropCollection('docs', true)
    await store.dropCollection('docs', false).catch(() => undefined)
    expect(fake.describeIndex).toHaveBeenCalledExactlyOnceWith('test-index')
  })

  it('drops a pod-based namespace vectors-only, without deleteNamespace and without throwing', async () => {
    podIndex()
    await makeStore().dropCollection('docs', true)
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
    expect(fake.deleteMany).toHaveBeenCalledWith({ ids: ['a', 'b'] })
    expect(fake.fetch).toHaveBeenCalledWith({ ids: ['a', 'b'] })
  })

  it.each([
    { name: 'PineconeNotImplementedError', message: '' },
    {
      name: 'PineconeBadRequestError',
      message: 'Namespace operations are not supported for pod-based indexes',
    },
  ])(
    'unknown type: a "not supported" deleteNamespace probe (%s) falls back to the vectors-only drop',
    async (shape) => {
      undescribableIndex()
      // Both rows must be the STRUCTURED signals finding C kept: the SDK's 501 mapping, or a
      // 400-class error carrying Pinecone's exact pod wording (SDK maps a 400 message-bearing
      // response to PineconeBadRequestError). Free-text matching was removed.
      fake.deleteNamespace.mockRejectedValue(
        Object.assign(new Error(shape.message), { status: 501, name: shape.name })
      )
      await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
      expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
      expect(fake.deleteMany).toHaveBeenCalledWith({ ids: ['a', 'b'] })
      expect(fake.fetch).toHaveBeenCalledWith({ ids: ['a', 'b'] })
    }
  )

  it('propagates non-"not supported" errors from an unknown-type deleteNamespace probe', async () => {
    undescribableIndex()
    fake.deleteNamespace.mockRejectedValue(new Error('permission denied'))
    const promise = makeStore().dropCollection('docs', true)
    await expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
    await expect(promise).rejects.toThrow(/permission denied/)
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it.each([{ status: 404 }, { statusCode: 404 }, { name: 'PineconeNotFoundError' }])(
    'tolerates a structured already-deleted namespace: %j',
    async (error) => {
      // The namespace disappears anyway (deleted concurrently), but the deletion call itself
      // still races a structured 404 — which must be tolerated, not thrown. BOTH absence
      // sources must flip: the stats read and the namespace enumeration the strong settle
      // consults.
      fake.deleteNamespace.mockImplementationOnce(async () => {
        fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
        absentNamespace()
        throw error
      })
      await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
      expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    }
  )

  it.each([new Error('Namespace not found'), new Error('HTTP 404 — sweep failed')])(
    'propagates free-text absence-looking errors: %s',
    async (error) => {
      serverlessIndex()
      fake.deleteNamespace.mockRejectedValue(error)
      const promise = makeStore().dropCollection('docs', true)
      await expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
      await expect(promise).rejects.toThrow(error.message)
      expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    }
  )

  it('maps a structured 404 from deleteMany on the pod sweep to a collection failure for BOTH ifExists values', async () => {
    // Finding A: the outer catch no longer tolerates absence-looking errors from the sweep,
    // so an ifExists drop must NOT silently succeed when the delete 404s mid-sweep.
    podIndex()
    fake.listPaginated.mockReset().mockResolvedValue({ vectors: [{ id: 'a' }] })
    fake.deleteMany.mockRejectedValue({ name: 'PineconeNotFoundError' })
    await expect(makeStore().dropCollection('docs', true)).rejects.toThrow(
      E_VECTOR_STORE_COLLECTION_FAILED
    )
    await expect(makeStore().dropCollection('docs', false)).rejects.toThrow(
      E_VECTOR_STORE_COLLECTION_FAILED
    )
  })

  it('surfaces a settle timeout on serverless AFTER deleteNamespace reclaimed the namespace', async () => {
    vi.useFakeTimers()
    // Keep the namespace LISTED by the namespace API (and stats) so the settle loop can only
    // time out, and make deleteNamespace inert so removal stays impossible.
    fake.deleteNamespace.mockReset()
    fake.deleteNamespace.mockResolvedValue(undefined)
    const dropPromise = makeStore().dropCollection('docs', true)
    const assertion = expect(dropPromise).rejects.toThrow(/Strong consistency could not be/)
    // The 10s #waitVisible deadline must be reachable — i.e. the timeout surfaces from the
    // settle AFTER the namespace deletion, not instead of it.
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    // The sweep must not run on the serverless path.
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it('maps deleteNamespace failures to collection failures', async () => {
    fake.deleteNamespace.mockRejectedValue(new Error('permission denied'))
    const promise = makeStore().dropCollection('docs', true)
    await expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
    await expect(promise).rejects.toThrow(/permission denied/)
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
  })

  it.each([true, false])('keeps missing-collection behavior with ifExists=%s', async (ifExists) => {
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    absentNamespace()
    await expect(makeStore().dropCollection('docs', ifExists)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
  })

  it('allows a deleted collection to be recreated and reused with new dimensions', async () => {
    const store = makeStore()
    await store.createCollection(
      { collection: 'docs', fields: [], vector: { dimensions: 3, metric: 'cosine' } },
      false
    )
    fake.deleteNamespace.mockImplementation(async () => {
      fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
      absentNamespace()
    })
    await store.dropCollection('docs', true)
    await expect(store.hasCollection('docs')).resolves.toBe(false)
    await store.createCollection(
      { collection: 'docs', fields: [], vector: { dimensions: 2, metric: 'cosine' } },
      false
    )
    await store.executeUpsert({
      collection: 'docs',
      records: [{ id: 'new', vector: [1, 0] }],
      consistency: 'eventual',
    })
    expect(fake.namespace).toHaveBeenLastCalledWith('test__docs')
    expect(fake.upsert).toHaveBeenCalledWith({
      records: [{ id: 'new', values: [1, 0], metadata: { __document: '' } }],
    })
    fake.describeIndexStats.mockResolvedValue({ namespaces: { test__docs: { vectorCount: 1 } } })
    presentNamespace()
    await expect(store.hasCollection('docs')).resolves.toBe(true)
  })

  // ─── A: outer-catch 404 tolerance is too wide ─────────────────────────────

  it('propagates a structured 404 from listPaginated during a pod sweep instead of reporting success', async () => {
    podIndex()
    fake.listPaginated.mockReset().mockRejectedValue(
      Object.assign(new Error('A call to /indexes/test-index returned HTTP status 404.'), {
        name: 'PineconeNotFoundError',
      })
    )
    const store = makeStore()
    await store.createCollection(
      { collection: 'docs', fields: [], vector: { dimensions: 3, metric: 'cosine' } },
      false
    )
    await expect(store.dropCollection('docs', true)).rejects.toThrow(
      E_VECTOR_STORE_COLLECTION_FAILED
    )
    // The failed drop must leave the dims cache intact: the collection keeps its ORIGINAL
    // dimension, so re-creating it with different dimensions still conflicts.
    await expect(
      store.createCollection(
        { collection: 'docs', fields: [], vector: { dimensions: 5, metric: 'cosine' } },
        false
      )
    ).rejects.toThrow(/already exists with dimension 3/)
  })

  it('propagates a structured 404 from describeIndex instead of probing deleteNamespace on the unknown path', async () => {
    vi.useFakeTimers()
    fake.describeIndex.mockRejectedValue(
      Object.assign(new Error('describeIndex 404'), { name: 'PineconeNotFoundError' })
    )
    const promise = makeStore().dropCollection('docs', true)
    const assertion = expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
    // On the FIXED code the describe 404 rejects immediately; on the OLD code the store
    // first probed deleteNamespace and settled — advancing the fake clock keeps that
    // wrong path cheap while it fails verification.
    await vi.advanceTimersByTimeAsync(11_000)
    await assertion
    // The 404 must surface from the describe itself — never reinterpreted as the
    // "namespace ops unsupported" fallback that silently keeps the vectors-only drop.
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  // ─── B: an empty serverless namespace skips deletion (ifExists pre-gate) ──

  it('serverless: calls deleteNamespace even when describeIndexStats omits the namespace (describeNamespace)', async () => {
    serverlessIndex()
    // Stats DO NOT list the namespace (an existing-but-empty namespace is invisible to stats)
    // — only the namespace API knows it exists. The drop must still reclaim it.
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    presentNamespace()
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it('serverless: falls back to paginated listNamespaces when the SDK has no describeNamespace', async () => {
    serverlessIndex()
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    presentNamespace()
    // Simulate an SDK build without describeNamespace: the paginated listNamespaces fallback
    // must decide existence instead. The namespace appears only on a LATER page.
    fake.describeNamespace = undefined as never
    fake.listNamespaces
      .mockReset()
      .mockResolvedValueOnce({ namespaces: [{ name: 'n1' }], pagination: { next: 'p2' } })
      .mockResolvedValueOnce({ namespaces: [{ name: 'n2' }], pagination: { next: 'p3' } })
      .mockResolvedValue({ namespaces: [{ name: 'test__docs', recordCount: 0 }] })
    fake.deleteNamespace.mockReset()
    fake.deleteNamespace.mockImplementation(async () => {
      fake.listNamespaces.mockReset().mockResolvedValue({ namespaces: [] })
    })
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it('serverless: hasCollection itself reports a stats-invisible namespace as present', async () => {
    serverlessIndex()
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    presentNamespace()
    await expect(makeStore().hasCollection('docs')).resolves.toBe(true)
  })

  it('pod: hasCollection keeps using describeIndexStats (no namespace API on pod)', async () => {
    podIndex()
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    presentNamespace()
    // Pod indexes expose neither describeNamespace nor listNamespaces; the stats read decides,
    // and the enumeration APIs must never be consulted for it.
    fake.describeNamespace = undefined as never
    fake.listNamespaces = undefined as never
    await expect(makeStore().hasCollection('docs')).resolves.toBe(false)
  })

  // ─── C: free-text "unsupported" can permanently classify serverless as pod ──

  it('does NOT treat an unrelated 500 "not supported" message as the pod fallback', async () => {
    undescribableIndex()
    fake.deleteNamespace.mockRejectedValue(new Error('feature not supported on your current plan'))
    const promise = makeStore().dropCollection('docs', true)
    await expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
    await expect(promise).rejects.toThrow(/not supported on your current plan/)
    // The error must propagate as a failure — no vectors-only sweep, no pod caching.
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it('does NOT treat a non-400 error even WITH the exact pod wording as the pod fallback', async () => {
    undescribableIndex()
    fake.deleteNamespace.mockRejectedValue(
      Object.assign(new Error('Namespace operations are not supported for pod-based indexes'), {
        status: 500,
      })
    )
    await expect(makeStore().dropCollection('docs', true)).rejects.toThrow(
      E_VECTOR_STORE_COLLECTION_FAILED
    )
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'raw status 400', shape: { status: 400, name: 'Error' } },
    {
      label: 'PineconeBadRequestError (SDK maps 400)',
      shape: { name: 'PineconeBadRequestError' },
    },
  ])(
    'still falls back on a 400 carrying Pinecone\u2019s exact pod wording: $label',
    async ({ shape }) => {
      undescribableIndex()
      fake.deleteNamespace.mockRejectedValue(
        Object.assign(
          new Error('Namespace operations are not supported for pod-based indexes'),
          shape
        )
      )
      await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
      expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
      expect(fake.deleteMany).toHaveBeenCalledWith({ ids: ['a', 'b'] })
    }
  )

  it('does NOT cache "pod" from an inferred fallback: a later drop re-probes and reclaims', async () => {
    undescribableIndex()
    // First drop: the probe reports "not supported" → inferred pod fallback sweep.
    fake.deleteNamespace.mockRejectedValueOnce(
      Object.assign(new Error('Namespace operations are not supported for pod-based indexes'), {
        status: 400,
      })
    )
    const store = makeStore()
    await expect(store.dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteMany).toHaveBeenCalledTimes(1)
    // The index is ACTUALLY serverless. Drop again on the SAME store instance: the
    // deleteNamespace probe must re-run (not be short-circuited by a cached 'pod'),
    // succeed, and reclaim the namespace — proving the inference was NOT cached.
    fake.deleteNamespace.mockImplementation(async (name: string) => {
      const stats = (await fake.describeIndexStats()) as
        | { namespaces?: Record<string, unknown> }
        | undefined
      if (stats?.namespaces) delete stats.namespaces[name]
      absentNamespace()
    })
    await expect(store.dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledTimes(2)
    expect(fake.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('keeps caching describeIndex-reported pod classifications across drops', async () => {
    podIndex()
    const store = makeStore()
    await store.dropCollection('docs', true)
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
    // Second drop on the same instance must STILL skip the probe: the describeIndex-derived
    // 'pod' classification is legitimately cached.
    fake.listPaginated.mockReset().mockResolvedValue({ vectors: [] })
    await store.dropCollection('docs', true)
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
    expect(fake.describeIndex).toHaveBeenCalledTimes(1)
  })

  // ─── D: strong-consistency settle trusts a missing stats entry ────────────

  it('strong settle confirms namespace absence via enumeration even when stats still list it', async () => {
    vi.useFakeTimers()
    serverlessIndex()
    // deleteNamespace succeeds, but the SETTLE's stats read keeps listing the namespace —
    // stats lag. The namespace API has already dropped it. Strong mode must confirm via
    // enumeration and succeed, not time out on the stale stats entry.
    fake.deleteNamespace.mockReset()
    fake.deleteNamespace.mockImplementation(async () => {
      // Stats stay stale: the namespace is never removed from them.
      absentNamespace()
    })
    const store = makeStore()
    const dropPromise = store.dropCollection('docs', true)
    await vi.advanceTimersByTimeAsync(10_500)
    await expect(dropPromise).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    // Strong mode confirmed via enumeration: stats were never consulted (hasCollection used
    // the namespace API, and the settle poll must too — a missing stats entry alone proves
    // nothing).
    expect(fake.describeIndexStats).not.toHaveBeenCalled()
  })

  it('strong settle still enforces the deadline when enumeration ALSO still lists the namespace', async () => {
    vi.useFakeTimers()
    serverlessIndex()
    // Neither stats nor the namespace API ever report the namespace gone: the ONLY
    // outcome is the 10s deadline, which must still be reachable in strong mode.
    fake.deleteNamespace.mockReset()
    fake.deleteNamespace.mockResolvedValue(undefined)
    const dropPromise = makeStore().dropCollection('docs', true)
    const assertion = expect(dropPromise).rejects.toThrow(/Strong consistency could not be/)
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
  })

  it('eventual settle does not probe namespace enumeration at all', async () => {
    vi.useFakeTimers()
    serverlessIndex()
    fake.deleteNamespace.mockReset()
    fake.deleteNamespace.mockResolvedValue(undefined)
    // describeNamespace fails if the settle ever probes it (it must not — eventual mode
    // settles immediately without confirmation).
    fake.describeNamespace = undefined as never
    const store = new PineconeVectorStore({
      apiKey: 'test-key',
      index: 'test-index',
      namespacePrefix: 'test',
      dimensions: 3,
      consistency: 'eventual',
    } as PineconeVectorStoreOptions)
    await expect(store.dropCollection('docs', true)).resolves.toBeUndefined()
  })

  // ─── Round 3 A: an inconclusive probe must not skip the serverless deletion ──

  it('serverless: an ERRORING namespace probe plus stats omitting the namespace still calls deleteNamespace', async () => {
    serverlessIndex()
    // The stats read says the namespace is gone/never existed (empty namespaces are invisible to
    // stats). The namespace probe FAILS for a non-404 reason, so it is inconclusive — NOT proof of
    // absence. Trusting stats here is exactly the empty-namespace leak: the drop must still attempt
    // deleteNamespace().
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    fake.describeNamespace.mockRejectedValue(new Error('control plane unavailable'))
    // After the deletion the probe recovers and reports absence, so the strong settle confirms
    // (this test is about the DELETION decision, not the settle).
    fake.deleteNamespace.mockImplementation(async () => {
      absentNamespace()
    })
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    expect(fake.deleteMany).not.toHaveBeenCalled()
    // The existence decision never consulted describeIndexStats on the serverless path.
    expect(fake.describeIndexStats).not.toHaveBeenCalled()
  })

  it('unknown index type: an inconclusive probe plus stats omitting the namespace still calls deleteNamespace', async () => {
    undescribableIndex()
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    // Neither namespace API answers: describeNamespace fails (non-404) and listNamespaces is not
    // available on this client — 'unknown', which must be read as "attempt the deletion".
    fake.describeNamespace.mockRejectedValue(new Error('probe exploded'))
    fake.listNamespaces = undefined as never
    fake.deleteNamespace.mockImplementation(async () => {
      absentNamespace()
      fake.describeNamespace.mockRejectedValue({ name: 'PineconeNotFoundError' })
    })
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  it('serverless: a definitive "absent" probe is a no-op — no deleteNamespace, no throw', async () => {
    serverlessIndex()
    // Structured 404 from the namespace API: the namespace really is gone, so the drop is a no-op
    // for BOTH `ifExists` values and must not spend a deleteNamespace() call (nor throw when the
    // stats read also omits it).
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    absentNamespace()
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    await expect(makeStore().dropCollection('docs', false)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).not.toHaveBeenCalled()
    expect(fake.deleteMany).not.toHaveBeenCalled()
  })

  // ─── Round 3 B: strong settle must not trust stats on an inconclusive probe ──

  it('strong settle keeps polling and times out when the probe ERRORS and stats omit the namespace', async () => {
    vi.useFakeTimers()
    serverlessIndex()
    // The probe exists but always fails (non-404) → 'unknown' = not yet confirmed. Stats DO omit
    // the namespace, which the old code accepted as proof of absence. Strong mode must instead
    // keep polling to the deadline and surface the consistency timeout.
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    fake.describeNamespace.mockRejectedValue(new Error('probe exploded'))
    fake.deleteNamespace.mockReset().mockResolvedValue(undefined)
    const dropPromise = makeStore().dropCollection('docs', true)
    const assertion = expect(dropPromise).rejects.toThrow(/Strong consistency could not be/)
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    // It really polled (rather than confirming once): several settle iterations ran.
    expect(fake.describeNamespace.mock.calls.length).toBeGreaterThan(1)
  })

  it('strong settle falls back to stats on a client with NO namespace API at all', async () => {
    serverlessIndex()
    // A BYO client exposing neither describeNamespace() nor listNamespaces(): there is no
    // enumeration to wait on, so the stats signal remains the fallback and the settle succeeds.
    fake.describeNamespace = undefined as never
    fake.listNamespaces = undefined as never
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    fake.deleteNamespace.mockReset().mockResolvedValue(undefined)
    await expect(makeStore().dropCollection('docs', true)).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    expect(fake.describeIndexStats).toHaveBeenCalled()
  })

  // ─── Round 4: a failed describeNamespace must still consult listNamespaces ──

  it('describeNamespace 500 + listNamespaces absent → probe settles absent and the drop resolves promptly', async () => {
    vi.useFakeTimers()
    serverlessIndex()
    // describeNamespace fails for a NON-404 reason, but listNamespaces works and does NOT list
    // the namespace. The old code returned 'unknown' straight from describe, so the strong settle
    // polled to the 10s deadline and timed out on a namespace that was already reclaimed. The
    // fixed code falls through to the listing, which settles 'absent' promptly.
    fake.describeIndexStats.mockResolvedValue({ namespaces: { test__docs: { vectorCount: 1 } } })
    // The pre-drop existence check still sees the namespace (describeNamespace answers once),
    // so deleteNamespace() runs; AFTER that describeNamespace starts failing with a 500 while the
    // paginated listing (which works) no longer shows the namespace.
    fake.describeNamespace
      .mockResolvedValueOnce({ name: 'test__docs', recordCount: 1 })
      .mockRejectedValue(Object.assign(new Error('describe exploded'), { status: 500 }))
    fake.listNamespaces.mockResolvedValue({ namespaces: [{ name: 'other' }] })
    fake.deleteNamespace.mockReset().mockResolvedValue(undefined)
    const dropPromise = makeStore().dropCollection('docs', true)
    // Only a single listing pass should be needed for the settle to confirm absence.
    await vi.advanceTimersByTimeAsync(700)
    await expect(dropPromise).resolves.toBeUndefined()
    expect(fake.deleteNamespace).toHaveBeenCalledExactlyOnceWith('test__docs')
    // The strong confirm used the namespace API, never the (possibly stale) stats.
    expect(fake.describeIndexStats).not.toHaveBeenCalled()
  })

  it('describeNamespace 500 + listNamespaces present → probe settles present and hasCollection reports true', async () => {
    serverlessIndex()
    // describe fails (non-404) but the paginated listing DOES show the namespace: the result is
    // definitive 'present', never the inconclusive 'unknown' the old code returned.
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    fake.describeNamespace.mockRejectedValue(
      Object.assign(new Error('describe exploded'), { status: 500 })
    )
    fake.listNamespaces
      .mockResolvedValueOnce({ namespaces: [{ name: 'n1' }], pagination: { next: 'p2' } })
      .mockResolvedValue({ namespaces: [{ name: 'test__docs', recordCount: 0 }] })
    await expect(makeStore().hasCollection('docs')).resolves.toBe(true)
  })

  // ─── Round 4: hasCollection on an UNKNOWN index type / inconclusive probes ──

  it('hasCollection: unknown index type + a definitive namespace probe wins over stats omission', async () => {
    undescribableIndex()
    // The control plane cannot classify the index, but the namespace API CAN answer definitively.
    // The old code only consulted the namespace API for a known-serverless index and fell back to
    // stats, which may omit an existing-but-EMPTY namespace — reporting a live collection as gone.
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    presentNamespace()
    await expect(makeStore().hasCollection('docs')).resolves.toBe(true)
    // The stats read was never needed.
    expect(fake.describeIndexStats).not.toHaveBeenCalled()
  })

  it('hasCollection: a namespace API that exists but ALWAYS errors throws instead of trusting stats', async () => {
    serverlessIndex()
    // Every enumeration probe fails (non-404) and stats omit the namespace. A stats omission is
    // NOT proof of absence for an existing-but-empty namespace, so the unreadable state is
    // surfaced as a collection failure (the same wrapping other reads use) rather than silently
    // reporting the collection gone. Only a BYO client with NO namespace API falls back to stats.
    fake.describeIndexStats.mockResolvedValue({ namespaces: {} })
    fake.describeNamespace.mockRejectedValue(new Error('describe exploded'))
    fake.listNamespaces.mockRejectedValue(new Error('list exploded'))
    const promise = makeStore().hasCollection('docs')
    await expect(promise).rejects.toThrow(E_VECTOR_STORE_COLLECTION_FAILED)
    // The surfaced error names the namespace and carries the underlying probe failures.
    await expect(promise).rejects.toThrow(/could not be determined/)
    await expect(promise).rejects.toThrow(/test__docs/)
    await expect(promise).rejects.toThrow(/describe exploded/)
    await expect(promise).rejects.toThrow(/list exploded/)
  })

  it('hasCollection: an explicit pod "not supported" probe error routes a misdescribed index back to stats', async () => {
    undescribableIndex()
    // The control plane could not classify the index, and the namespace API answers with Pinecone's
    // exact pod "not supported" wording on a 400: that PROVES the index is pod-based, where stats
    // is the correct (and only) signal — the failure is not surfaced, and stats decides.
    fake.describeIndexStats.mockResolvedValue({ namespaces: { test__docs: { vectorCount: 1 } } })
    fake.describeNamespace.mockRejectedValue(
      Object.assign(new Error('Namespace operations are not supported for pod-based indexes'), {
        status: 400,
      })
    )
    await expect(makeStore().hasCollection('docs')).resolves.toBe(true)
  })

  it('hasCollection: a BYO client with NO namespace API keeps the stats fallback', async () => {
    undescribableIndex()
    // Neither enumeration API exists on this client: stats is the only available signal and is
    // used (no throw), per the documented limitation for API-less BYO clients.
    fake.describeIndexStats.mockResolvedValue({ namespaces: { test__docs: { vectorCount: 1 } } })
    fake.describeNamespace = undefined as never
    fake.listNamespaces = undefined as never
    await expect(makeStore().hasCollection('docs')).resolves.toBe(true)
  })
})
