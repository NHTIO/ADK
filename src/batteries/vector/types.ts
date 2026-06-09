/**
 * Type definitions for the vector storage provider battery.
 *
 * @module @nhtio/adk/batteries/vector/types
 *
 * @remarks
 * This module owns the shared types and interfaces used by all vector storage adapters.
 * It defines the core abstractions for vectors, metadata, search results, and adapter
 * capabilities without any runtime logic or driver dependencies.
 */

/** Metric used to compare vectors during similarity search. */
export type DistanceMetric = 'cosine' | 'dot' | 'euclidean'

/** A metadata value may be a primitive, null, or a nested object/array of such values. */
export type VectorMetadataValue =
  | string
  | number
  | boolean
  | null
  | VectorMetadataValue[]
  | { [k: string]: VectorMetadataValue }

/** A flat or nested object mapping metadata keys to values. */
export type VectorMetadata = Record<string, VectorMetadataValue>

/** A stored vector record. All fields are optional; at minimum, an id is required. */
export interface VectorRecord {
  /** Unique record identifier within its collection. */
  id: string
  /** The embedding vector; omit to let the backend encode `document` server-side. */
  vector?: number[]
  /** The source document/text associated with the record. */
  document?: string
  /** Arbitrary metadata attached to the record. */
  metadata?: VectorMetadata
}

/** A result row from a vector search or filter scan. All fields are opt-in via .select(). */
export interface VectorMatch {
  /** The matched record's id (when projected). */
  id?: string
  /** Similarity score for the match (when applicable). */
  score?: number
  /** The record's metadata (when projected). */
  metadata?: VectorMetadata
  /** The record's document body (when projected). */
  document?: string
  /** The record's stored vector (when projected). */
  vector?: number[]
}

/** Input to the encoder: either a raw vector array or raw text to be embedded. */
export type VectorInput = number[] | { text: string }

/** Indicates whether text is being encoded as a query or as a document. */
export type EncodeKind = 'query' | 'document'

/** The BYO text-to-vector contract. Batch-shaped: one round-trip for many texts. */
export type VectorEncoderFn = (texts: string[], kind: EncodeKind) => Promise<number[][]>

/** Fixed per-adapter capability flags (static truth about a backend). */
/**
 * Read-after-write guarantee a write (`.upsert()` / `.delete()`) provides.
 *   'strong'      — the write Promise does not resolve until the change is confirmed
 *                   visible to subsequent reads. On timeout it THROWS
 *                   `E_VECTOR_STORE_CONSISTENCY_TIMEOUT` — never resolves unconfirmed.
 *   'best-effort' — poll up to the bound, then resolve whether or not visibility was
 *                   confirmed. The ONLY mode that may proceed unconfirmed, and only
 *                   because the caller asked for it. NOTE: on an eventually-consistent
 *                   backend a write-after-write race (e.g. deleting a just-upserted id
 *                   from a concurrent writer) may not take effect — this mode does not
 *                   detect it. Use 'strong' if you delete records you may have just written.
 *   'eventual'    — resolve on durable acknowledgement, with no visibility wait. Fastest;
 *                   inherits the same write-after-write race as 'best-effort', silently.
 */
export type VectorConsistency = 'strong' | 'best-effort' | 'eventual'

/**
 * How an adapter handles the {@link VectorConsistency} option.
 *   configurable:false → the backend is already strongly consistent (pgvector, sqlite-vec,
 *     in-memory, orama, …); the option is a no-op and `default` is always 'strong'.
 *   configurable:true  → an eventually-consistent backend (Pinecone today; ElasticSearch /
 *     OpenSearch, Mongo Atlas Vector Search, multi-node Weaviate later) that honors the
 *     option. `default` is what applies when neither a per-operation `.consistency()` nor a
 *     store-level `consistency` option is set; `modes` enumerates what it accepts.
 */
export interface VectorConsistencyCapability {
  /** Whether the backend honours a caller-supplied {@link VectorConsistency} (else it is a no-op). */
  configurable: boolean
  /** The consistency mode applied when neither a per-op nor store-level mode is set. */
  default: VectorConsistency
  /** The consistency modes the backend accepts. */
  modes: VectorConsistency[]
}

/** Fixed per-adapter capability flags — static truth about what a backend supports. */
export interface VectorStoreCapabilities {
  /** Multi-op ACID transactions (pgvector, sqlite-vec only). */
  transactions: boolean
  /** Multi-vector collections (Qdrant, Weaviate). */
  namedVectors: boolean
  /** Whether `renameCollection` is supported. */
  rename: boolean
  /** Whether `.whereRaw()` accepts a SQL string plus bindings. */
  rawSql: boolean
  /** Whether the backend embeds text server-side (Pinecone, Weaviate). */
  builtInEncoding: boolean
  /** The backend's read-after-write story and configurable default. */
  consistency: VectorConsistencyCapability
}

/** Shared base options every adapter extends with its own connection block. */
export interface BaseVectorStoreOptions {
  /** Distance metric used for similarity (e.g. cosine, euclidean, dot). Defaults to the adapter's preferred metric. */
  metric?: DistanceMetric
  /** Function that turns text into vectors. Required unless the backend has built-in encoding. */
  encoder?: VectorEncoderFn
  /** Embedding dimensionality. Required by backends that must declare it at collection-creation time. */
  dimensions?: number
  /** Collection name used when a call omits an explicit one. */
  defaultCollection?: string
  /**
   * Store-wide read-after-write guarantee for writes. Overrides the adapter's declared
   * {@link VectorStoreCapabilities.consistency} default; a per-operation `.consistency()`
   * on the builder overrides this in turn (precedence: per-op > store option > adapter
   * default). Ignored by strongly-consistent adapters. See {@link VectorConsistency}.
   */
  consistency?: VectorConsistency
}

/** Options for ensuring a collection exists. */
export interface EnsureCollectionOptions {
  /** Name of the collection to ensure. */
  collection: string
  /** Embedding dimensionality of the collection's vector column. */
  dimensions: number
  /** Distance metric for the collection (defaults to the adapter's preferred metric). */
  metric?: DistanceMetric
  /** When `true`, ensuring an existing collection is a no-op rather than an error. */
  ifNotExists?: boolean
}
