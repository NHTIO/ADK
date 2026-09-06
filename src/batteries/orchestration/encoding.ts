/**
 * Encoding battery for orchestration: the reference classes the IR is built from, their
 * `@nhtio/encoder` registration, and the plan digest every approval binds to.
 *
 * @module @nhtio/adk/batteries/orchestration/encoding
 *
 * @remarks
 * This module owns three things:
 *
 * 1. `NodeRef` and `ParamRef` — the two CLASSES the IR uses for references and template holes.
 *    They are classes, not records with a marker field, for a reason stated in their TSDoc: a
 *    plain record can wear `{kind: 'nodeRef', …}` — it is an ordinary encodable record — so a
 *    marker property cannot separate a reference from a literal that merely looks like one, and a
 *    resolver keying on it would silently rewrite the literal. `instanceof` is unforgeable.
 * 2. `registerOrchestrationEncodables()` — the one call that makes `decode()` able to rebuild
 *    these classes. It MUST run before any `decode()`.
 * 3. `planDigest()` — the canonical, LOSSLESS digest of a `RawPlanView`. Every approval binds to
 *    this digest, so it must never collide across semantically-different plans.
 */

import { sha256 } from 'js-sha256'
import { isInstanceOf } from '@nhtio/adk/guards'
import { ENCODE_METHOD, DECODE_METHOD, encode, registerClass } from '@nhtio/encoder'
import type { Encodable } from '@nhtio/encoder'
import type { RawPlanView, NodeId, BranchId } from './types'

// ── NodeRef ───────────────────────────────────────────────────────────────────
/**
 * A serializable reference to another node's output — a CLASS, not a record.
 *
 * @remarks
 * Why a class rather than a record with a marker field: a plain record can wear
 * `{kind: 'nodeRef', node, select, …}` — it is an ordinary encodable record — so a marker
 * property cannot separate a reference from a literal that happens to look like one, and a
 * resolver keying on it would silently rewrite the literal. `instanceof` is unforgeable: no
 * record can satisfy `NodeRef.isNodeRef`, and the encoder round-trips instances as
 * `custom:NodeRef` rather than as records. Same mechanism core uses for `Media`/`Tokenizable`.
 *
 * `branchId` identifies WHICH EXECUTION of `node` to read — the same path identity `NodeOutput`
 * and `FrameRef` carry. Omitted means "do not filter".
 */
export class NodeRef {
  /** The id of the node whose output this reference reads. */
  node: NodeId
  /** Which item of that node's output to take: 'first', 'last', 'all', or an explicit {index}. */
  select: 'first' | 'last' | 'all' | { index: number }
  /** An optional dot-path into the selected item's value. */
  path?: string
  /**
   * WHICH EXECUTION of the node to read, as a path identity.
   *
   * @remarks
   * This is NOT an outgoing branch of that node: a node fanning out to two successors still runs
   * once and produces one output; what creates several outputs for one node is that node being
   * REACHED by several paths. Omitted means "do not filter" — fine when exactly one path reaches
   * the node, and refused at freeze when more than one does.
   */
  branchId?: BranchId

  /**
   * Construct a `NodeRef`.
   *
   * @param node - The id of the node whose output this reference reads.
   * @param select - Which item of that node's output to take: 'first', 'last', 'all', or an explicit {index}.
   * @param path - An optional dot-path into the selected item's value.
   * @param branchId - Which execution of the node to read, as a path identity; omitted means "do not filter".
   */
  constructor(
    node: NodeId,
    select: 'first' | 'last' | 'all' | { index: number },
    path?: string,
    branchId?: BranchId
  ) {
    this.node = node
    this.select = select
    this.path = path
    this.branchId = branchId
  }

  /** `instanceof` guard — a look-alike record cannot pass. */
  static isNodeRef(v: unknown): v is NodeRef {
    return isInstanceOf(v, 'NodeRef', NodeRef)
  }

  /** Emit a plain snapshot of the fields for the encoder. */
  [ENCODE_METHOD](): Record<string, unknown> {
    return { node: this.node, select: this.select, path: this.path, branchId: this.branchId }
  }

  /** Rebuild an instance from a {@link NodeRef.[ENCODE_METHOD]} snapshot. */
  static [DECODE_METHOD](data: unknown): NodeRef {
    const s = data as {
      node: NodeId
      select: NodeRef['select']
      path?: string
      branchId?: BranchId
    }
    return new NodeRef(s.node, s.select, s.path, s.branchId)
  }
}

// ── ParamRef ─────────────────────────────────────────────────────────────────
/**
 * A hole in a template's staged values, substituted at instantiation. A CLASS for the same
 * reason `NodeRef` is: a look-alike record must not be mistaken for a hole.
 */
export class ParamRef {
  /** Must name a declared template `params` entry (checked at construction). */
  path: string

  /**
   * Construct a `ParamRef`.
   *
   * @param path - The declared template `params` entry this hole names.
   */
  constructor(path: string) {
    this.path = path
  }

  /** `instanceof` guard — a look-alike record cannot pass. */
  static isParamRef(v: unknown): v is ParamRef {
    return isInstanceOf(v, 'ParamRef', ParamRef)
  }

  /** Emit a plain snapshot of the fields for the encoder. */
  [ENCODE_METHOD](): Record<string, unknown> {
    return { path: this.path }
  }

  /** Rebuild an instance from a {@link ParamRef.[ENCODE_METHOD]} snapshot. */
  static [DECODE_METHOD](data: unknown): ParamRef {
    return new ParamRef((data as { path: string }).path)
  }
}

// ── registration ──────────────────────────────────────────────────────────────
let registered = false

/**
 * Register `NodeRef` and `ParamRef` with the `@nhtio/encoder` decoder.
 *
 * @remarks
 * **MUST run before any `decode()` — but {@link createOrchestration} already calls it**, so a
 * consumer who constructs through the battery's entry point never needs to. Call it directly only
 * when you reach the deep subpaths without constructing an `Orchestration` (decoding a persisted
 * plan in a worker, say).
 *
 * **MUST run before any `decode()`.** `registerClass` writes to a GLOBAL registry, and decoding
 * an unregistered class throws — the decoder must map a `custom:NodeRef`/`custom:ParamRef` wire
 * tag back to a constructor. Idempotent: safe to call more than once (re-registering a class is a
 * no-op overwrite). Encoding never needs this; only decoding does.
 */
export const registerOrchestrationEncodables = (): void => {
  if (registered) return
  registered = true
  registerClass(NodeRef)
  registerClass(ParamRef)
}

// ── plan digest ──────────────────────────────────────────────────────────────
/**
 * True for a PLAIN object — one whose prototype is `Object.prototype` or `null`. Every
 * encoder-owned value (`Date`, `RegExp`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `DataView`,
 * bigint, luxon values, `NodeRef`/`ParamRef` instances) has a non-plain prototype, so this is
 * exactly the set whose keys we are allowed to sort.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively sort PLAIN-OBJECT keys only, leaving every encoder-owned value untouched.
 *
 * @remarks
 * This is the deliberate alternative to `canonicalStringify` from `src/lib/utils/canonical_json.ts`.
 * That helper walks objects with `Object.keys`, and `Date`, `RegExp`, `Map` and `Set` have no
 * enumerable own keys, so it collapses each to `{}` — a proven collision (see the module TSDoc).
 * Here we sort only plain-object keys and hand every other value to the encoder UNCHANGED, so
 * `encode` serialises `Date`/`RegExp`/`Map`/`Set`/typed arrays/`ArrayBuffer`/`DataView`/bigint/
 * luxon/`NodeRef`/`ParamRef` faithfully. Sorting must NEVER replace the encoder's representation
 * of those values — that is exactly the mistake `canonicalStringify` makes. Arrays keep their
 * order (order is meaningful).
 */
const sortPlainObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortPlainObjectKeys)
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortPlainObjectKeys(value[key])
    }
    return out
  }
  // Encoder-owned value (Date, RegExp, Map, Set, typed array, ArrayBuffer, DataView, bigint,
  // luxon, NodeRef, ParamRef, …) — leave untouched so `encode` serialises it faithfully.
  return value
}

/**
 * Compute the canonical, LOSSLESS digest of a `RawPlanView`.
 *
 * @remarks
 * Every approval binds to this digest, so it must be a faithful fingerprint of the plan content
 * the operator actually saw — never a lossy one that could authorise a plan they did not see.
 *
 * The strategy: recursively sort PLAIN-OBJECT keys only (leaving every encoder-owned value —
 * `Date`, `RegExp`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `DataView`, bigint, luxon values,
 * and `NodeRef`/`ParamRef` instances — untouched), then `sha256(encode(sortedSkeleton))`. The
 * encoder is the authority on how each value serialises, and it round-trips the reference classes
 * and the whole `EncodableValue` domain losslessly, so the digest is stable across key order while
 * remaining collision-free across semantically-different plans.
 *
 * This is the second of the two digest strategies considered. The first — `canonicalStringify`
 * from `src/lib/utils/canonical_json.ts` — was rejected because it walks objects with
 * `Object.keys`, and `Date`, `RegExp`, `Map` and `Set` have no enumerable own keys, so it collapses
 * each to `{}`. That is proven to collide: `{pattern: /^inv-\d+$/i, when: <date A>, m: Map{k=>1}}`
 * and `{pattern: /^cust-\d+$/, when: <date B>, m: Map{z=>9}}` both canonicalise to
 * `{"m":{},"pattern":{},"when":{}}`. An approval bound to that digest would authorise a plan the
 * operator never saw. This implementation sorts only plain-object keys and never replaces the
 * encoder's representation of the values it owns.
 *
 * @param view - The folded plan content at a revision.
 * @returns A hex sha256 digest over the canonical, lossless encoding of `view`.
 */
export const planDigest = (view: RawPlanView): string => {
  const sorted = sortPlainObjectKeys(view)
  return sha256(encode(sorted as Encodable))
}
