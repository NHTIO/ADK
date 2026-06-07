/**
 * Knex-style chainable query builder for the vector storage battery.
 *
 * @module @nhtio/adk/batteries/vector/builder
 */

import { isRawFilter, isFilterCondition } from './filters'
import {
  E_VECTOR_STORE_QUERY_CONFLICT,
  E_VECTOR_STORE_PROJECTION_REQUIRED,
  E_VECTOR_STORE_RAW_BINDING_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
} from './exceptions'
import type { VectorRecord, VectorMatch, VectorConsistency } from './types'
import type { SearchPlan, UpsertPlan, DeletePlan, Projection } from './plan'
import type { VectorFilter, FilterCondition, FilterOperator } from './filters'

const OP_ALIASES: Record<string, FilterOperator> = {
  '=': 'eq',
  '==': 'eq',
  '===': 'eq',
  '!=': 'ne',
  '<>': 'ne',
  '!==': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  'eq': 'eq',
  'ne': 'ne',
  'gt': 'gt',
  'gte': 'gte',
  'lt': 'lt',
  'lte': 'lte',
  'in': 'in',
  'nin': 'nin',
  'exists': 'exists',
  'contains': 'contains',
}
const normalizeOp = (op: string): FilterOperator => {
  const norm = OP_ALIASES[op]
  if (!norm) throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['builder', op])
  return norm
}

export interface PlanSink {
  executeSearch(plan: SearchPlan): Promise<VectorMatch[]>
  executeUpsert(plan: UpsertPlan): Promise<void>
  executeDelete(plan: DeletePlan): Promise<void>
}

export type SelectArg =
  | string
  | [string, Record<string, unknown>]
  | Record<string, Record<string, unknown> | true>

/**
 * A callback that receives a fresh filter-only builder, used to express a parenthesized group of
 * conditions — `A AND (B OR C)`, `NOT (…)`, and arbitrary nesting. The callback mutates the builder
 * in place (knex-style); its accumulated conditions become a single nested `VectorFilter`.
 *
 * @see {@link FilterBuilder.where}
 */
export type FilterCallback = (qb: FilterBuilder) => void

/**
 * The where-clause surface of the query builder, factored out so a grouping callback can be handed
 * a builder that only exposes filter methods (not `near*`/`select`/`limit` or the terminals).
 *
 * Chained `.where()` ANDs; the first `.orWhere()` snapshots the accumulated AND-list into the first
 * branch of an OR (knex semantics). Any of the where-methods also accepts a {@link FilterCallback}
 * to open a nested group, letting AND and OR mix to any depth.
 */
class FilterBuilder {
  protected andConditions: VectorFilter[] = []
  protected orBranches: VectorFilter[][] = []

  /** Build a nested group by running `cb` against a fresh {@link FilterBuilder}. */
  protected runGroup(cb: FilterCallback): VectorFilter | undefined {
    const fb = new FilterBuilder()
    cb(fb)
    return fb.buildFilter()
  }

  where(cb: FilterCallback): this
  where(a: string, b?: unknown, c?: unknown): this
  where(obj: Record<string, unknown>): this
  where(a: string | Record<string, unknown> | FilterCallback, b?: unknown, c?: unknown): this {
    if (typeof a === 'function') {
      const group = this.runGroup(a)
      if (group !== undefined) {
        this.andConditions.push(group)
      }
      return this
    }
    if (typeof a === 'object' && !Array.isArray(a)) {
      for (const key of Object.keys(a)) {
        this.andConditions.push({
          field: key,
          op: 'eq',
          value: a[key] as FilterCondition['value'],
        })
      }
      return this
    }
    const field = a as string
    const value = b !== undefined ? (c !== undefined ? c : b) : b
    const op = c !== undefined ? normalizeOp(b as string) : 'eq'
    this.andConditions.push({ field, op, value: value as FilterCondition['value'] })
    return this
  }

  andWhere(cb: FilterCallback): this
  andWhere(a: string, b?: unknown, c?: unknown): this
  andWhere(obj: Record<string, unknown>): this
  andWhere(a: string | Record<string, unknown> | FilterCallback, b?: unknown, c?: unknown): this {
    return this.where(a as any, b, c)
  }

  /**
   * Open a new OR branch holding a single filter. The accumulated AND-list is contributed as the
   * first OR-group by {@link buildFilter}, so each branch carries only its own condition(s) — that
   * is what makes `where(A).where(B).orWhere(C)` resolve to `(A AND B) OR C`.
   */
  #pushOrBranch(filter: VectorFilter): void {
    this.orBranches.push([filter])
  }

  orWhere(cb: FilterCallback): this
  orWhere(field: string, value: unknown): this
  orWhere(field: string, op: FilterOperator, value: unknown): this
  orWhere(field: string | FilterCallback, b?: unknown, c?: unknown): this {
    if (typeof field === 'function') {
      const group = this.runGroup(field)
      if (group !== undefined) {
        this.#pushOrBranch(group)
      }
      return this
    }
    const value = c !== undefined ? c : b
    const op = c !== undefined ? normalizeOp(b as string) : 'eq'
    this.#pushOrBranch({ field, op, value: value as FilterCondition['value'] })
    return this
  }

  whereNot(cb: FilterCallback): this
  whereNot(field: string, value: unknown): this
  whereNot(field: string | FilterCallback, value?: unknown): this {
    if (typeof field === 'function') {
      const group = this.runGroup(field)
      if (group !== undefined) {
        this.andConditions.push({ not: group })
      }
      return this
    }
    return this.where(field, 'ne', value as FilterCondition['value'])
  }

  orWhereNot(cb: FilterCallback): this
  orWhereNot(field: string, value: unknown): this
  orWhereNot(field: string | FilterCallback, value?: unknown): this {
    if (typeof field === 'function') {
      const group = this.runGroup(field)
      if (group !== undefined) {
        this.#pushOrBranch({ not: group })
      }
      return this
    }
    return this.orWhere(field, 'ne', value)
  }

  whereIn(field: string, values: unknown[]): this {
    return this.where(field, 'in', values as FilterCondition['value'])
  }

  whereNotIn(field: string, values: unknown[]): this {
    return this.where(field, 'nin', values as FilterCondition['value'])
  }

  whereNull(field: string): this {
    return this.where(field, 'exists', false as FilterCondition['value'])
  }

  whereExists(field: string): this {
    return this.where(field, 'exists', true as FilterCondition['value'])
  }

  whereRaw(sql: string, bindings?: unknown[]): this
  whereRaw(rawObj: { $dialect: string; $raw: unknown; $bindings?: unknown[] }): this
  whereRaw(
    sqlOrObj: string | { $dialect: string; $raw: unknown; $bindings?: unknown[] },
    bindings?: unknown[]
  ): this {
    if (typeof sqlOrObj === 'object') {
      this.andConditions.push({
        $dialect: sqlOrObj.$dialect,
        $raw: sqlOrObj.$raw,
        $bindings: sqlOrObj.$bindings ?? [],
      })
    } else {
      this.andConditions.push({ $dialect: 'sql', $raw: sqlOrObj, $bindings: bindings ?? [] })
    }
    return this
  }

  protected buildFilter(): VectorFilter | undefined {
    if (this.andConditions.length === 0 && this.orBranches.length === 0) {
      return undefined
    }

    if (this.orBranches.length > 0) {
      const orGroups: VectorFilter[][] = []
      if (this.andConditions.length > 0) {
        orGroups.push(this.andConditions)
      }
      for (const branch of this.orBranches) {
        if (branch.length > 0) {
          orGroups.push(branch)
        }
      }
      if (orGroups.length === 1) {
        return { and: orGroups[0] }
      }
      return { or: orGroups.map((conds) => ({ and: conds })) }
    }

    return { and: this.andConditions }
  }

  protected extractIdsFromFilter(): string[] {
    const ids: string[] = []
    const only = this.andConditions.length === 1 ? this.andConditions[0] : undefined
    if (
      only &&
      isFilterCondition(only) &&
      only.field === 'id' &&
      only.op === 'in' &&
      Array.isArray(only.value)
    ) {
      ids.push(...(only.value as string[]))
    }
    return ids
  }
}

class VectorQueryBuilder extends FilterBuilder implements PromiseLike<VectorMatch[]> {
  #sink: PlanSink
  #collection: string
  #near: { vector: number[] } | { serverText: string } | { id: string } | undefined
  #projection: Projection = { id: false, vector: false, document: false, metadata: false }
  #topK: number
  #offset: number = 0
  #selectCalled: boolean = false
  #consistency: VectorConsistency | undefined

  constructor(sink: PlanSink, collection: string, defaultTopK: number) {
    super()
    this.#sink = sink
    this.#collection = collection
    this.#topK = defaultTopK
  }

  nearVector(vector: number[]): this {
    if (this.#near !== undefined) {
      throw new E_VECTOR_STORE_QUERY_CONFLICT(['a near* clause was already set'])
    }
    this.#near = { vector }
    return this
  }

  nearText(text: string): this {
    if (this.#near !== undefined) {
      throw new E_VECTOR_STORE_QUERY_CONFLICT(['a near* clause was already set'])
    }
    this.#near = { serverText: text }
    return this
  }

  nearId(id: string): this {
    if (this.#near !== undefined) {
      throw new E_VECTOR_STORE_QUERY_CONFLICT(['a near* clause was already set'])
    }
    this.#near = { id }
    return this
  }

  select(...args: SelectArg[]): this {
    this.#selectCalled = true
    for (const arg of args) {
      if (typeof arg === 'string') {
        if (arg === '*') {
          this.#projection = { id: true, vector: {}, document: {}, metadata: {} }
        } else {
          if (arg === 'id') {
            this.#projection.id = true
          } else if (arg === 'vector') {
            this.#projection.vector = {}
          } else if (arg === 'document') {
            this.#projection.document = {}
          } else if (arg === 'metadata') {
            this.#projection.metadata = {}
          }
        }
      } else if (Array.isArray(arg)) {
        const [field, config] = arg
        if (field === 'vector') {
          this.#projection.vector = config as { name?: string }
        } else if (field === 'document') {
          this.#projection.document = config as { field?: string }
        } else if (field === 'metadata') {
          this.#projection.metadata = config as { fields?: string[] }
        } else if (field === 'id') {
          this.#projection.id = true
        }
      } else if (typeof arg === 'object') {
        for (const key of Object.keys(arg)) {
          if (key === 'vector') {
            this.#projection.vector = arg[key] as { name?: string }
          } else if (key === 'document') {
            this.#projection.document = arg[key] as { field?: string }
          } else if (key === 'metadata') {
            this.#projection.metadata = arg[key] as { fields?: string[] }
          } else if (key === 'id') {
            this.#projection.id = true
          }
        }
      }
    }
    return this
  }

  limit(n: number): this {
    this.#topK = n
    return this
  }

  offset(n: number): this {
    this.#offset = n
    return this
  }

  /**
   * Per-operation read-after-write override for the terminal `.upsert()` / `.delete()`.
   * Universal across adapters: strongly-consistent backends ignore it (no-op), so a chain
   * written for an eventually-consistent backend keeps working verbatim when the adapter is
   * swapped. Precedence: this > the store's `consistency` option > the adapter's declared
   * `capabilities.consistency.default`. See {@link VectorConsistency}.
   */
  consistency(mode: VectorConsistency): this {
    this.#consistency = mode
    return this
  }

  then<TR1 = VectorMatch[], TR2 = never>(
    onfulfilled?: ((value: VectorMatch[]) => TR1 | PromiseLike<TR1>) | null,
    onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null
  ): PromiseLike<TR1 | TR2> {
    return this.#run().then(onfulfilled as any, onrejected as any)
  }

  async #run(): Promise<VectorMatch[]> {
    if (!this.#selectCalled) {
      throw new E_VECTOR_STORE_PROJECTION_REQUIRED()
    }

    const filter = this.buildFilter()

    const plan: SearchPlan = {
      collection: this.#collection,
      near: this.#near,
      filter,
      topK: this.#topK,
      offset: this.#offset,
      projection: this.#projection,
    }

    this.#validateRawFilters(plan.filter)

    return await this.#sink.executeSearch(plan)
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const plan: UpsertPlan = {
      collection: this.#collection,
      records,
      consistency: this.#consistency,
    }
    await this.#sink.executeUpsert(plan)
  }

  async delete(): Promise<void> {
    const ids = this.extractIdsFromFilter()
    const filter = this.buildFilter()

    const plan: DeletePlan = {
      collection: this.#collection,
      ids: ids.length > 0 ? ids : undefined,
      filter: filter && Object.keys(filter).length > 0 ? filter : undefined,
      consistency: this.#consistency,
    }

    await this.#sink.executeDelete(plan)
  }

  #validateRawFilters(filter: VectorFilter | undefined): void {
    if (!filter) {
      return
    }

    if (isRawFilter(filter)) {
      const raw = filter.$raw as string
      const placeholders = (raw.match(/\?/g) || []).length
      if (placeholders !== filter.$bindings?.length) {
        throw new E_VECTOR_STORE_RAW_BINDING_MISMATCH([placeholders, filter.$bindings?.length ?? 0])
      }
      return
    }

    if ('and' in filter && filter.and) {
      for (const f of filter.and) {
        this.#validateRawFilters(f)
      }
    }

    if ('or' in filter && filter.or) {
      for (const f of filter.or) {
        this.#validateRawFilters(f)
      }
    }

    if ('not' in filter && filter.not) {
      this.#validateRawFilters(filter.not)
    }
  }
}

export { VectorQueryBuilder, FilterBuilder }
