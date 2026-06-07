import { describe, expect, it } from 'vitest'
import { stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import { OramaVectorStore } from '../../../../src/batteries/vector/orama'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { PineconeVectorStore } from '../../../../src/batteries/vector/pinecone'
import { InMemoryVectorStore } from '../../../../src/batteries/vector/in_memory'
import { baseVectorStoreOptionsSchema } from '../../../../src/batteries/vector/validation'

// The consistency option is a UNIVERSAL, swap-safe capability: every adapter declares its
// read-after-write story so a caller can branch before designing around it. Strongly-consistent
// backends declare it non-configurable (the option is a no-op); eventually-consistent backends
// (Pinecone today; ES/OpenSearch, Mongo Atlas, multi-node Weaviate later) declare it configurable.

describe('capabilities.consistency', () => {
  it('strongly-consistent adapters declare a non-configurable strong default', () => {
    const mem = new InMemoryVectorStore({ dimensions: 3, encoder: stubEncoder })
    const orama = new OramaVectorStore({ dimensions: 3, encoder: stubEncoder })
    for (const vs of [mem, orama]) {
      expect(vs.capabilities.consistency.configurable).toBe(false)
      expect(vs.capabilities.consistency.default).toBe('strong')
      expect(vs.capabilities.consistency.modes).toEqual(['strong'])
    }
  })

  it('Pinecone declares consistency configurable with a strong default and all three modes', async () => {
    const pc = await createVectorStore({
      client: PineconeVectorStore,
      options: { apiKey: 'test-key', index: 'test-index', dimensions: 3, encoder: stubEncoder },
    })
    expect(pc.capabilities.consistency.configurable).toBe(true)
    expect(pc.capabilities.consistency.default).toBe('strong')
    expect(pc.capabilities.consistency.modes).toEqual(['strong', 'best-effort', 'eventual'])
  })

  it('the options schema accepts the three valid consistency modes', () => {
    for (const mode of ['strong', 'best-effort', 'eventual']) {
      const { error } = baseVectorStoreOptionsSchema.validate(
        { dimensions: 3, consistency: mode },
        { abortEarly: false, convert: false }
      )
      expect(error).toBeUndefined()
    }
  })

  it('the options schema rejects an invalid consistency mode', () => {
    const { error } = baseVectorStoreOptionsSchema.validate(
      { dimensions: 3, consistency: 'nonsense' },
      { abortEarly: false, convert: false }
    )
    expect(error).toBeDefined()
  })
})
