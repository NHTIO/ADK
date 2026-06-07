import { describe, it, expect } from 'vitest'
import { Retrievable } from '../../../../src/index'
import { stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { InMemoryVectorStore } from '../../../../src/batteries/vector/in_memory'
import { createVectorRetrievableCallbacks } from '../../../../src/batteries/vector/retrievable_glue'

const makeGlue = async () => {
  const store = await createVectorStore({
    client: InMemoryVectorStore,
    options: { metric: 'cosine', encoder: stubEncoder, dimensions: 3 },
  })
  await store.connect()
  await store.schema.createCollection('kb', (c) => c.vector({ dimensions: 3 }))
  const cb = createVectorRetrievableCallbacks({
    store,
    collection: 'kb',
    trustTier: 'first-party',
    topK: 3,
  })
  return { store, cb }
}

// minimal stub TurnContext exposing fetchMessages
const ctxWith = (userText?: string) =>
  ({
    fetchMessages: async () =>
      userText ? [{ role: 'user', content: { toString: () => userText } }] : [],
  }) as any

describe('vector retrievable glue', () => {
  it('exposes the 4 callbacks', async () => {
    const { cb } = await makeGlue()
    expect(typeof cb.fetchRetrievablesCallback).toBe('function')
    expect(typeof cb.storeRetrievableCallback).toBe('function')
    expect(typeof cb.mutateRetrievableCallback).toBe('function')
    expect(typeof cb.deleteRetrievableCallback).toBe('function')
  })
  it('store -> fetch maps to Retrievable with declared trustTier', async () => {
    const { cb } = await makeGlue()
    const r = new Retrievable({
      id: 'r1',
      content: 'cat facts',
      trustTier: 'first-party',
      source: '/kb/cats',
      kind: 'reference',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await cb.storeRetrievableCallback({} as any, r)
    const got = await cb.fetchRetrievablesCallback(ctxWith('cat'))
    expect(got.length).toBeGreaterThanOrEqual(1)
    expect(got[0]).toBeInstanceOf(Retrievable)
    expect(got[0].trustTier).toBe('first-party')
    expect(got[0].id).toBe('r1')
  })
  it('returns [] when there is no user message', async () => {
    const { cb } = await makeGlue()
    const got = await cb.fetchRetrievablesCallback(ctxWith(undefined))
    expect(got).toEqual([])
  })
  it('delete removes the row', async () => {
    const { cb } = await makeGlue()
    const r = new Retrievable({
      id: 'r1',
      content: 'cat',
      trustTier: 'first-party',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await cb.storeRetrievableCallback({} as any, r)
    await cb.deleteRetrievableCallback({} as any, 'r1')
    const got = await cb.fetchRetrievablesCallback(ctxWith('cat'))
    expect(got.length).toBe(0)
  })
})
