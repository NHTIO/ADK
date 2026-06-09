/**
 * @module @nhtio/adk/batteries/vector/s3vectors
 *
 * AWS S3 Vectors vector-store adapter. A vector BUCKET is provisioned out-of-band (the adapter
 * does NOT create the bucket); a logical collection = an **index** inside that bucket. The SDK is
 * command-based: create/delete/list indexes, PutVectors/QueryVectors/GetVectors/DeleteVectors.
 *
 * Scoring rule: QueryVectors returns `distance`. For cosine, distance = 1 - cosineSim; identical
 * vectors → 0. For euclidean, distance = L2 distance. Scores are derived from the returned
 * distance and normalized to [0,1].
 *
 * Metadata is NATIVE JSON (object). Store the document text under the reserved metadata key
 * `__document`; keep user metadata flat alongside. On read, pull `__document` out into
 * `match.document` and return the rest as `match.metadata`.
 *
 * Filtering: S3 Vectors supports a native filter (Mongo-ish), but for guaranteed cross-adapter
 * parity, **over-fetch and JS-filter** with `evaluateFilter`. When `plan.filter` is set, request
 * a larger `topK` (e.g. 500) without a native filter, then JS-filter, then slice.
 *
 * Eventual consistency: settle-poll after writes/deletes so the conformance suite — which writes
 * then immediately reads — passes deterministically.
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
} from '../exceptions'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type {
  VectorMatch,
  VectorStoreCapabilities,
  BaseVectorStoreOptions,
  VectorMetadata,
  DistanceMetric,
} from '../types'

const getS3Vectors = async (): Promise<{
  S3VectorsClient: any
  CreateIndexCommand: any
  DeleteIndexCommand: any
  ListIndexesCommand: any
  PutVectorsCommand: any
  QueryVectorsCommand: any
  GetVectorsCommand: any
  DeleteVectorsCommand: any
}> => {
  try {
    const mod = await import('@aws-sdk/client-s3vectors')
    return {
      S3VectorsClient: mod.S3VectorsClient,
      CreateIndexCommand: mod.CreateIndexCommand,
      DeleteIndexCommand: mod.DeleteIndexCommand,
      ListIndexesCommand: mod.ListIndexesCommand,
      PutVectorsCommand: mod.PutVectorsCommand,
      QueryVectorsCommand: mod.QueryVectorsCommand,
      GetVectorsCommand: mod.GetVectorsCommand,
      DeleteVectorsCommand: mod.DeleteVectorsCommand,
    }
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@aws-sdk/client-s3vectors'])
  }
}

export interface S3VectorsVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    bucket: string
    region?: string
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    indexPrefix?: string
  }
}

const mapMetricToS3 = (metric: DistanceMetric): string => {
  if (metric === 'cosine') return 'cosine'
  if (metric === 'euclidean') return 'euclidean'
  // dot is not supported by S3 Vectors
  throw new E_VECTOR_STORE_COLLECTION_FAILED([
    'createCollection',
    'Metric "dot" is not supported by AWS S3 Vectors; use "cosine" or "euclidean"',
  ])
}

// QueryVectors returns a `distance`; convert it to the battery's normalized [0,1] similarity
// score. For cosine, S3 Vectors distance = 1 - cosineSim, so sim = 1 - distance.
const scoreFromDistance = (distance: number, metric: DistanceMetric): number => {
  if (metric === 'cosine') {
    // cosine distance = 1 - sim, so sim = 1 - distance
    return normalizeScore(1 - distance, 'cosine', 'similarity')
  } else if (metric === 'euclidean') {
    return normalizeScore(distance, 'euclidean', 'distance')
  } else {
    // Fallback
    return normalizeScore(1 - distance, 'cosine', 'similarity')
  }
}

export class S3VectorsVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #dims: Map<string, number> = new Map()
  #metrics: Map<string, DistanceMetric> = new Map()

  get #opts(): S3VectorsVectorStoreOptions {
    return this.options as S3VectorsVectorStoreOptions
  }

  // Map a logical collection name to its physical S3 Vectors index name (with optional prefix).
  #index(collection: string): string {
    const prefix = this.#opts.connection.indexPrefix ?? ''
    return `${prefix}${collection}`
  }

  // Settle-poll: wait until the given keys are visible in QueryVectors (for upsert) or absent
  // (for delete), bounded ~10s with 300ms polls.
  async #settle(
    physicalIndex: string,
    opts: { present?: string[]; absent?: string[] }
  ): Promise<void> {
    const present = opts.present ?? []
    const absent = opts.absent ?? []
    if (present.length === 0 && absent.length === 0) return

    const deadline = Date.now() + 10_000
    const probeVec = new Array(this.#opts.dimensions ?? 3).fill(0).map((_, i) => (i === 0 ? 1 : 0))
    const bucket = this.#opts.connection.bucket

    while (true) {
      let presentOk = true
      let absentOk = true

      if (present.length > 0) {
        try {
          const qr = await this.#client!.send(
            new this.#cmd!.QueryVectorsCommand({
              vectorBucketName: bucket,
              indexName: physicalIndex,
              queryVector: { float32: probeVec },
              topK: Math.max(present.length + 5, 10),
              returnMetadata: false,
              returnDistance: false,
            })
          )
          const seen = new Set((qr.vectors ?? []).map((v: any) => v.key))
          presentOk = present.every((k) => seen.has(k))
        } catch {
          presentOk = false
        }
      }

      if (absent.length > 0) {
        try {
          const qr = await this.#client!.send(
            new this.#cmd!.QueryVectorsCommand({
              vectorBucketName: bucket,
              indexName: physicalIndex,
              queryVector: { float32: probeVec },
              topK: 100,
              returnMetadata: false,
              returnDistance: false,
            })
          )
          const seen = new Set((qr.vectors ?? []).map((v: any) => v.key))
          absentOk = absent.every((k) => !seen.has(k))
        } catch {
          absentOk = false
        }
      }

      if (presentOk && absentOk) return
      if (Date.now() >= deadline) return
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  #cmd?: {
    CreateIndexCommand: any
    DeleteIndexCommand: any
    ListIndexesCommand: any
    PutVectorsCommand: any
    QueryVectorsCommand: any
    GetVectorsCommand: any
    DeleteVectorsCommand: any
  }

  async connect(): Promise<void> {
    if (this.#client) return
    const { S3VectorsClient, ...cmd } = await getS3Vectors()
    this.#cmd = cmd
    const { region, credentials } = this.#opts.connection
    try {
      this.#client = new S3VectorsClient({ region, credentials })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.destroy?.()
      this.#client = null
      this.#cmd = undefined
    }
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const collection = spec.collection
    const physicalIndex = this.#index(collection)
    const dims = spec.vector.dimensions
    const metric = spec.vector.metric

    // Map metric (throws on dot)
    const s3Metric = mapMetricToS3(metric)

    this.#dims.set(collection, dims)
    this.#metrics.set(collection, metric)

    if (ifNotExists) {
      if (await this.hasCollection(collection)) return
    }

    try {
      await this.connect()
      await this.#client!.send(
        new this.#cmd!.CreateIndexCommand({
          vectorBucketName: this.#opts.connection.bucket,
          indexName: physicalIndex,
          dataType: 'float32',
          dimension: dims,
          distanceMetric: s3Metric,
        })
      )

      // Brief settle to ensure index is queryable (create has propagation delay)
      const probeVec = new Array(dims).fill(0).map((_, i) => (i === 0 ? 1 : 0))
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          await this.#client!.send(
            new this.#cmd!.QueryVectorsCommand({
              vectorBucketName: this.#opts.connection.bucket,
              indexName: physicalIndex,
              queryVector: { float32: probeVec },
              topK: 1,
              returnMetadata: false,
              returnDistance: false,
            })
          )
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    } catch (err: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const physicalIndex = this.#index(collection)

    if (ifExists) {
      if (!(await this.hasCollection(collection))) return
    } else if (!(await this.hasCollection(collection))) {
      return
    }

    try {
      await this.connect()
      await this.#client!.send(
        new this.#cmd!.DeleteIndexCommand({
          vectorBucketName: this.#opts.connection.bucket,
          indexName: physicalIndex,
        })
      )

      // Clear local state
      this.#dims.delete(collection)
      this.#metrics.delete(collection)
    } catch (err: any) {
      const msg = String(err)
      if (ifExists && (msg.includes('not found') || msg.includes('ResourceNotFoundException'))) {
        return
      }
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    try {
      const { indexes } = await this.#client!.send(
        new this.#cmd!.ListIndexesCommand({
          vectorBucketName: this.#opts.connection.bucket,
        })
      )
      const physicalIndex = this.#index(collection)
      return !!indexes?.find((idx: any) => idx.indexName === physicalIndex)
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 's3vectors'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)

    const collection = plan.collection
    const physicalIndex = this.#index(collection)
    const dims = this.#dims.get(collection) ?? this.#opts.dimensions

    try {
      await this.connect()

      const vectors: any[] = []
      for (const r of plan.records) {
        let vector = r.vector
        if (!vector && r.document) {
          const [v] = await this.encode([r.document], 'document')
          vector = v
        }
        if (!vector) {
          throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
        }
        if (dims !== undefined && vector.length !== dims) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dims, vector.length])
        }
        vectors.push({
          key: r.id,
          data: { float32: vector },
          metadata: { ...(r.metadata ?? {}), __document: r.document ?? '' },
        })
      }

      await this.#client!.send(
        new this.#cmd!.PutVectorsCommand({
          vectorBucketName: this.#opts.connection.bucket,
          indexName: physicalIndex,
          vectors,
        })
      )

      // Settle until keys are visible
      await this.#settle(physicalIndex, { present: plan.records.map((r) => r.id) })
    } catch (err) {
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_DIMENSION_MISMATCH', E_VECTOR_STORE_DIMENSION_MISMATCH) ||
        isInstanceOf(err, 'E_VECTOR_STORE_UPSERT_FAILED', E_VECTOR_STORE_UPSERT_FAILED)
      ) {
        throw err
      }
      throw new E_VECTOR_STORE_UPSERT_FAILED([String(err)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    await this.connect()
    const collection = plan.collection
    const physicalIndex = this.#index(collection)
    const metric = this.#metrics.get(collection) ?? this.#opts.metric ?? 'cosine'
    const offset = plan.offset ?? 0

    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        try {
          const res = await this.#client!.send(
            new this.#cmd!.GetVectorsCommand({
              vectorBucketName: this.#opts.connection.bucket,
              indexName: physicalIndex,
              keys: [plan.near.id],
              returnData: true,
              returnMetadata: true,
            })
          )
          const vec = res.vectors?.[0]
          if (!vec || !vec.data?.float32) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
          queryVector = vec.data.float32
        } catch (err: any) {
          if (
            err?.message?.includes('not found') ||
            err?.message?.includes('ResourceNotFoundException')
          ) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
          throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
        }
      }
    }

    const topK = plan.topK
    if (queryVector) {
      // Similarity search: QueryVectors with oversampling + JS-filter.
      // S3 Vectors caps topK at 100, so over-fetch up to that ceiling.
      const k = plan.filter ? 100 : Math.min(100, Math.max(topK + offset, 10))
      const res = await this.#client!.send(
        new this.#cmd!.QueryVectorsCommand({
          vectorBucketName: this.#opts.connection.bucket,
          indexName: physicalIndex,
          queryVector: { float32: queryVector },
          topK: k,
          returnMetadata: true,
          returnDistance: true,
        })
      )

      let rawMatches = res.vectors ?? []
      // Filter by JS-evaluateFilter if plan.filter present
      if (plan.filter) {
        rawMatches = rawMatches.filter((v: any) => {
          const meta: VectorMetadata = {}
          for (const key in v.metadata) {
            if (key !== '__document') meta[key] = v.metadata[key]
          }
          return evaluateFilter(plan.filter!, meta)
        })
      }
      // Slice offset+topK
      rawMatches = rawMatches.slice(offset, offset + topK)

      // Project matches, recompute scores, and fetch vectors if needed
      const projected: VectorMatch[] = []
      const keysToFetch = new Set<string>()
      if (plan.projection.vector) {
        for (const v of rawMatches) keysToFetch.add(v.key)
      }

      // Fetch vectors only when projected
      const vecStore: Record<string, number[]> = {}
      if (keysToFetch.size > 0) {
        const batch = Array.from(keysToFetch)
        const vecRes = await this.#client!.send(
          new this.#cmd!.GetVectorsCommand({
            vectorBucketName: this.#opts.connection.bucket,
            indexName: physicalIndex,
            keys: batch,
            returnData: true,
            returnMetadata: false,
          })
        )
        for (const v of vecRes.vectors ?? []) {
          if (v.data?.float32) vecStore[v.key] = v.data.float32
        }
      }

      for (const v of rawMatches) {
        const proj: VectorMatch = {}
        if (plan.projection.id) proj.id = v.key
        if (plan.projection.document) {
          proj.document = typeof v.metadata?.__document === 'string' ? v.metadata.__document : ''
        }
        if (plan.projection.metadata) {
          const meta: VectorMetadata = {}
          for (const key in v.metadata) {
            if (key !== '__document') meta[key] = v.metadata[key]
          }
          proj.metadata = meta
        }
        if (plan.projection.vector) {
          proj.vector = vecStore[v.key]
        }
        if (plan.near && v.distance !== undefined) {
          proj.score = scoreFromDistance(v.distance, metric)
        }
        projected.push(proj)
      }

      return projected
    } else {
      // Filter-scan: over-fetch via QueryVectors with arbitrary vector, JS-filter, project without score
      const res = await this.#client!.send(
        new this.#cmd!.QueryVectorsCommand({
          vectorBucketName: this.#opts.connection.bucket,
          indexName: physicalIndex,
          queryVector: {
            float32: new Array(this.#opts.dimensions ?? 3).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
          },
          topK: 100, // S3 Vectors max topK
          returnMetadata: true,
          returnDistance: false,
        })
      )

      let rawMatches = res.vectors ?? []
      // JS-filter for parity, then slice
      if (plan.filter) {
        rawMatches = rawMatches.filter((v: any) => {
          const meta: VectorMetadata = {}
          for (const key in v.metadata) {
            if (key !== '__document') meta[key] = v.metadata[key]
          }
          return evaluateFilter(plan.filter!, meta)
        })
      }
      rawMatches = rawMatches.slice(offset, offset + topK)

      // Fetch vectors only when projected
      const vecStore: Record<string, number[]> = {}
      if (plan.projection.vector && rawMatches.length > 0) {
        const vecRes = await this.#client!.send(
          new this.#cmd!.GetVectorsCommand({
            vectorBucketName: this.#opts.connection.bucket,
            indexName: physicalIndex,
            keys: rawMatches.map((v: any) => v.key),
            returnData: true,
            returnMetadata: false,
          })
        )
        for (const v of vecRes.vectors ?? []) {
          if (v.data?.float32) vecStore[v.key] = v.data.float32
        }
      }

      const projected: VectorMatch[] = []
      for (const v of rawMatches) {
        const proj: VectorMatch = {}
        if (plan.projection.id) proj.id = v.key
        if (plan.projection.document) {
          proj.document = typeof v.metadata?.__document === 'string' ? v.metadata.__document : ''
        }
        if (plan.projection.metadata) {
          const meta: VectorMetadata = {}
          for (const key in v.metadata) {
            if (key !== '__document') meta[key] = v.metadata[key]
          }
          proj.metadata = meta
        }
        if (plan.projection.vector) proj.vector = vecStore[v.key]
        // filter-scan: no score
        projected.push(proj)
      }

      return projected
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const collection = plan.collection
    const physicalIndex = this.#index(collection)

    try {
      await this.connect()
      const bucket = this.#opts.connection.bucket

      if (plan.ids && plan.ids.length > 0) {
        await this.#client!.send(
          new this.#cmd!.DeleteVectorsCommand({
            vectorBucketName: bucket,
            indexName: physicalIndex,
            keys: plan.ids,
          })
        )
        // Settle until absent
        await this.#settle(physicalIndex, { absent: plan.ids })
      } else if (plan.filter) {
        // Enumerate all, JS-filter, delete matched
        const res = await this.#client!.send(
          new this.#cmd!.QueryVectorsCommand({
            vectorBucketName: bucket,
            indexName: physicalIndex,
            queryVector: {
              float32: new Array(this.#opts.dimensions ?? 3)
                .fill(0)
                .map((_, i) => (i === 0 ? 1 : 0)),
            },
            topK: 100, // S3 Vectors max topK
            returnMetadata: true,
            returnDistance: false,
          })
        )

        const targets: string[] = []
        for (const v of res.vectors ?? []) {
          const evalMeta: VectorMetadata = {}
          for (const key in v.metadata) {
            if (key !== '__document') evalMeta[key] = v.metadata[key]
          }
          if (evaluateFilter(plan.filter, evalMeta)) {
            targets.push(v.key)
          }
        }

        if (targets.length > 0) {
          await this.#client!.send(
            new this.#cmd!.DeleteVectorsCommand({
              vectorBucketName: bucket,
              indexName: physicalIndex,
              keys: targets,
            })
          )
          // Settle until absent
          await this.#settle(physicalIndex, { absent: targets })
        }
      } else {
        // Delete all: enumerate all keys + delete
        const res = await this.#client!.send(
          new this.#cmd!.QueryVectorsCommand({
            vectorBucketName: bucket,
            indexName: physicalIndex,
            queryVector: {
              float32: new Array(this.#opts.dimensions ?? 3)
                .fill(0)
                .map((_, i) => (i === 0 ? 1 : 0)),
            },
            topK: 100, // S3 Vectors max topK
            returnMetadata: false,
            returnDistance: false,
          })
        )
        const allKeys = (res.vectors ?? []).map((v: any) => v.key)

        // If index has many vectors, may need pagination; but S3 Vectors QueryVectors is limited to 1000
        // For truly large collections, users should use filter-scan pattern explicitly.
        // Here, we do a best-effort single-page delete.
        if (allKeys.length > 0) {
          await this.#client!.send(
            new this.#cmd!.DeleteVectorsCommand({
              vectorBucketName: bucket,
              indexName: physicalIndex,
              keys: allKeys,
            })
          )
          // Settle until absent
          await this.#settle(physicalIndex, { absent: allKeys })
        }
      }
    } catch (err: any) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
