import { describe, expect, it } from 'vitest'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { InMemoryVectorStore } from '../../../../src/batteries/vector/in_memory'
import { VectorSchemaBuilder, CollectionBuilder } from '../../../../src/batteries/vector/schema'
import {
  validateRecords,
  validateCreateConfig,
  baseVectorStoreOptionsSchema,
} from '../../../../src/batteries/vector/validation'

describe('schema_validation_factory', () => {
  describe('schema builder', () => {
    const calls: any[] = []
    const executor = {
      createCollection: async (spec: any, ifNot: any) => {
        calls.push(['create', spec, ifNot])
      },
      dropCollection: async (c: any, ifEx: any) => {
        calls.push(['drop', c, ifEx])
      },
      hasCollection: async () => true,
      renameCollection: async () => {},
    }

    it('createCollection collects a CollectionSpec (vector dims+metric default cosine, fields with index()/nullable())', async () => {
      const sb = new VectorSchemaBuilder(executor)
      await sb.createCollection('docs', (c) => {
        c.vector({ dimensions: 3, metric: 'cosine' })
        c.string('kind').index()
        c.integer('year').nullable()
      })
      const spec = calls[0][1]
      expect(spec.vector.dimensions).toBe(3)
      expect(spec.vector.metric).toBe('cosine')
      expect(spec.fields[0].name).toBe('kind')
      expect(spec.fields[0].index).toBe(true)
      expect(spec.fields[1].name).toBe('year')
      expect(spec.fields[1].nullable).toBe(true)
    })

    it('build() throws if vector() never called', () => {
      const cb = new CollectionBuilder()
      cb.string('x')
      expect(() => cb.build('c')).toThrow()
    })

    it('dropCollectionIfExists passes ifExists=true', async () => {
      const sb = new VectorSchemaBuilder(executor)
      await sb.dropCollectionIfExists('test')
      expect(calls[calls.length - 1]).toEqual(['drop', 'test', true])
    })
  })

  describe('validation', () => {
    it('validateRecords rejects NaN vector (reports index)', () => {
      expect(() => validateRecords([{ id: 'a', vector: [Number.NaN] }])).toThrow()
    })

    it('validateRecords rejects missing id', () => {
      expect(() => validateRecords([{ vector: [0.5] } as any])).toThrow()
    })

    it('validateCreateConfig rejects non-function client', () => {
      expect(() => validateCreateConfig({ client: 'no', options: {} } as any)).toThrow()
    })

    it('baseVectorStoreOptionsSchema rejects encoder that is a string', () => {
      const { error } = baseVectorStoreOptionsSchema.validate(
        { encoder: 'bad' },
        { abortEarly: false, convert: false }
      )
      expect(error).toBeDefined()
    })

    it('baseVectorStoreOptionsSchema rejects bad metric', () => {
      const { error } = baseVectorStoreOptionsSchema.validate(
        { metric: 'invalid' },
        { abortEarly: false, convert: false }
      )
      expect(error).toBeDefined()
    })
  })

  describe('factory', () => {
    it('createVectorStore returns a callable (client = class)', async () => {
      const store = await createVectorStore({ client: InMemoryVectorStore, options: {} })
      expect(typeof store).toBe('function')
    })

    it('createVectorStore accepts a sync resolver (() => Class)', async () => {
      const store = await createVectorStore({ client: () => InMemoryVectorStore, options: {} })
      expect(typeof store).toBe('function')
      expect(store('docs').select).toBeDefined()
    })

    it('createVectorStore accepts an async resolver (() => Promise<Class>)', async () => {
      const store = await createVectorStore({
        client: async () => InMemoryVectorStore,
        options: {},
      })
      expect(typeof store).toBe('function')
    })

    it('createVectorStore accepts a resolver returning a module namespace ({ default })', async () => {
      const store = await createVectorStore({
        client: async () => ({ default: InMemoryVectorStore }),
        options: {},
      })
      expect(typeof store).toBe('function')
    })

    it('calling vs(x) returns a builder-like object (has .select method / is truthy)', async () => {
      const store = await createVectorStore({ client: InMemoryVectorStore, options: {} })
      const builder = store('docs')
      expect(builder).toBeTruthy()
      expect(builder.select).toBeDefined()
    })

    it('bad config (client not a function) rejects', async () => {
      await expect(createVectorStore({ client: 'no', options: {} } as any)).rejects.toThrow()
    })

    it('client that does not (resolve to) a BaseVectorStore subclass rejects', async () => {
      // A constructor that is a function but NOT a BaseVectorStore subclass — rejected.
      class NotAStore {
        constructor(_opts: unknown) {}
      }
      await expect(createVectorStore({ client: NotAStore as any, options: {} })).rejects.toThrow(
        /BaseVectorStore/
      )
      // A resolver that hands back a non-store is rejected too.
      await expect(
        createVectorStore({ client: () => NotAStore as any, options: {} })
      ).rejects.toThrow(/BaseVectorStore/)
    })
  })
})
