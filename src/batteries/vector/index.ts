/**
 * @module @nhtio/adk/batteries/vector
 */

export * from './types'
export * from './plan'
export * from './filters'
export * from './helpers'
export * from './exceptions'
export * from './builder'
export * from './schema'
export * from './migrate'
export * from './contract'
export * from './vector_store_constructor'
export * from './validation'
export * from './factory'
export * from './retrievable_glue'

// Environment-neutral adapters (cross-env): the in-memory reference and Orama
// (browser-capable). Node-only DB-driver adapters (qdrant, pgvector, chroma,
// weaviate, milvus, pinecone, sqlite_vec) are NOT re-exported here — deep-import
// them from their own subpath so their driver is only pulled in on demand.
export * from './in_memory'
export * from './orama'
