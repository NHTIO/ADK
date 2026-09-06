/**
 * Template validation and instantiation for orchestration.
 *
 * @module @nhtio/adk/batteries/orchestration/templates
 *
 * @remarks
 * A template is a consumer-defined plan *shape* — written in TypeScript, registered with
 * `createOrchestration` at construction, and therefore versioned with the consuming application.
 * It needs no store seeding and can be **validated once at boot** rather than once per
 * instantiation, so a misconfigured deployment fails at startup with a named issue rather than at
 * the first use months later.
 *
 * Why templates exist at all is the small-model story: a small model working on a forty-node plan
 * does far better filling in five declared parameters than authoring forty nodes. The template is
 * the static part of that bargain — the consumer writes the shape, the model fills the holes.
 *
 * A template is **not** a plan. It has no lifecycle, no digest, no run, and cannot be approved.
 * Only its instantiations are plans, which is what keeps "one plan id, at most one run" intact
 * when the same template is instantiated fifty times: each instantiation is an independent plan
 * with its own id and digest.
 *
 * The two exported functions are the whole surface:
 *
 * - {@link validateTemplate} — runs at **construction**. Every issue it returns is decidable and
 *   total *because* a registered template is immutable: the graph cannot change after the check,
 *   so the answer cannot go stale. The most important check is the laundering rule (below).
 * - {@link instantiateTemplate} — validates the arguments a model offers against the declared
 *   `params`, mints a fresh plan, substitutes every hole, and appends the graph as authored ops.
 *
 * ## The laundering rule
 *
 * A `ParamRef` reaching a `call` node's `args` is refused unless a node on **every route** to that
 * call declares the corresponding field in `declassifies`. This is the taint story made static:
 * a substituted parameter value is like entry input — untrusted — and it may reach a `reason`
 * prompt but not a `call` node's args unless a node on every path to the call has declassified it.
 *
 * The check lives over the **template, not over an instantiation**, and that is the whole reason
 * it can be total: it runs at construction, once, over a graph that is immutable from that moment.
 *
 * **The narrower invariant, stated honestly:** *a template cannot launder its own parameters.* It
 * does **not** claim that a substituted value's template origin is tracked through arbitrary later
 * edits — nothing in a freely-mutable graph can track that. Once instantiated, the result is an
 * ordinary `editable` plan and a substituted value is an ordinary literal; a later `set_node_field`
 * routing that literal into a `call` arg is exactly as visible as in any hand-authored plan, which
 * is to say: it is in the operator's rendered prose, and the operator approves it. That is the
 * honest boundary, and it is the same one every hand-authored plan already has.
 */

import { ParamRef } from './encoding'
import { DEFAULT_PLAN_BOUNDS } from './types'
import { isInstanceOf, isObject } from '../../lib/utils/guards'
import type { PlanStore } from './store'
import type {
  CallNodeDefinition,
  DeclaredField,
  EncodableValue,
  InstantiateResult,
  InvocableTools,
  NodeId,
  PlanBounds,
  PlanEdge,
  PlanIssue,
  PlanNode,
  PlanOp,
  PlanTemplate,
  TemplateDefinitionOf,
  TemplateNode,
} from './types'

// ── local structural helpers ────────────────────────────────────────────────
/**
 * True for a PLAIN object — one whose prototype is `Object.prototype` or `null`. This is the same
 * distinction the fold (`ops.ts`) and the encoder's key-sorting make: every encoder-owned value
 * (`Date`, `RegExp`, `Map`, `Set`, typed arrays, and the `NodeRef`/`ParamRef` instances) has a
 * non-plain prototype, so this is exactly the set whose keys substitution is allowed to walk.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  isObject(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/** Every distinct simple path `fromId → … → toId` as node-id sequences; truncated at a hard cap. */
const simpleRoutesFrom = (
  nodes: readonly TemplateNode[],
  edges: readonly PlanEdge[],
  fromId: NodeId,
  toId: NodeId
): NodeId[][] => {
  const byFrom = new Map<NodeId, PlanEdge[]>()
  for (const e of edges) {
    const list = byFrom.get(e.from)
    if (list) list.push(e)
    else byFrom.set(e.from, [e])
  }
  const idSet = new Set(nodes.map((n) => n.id))
  const routes: NodeId[][] = []
  const dfs = (cur: NodeId, path: NodeId[]) => {
    if (routes.length === MAX_ROUTES) return
    for (const e of byFrom.get(cur) ?? []) {
      if (path.includes(e.to) || !idSet.has(e.to)) continue
      const next = [...path, e.to]
      if (e.to === toId) {
        routes.push(next)
        if (routes.length > MAX_ROUTES) return
      } else {
        dfs(e.to, next)
      }
    }
  }
  dfs(fromId, [fromId])
  return routes
}

/** The cap on distinct simple routes `simpleRoutesFrom` enumerates before giving up. */
const MAX_ROUTES = 10_000

/** The single `entry` node of a template, or `undefined` when there is none or more than one. */
const singleEntry = (nodes: readonly TemplateNode[]): TemplateNode | undefined => {
  const entries = nodes.filter((n) => n.kind === 'entry')
  return entries.length === 1 ? entries[0] : undefined
}

/**
 * True when the node with id `rid` is a `call` declaring `path` in `declassifies`. Only a `call`
 * node can declassify (the sanctioned sanitisation point); every other kind never clears taint.
 */
const nodeDeclassifies = (nodes: readonly TemplateNode[], rid: NodeId, path: string): boolean =>
  nodes.some((n) => {
    if (n.id !== rid || n.kind !== 'call') return false
    const def = n.definition as TemplateDefinitionOf<CallNodeDefinition>
    return Array.isArray(def.declassifies) && pathIsDeclared(def.declassifies as string[], path)
  })

/** The `DeclaredField` whose `path` equals `path`, or `undefined`. */
const declaredFieldByPath = (
  params: readonly DeclaredField[],
  path: string
): DeclaredField | undefined => params.find((p) => p.path === path)

/**
 * True when a literal path equals, extends, or is a prefix of a declared field path — the same
 * prefix semantics the freeze validator uses for `NodeRef.path`, applied here to `declassifies`
 * coverage.
 */
const pathIsDeclared = (declared: readonly string[], path: string): boolean =>
  declared.some((p) => p === path || p.startsWith(path + '.') || path.startsWith(p + '.'))

/** Recursively collect every `ParamRef` in a staged value, in first-encountered order. */
const collectParamRefs = (value: unknown, out: ParamRef[]): void => {
  if (ParamRef.isParamRef(value)) {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectParamRefs(v, out)
    return
  }
  if (isInstanceOf(value, 'Map', Map)) {
    for (const [k, v] of value) {
      collectParamRefs(k, out)
      collectParamRefs(v, out)
    }
    return
  }
  if (isInstanceOf(value, 'Set', Set)) {
    for (const v of value) collectParamRefs(v, out)
    return
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) collectParamRefs(value[key], out)
  }
}

/**
 * Recursively replace every `ParamRef` with the corresponding argument value. Plain objects,
 * arrays, `Map`s and `Set`s are walked; every other encoder-owned value (`NodeRef`, `Date`,
 * `RegExp`, typed arrays, bigint, luxon values) rides through by reference untouched. After this,
 * no `ParamRef` remains, so a substituted definition is an ordinary value in the `ArgValue` domain.
 */
const substituteParamRefs = (value: unknown, args: Record<string, EncodableValue>): unknown => {
  if (ParamRef.isParamRef(value)) return args[value.path]
  if (Array.isArray(value)) return value.map((v) => substituteParamRefs(v, args))
  if (isInstanceOf(value, 'Map', Map)) {
    const out = new Map<unknown, unknown>()
    for (const [k, v] of value) out.set(substituteParamRefs(k, args), substituteParamRefs(v, args))
    return out
  }
  if (isInstanceOf(value, 'Set', Set)) {
    return new Set([...value].map((v) => substituteParamRefs(v, args)))
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = substituteParamRefs(value[key], args)
    return out
  }
  return value
}

/**
 * Validate the `args` map against the template's declared `params`, naming the offending param and
 * what was expected. Returns `{ok: true, values}` with the concrete per-param values on success,
 * or `{ok: false, detail}` on the first failure.
 */
const checkArgs = (
  params: readonly DeclaredField[],
  args: Record<string, EncodableValue>
): { ok: true; values: Record<string, EncodableValue> } | { ok: false; detail: string } => {
  for (const field of params) {
    const value = args[field.path]
    if (value === undefined && !(field.path in args)) {
      return {
        ok: false,
        detail: `Param "${field.path}" is required and was not supplied; expected ${describe(field)}.`,
      }
    }
    if (!typeMatches(field, value)) {
      return {
        ok: false,
        detail: `Param "${field.path}" has the wrong type: expected ${describe(field)}, got ${describeValue(value)}.`,
      }
    }
  }
  return { ok: true, values: args }
}

/** A human phrase for what a declared field expects. */
const describe = (field: DeclaredField): string => {
  switch (field.type) {
    case 'string':
      return field.maxBytes !== undefined
        ? `a string of at most ${field.maxBytes} bytes`
        : 'a string'
    case 'number':
      return 'a finite number'
    case 'boolean':
      return 'a boolean'
    case 'enum':
      return `one of ${field.values.map((v) => JSON.stringify(v)).join(', ')}`
  }
}

/** A short human phrase for an actual argument value, for error detail text. */
const describeValue = (value: unknown): string => {
  if (typeof value === 'string')
    return JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value)
  if (value === null) return 'null'
  return typeof value
}

/** Whether a raw value satisfies a declared field's type and enum membership. */
const typeMatches = (field: DeclaredField, value: EncodableValue | undefined): boolean => {
  if (value === undefined) return false
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return false
      if (field.maxBytes !== undefined && byteLength(value) > field.maxBytes) return false
      return true
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
  }
}

/** UTF-8 byte length of a string — the unit `maxBytes` is expressed in. */
const byteLength = (s: string): number => {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

// ── validateTemplate ─────────────────────────────────────────────────────────
/**
 * Validate a template against the invocable allowlist, once, at construction.
 *
 * @remarks
 * Every issue returned here is a blocking refusal: a deployment whose template fails this check
 * should fail to boot, not fail at the first instantiation months later. This is the whole point
 * of validating over the immutable template rather than over each (mutable) instantiation.
 *
 * The checks:
 *
 * 1. **Undeclared holes.** A `ParamRef` whose `path` does not name a declared `params` entry is
 *    refused — a template cannot substitute a parameter it never declared.
 * 2. **Unknown tools.** A `call` node naming a tool absent from `invocable.has(tool)` is refused,
 *    and the message names what *is* available so the author can fix it.
 * 3. **The laundering check.** A `ParamRef` reaching a `call` node's `args` is refused unless a
 *    node on every route to that call declares the corresponding field in `declassifies`. See the
 *    module TSDoc for the honest, narrower invariant this enforces — *a template cannot launder
 *    its own parameters* — and why nothing more is claimed.
 *
 * The route enumeration is capped at {@link MAX_ROUTES} paths. A template with more distinct
 * simple paths than that cannot prove that *every* route declassifies, and is conservatively
 * refused rather than trusted on a partial count.
 *
 * @param tpl - The template to validate.
 * @param invocable - The tier-C allowlist a staged `call` may invoke.
 * @returns Every blocking issue the template raises; an empty array means it is safe to register.
 */
export function validateTemplate(tpl: PlanTemplate, invocable: InvocableTools): PlanIssue[] {
  const issues: PlanIssue[] = []
  const entry = singleEntry(tpl.nodes)

  // 1. Undeclared holes: every ParamRef must name a declared params entry.
  for (const node of tpl.nodes) {
    if (node.kind !== 'call') continue
    const def = node.definition as TemplateDefinitionOf<CallNodeDefinition>
    const refs: ParamRef[] = []
    collectParamRefs(def.args, refs)
    for (const ref of refs) {
      if (!declaredFieldByPath(tpl.params, ref.path)) {
        issues.push({
          code: 'unknown_param',
          message:
            `Template "${tpl.id}" places a template hole "${ref.path}" in call node ` +
            `"${node.id}", but no declared param has that path; name a declared param or add one.`,
          nodeId: node.id,
          severity: 'blocking',
        })
      }
    }
  }

  // 2. Unknown tools: a call may only name a tool the allowlist recognises.
  for (const node of tpl.nodes) {
    if (node.kind !== 'call') continue
    const def = node.definition as TemplateDefinitionOf<CallNodeDefinition>
    const tool = def.tool as string
    if (!invocable.has(tool)) {
      const available = invocable.names()
      issues.push({
        code: 'unknown_tool',
        message:
          `Call node "${node.id}" in template "${tpl.id}" names tool "${tool}", which is not on ` +
          `the allowlist; use one of the available tools: ${available.join(', ')}.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
  }

  // 3. The laundering check: a ParamRef in a call's args is refused unless a node on EVERY route
  //    to that call declares the corresponding field in `declassifies`. This runs over the
  //    immutable template, so the answer is decidable and cannot go stale.
  if (entry !== undefined) {
    for (const node of tpl.nodes) {
      if (node.kind !== 'call') continue
      const def = node.definition as TemplateDefinitionOf<CallNodeDefinition>
      const refs: ParamRef[] = []
      collectParamRefs(def.args, refs)
      if (refs.length === 0) continue
      // Per-param path, so the message can name the hole and the missing declassification.
      const paths = refs.map((r) => r.path).filter((p, i, arr) => arr.indexOf(p) === i)
      const routes = simpleRoutesFrom(tpl.nodes, tpl.edges, entry.id, node.id)
      const truncated = routes.length > MAX_ROUTES
      for (const path of paths) {
        // An unreachable call has no routes to itself; that is an unreachable-node concern that
        // belongs to the plan validator, not the laundering rule.
        if (routes.length === 0) continue
        const everyRouteDeclassifies =
          !truncated &&
          routes.every((route) =>
            // Every node strictly before the call on this route (including ancestors) declaring the
            // path in `declassifies`. The call's OWN `declassifies` declassifies its OUTPUT, never
            // its input, so the call itself cannot declassify its own argument.
            route.slice(0, -1).some((rid) => nodeDeclassifies(tpl.nodes, rid, path))
          )
        if (!everyRouteDeclassifies) {
          issues.push({
            code: 'param_not_declassified',
            message:
              `Template "${tpl.id}" routes template hole "${path}" into the args of call node ` +
              `"${node.id}" through a route that does not declassify it; every route to that call ` +
              `must pass a node declaring "${path}" in "declassifies".${truncated ? ' The route count exceeds the enumeration cap, so safety cannot be proven.' : ''}`,
            nodeId: node.id,
            severity: 'blocking',
          })
        }
      }
    }
  }

  return issues
}

// ── instantiateTemplate ──────────────────────────────────────────────────────
/**
 * Instantiate a template into a fresh, ordinary `editable` plan.
 *
 * @remarks
 * A template holds **op inputs without identity**: a `PlanOp` requires `opId`/`actorId`/`lamport`/
 * `at`, and no static literal can carry those — the same reason bounds are a fold seed rather than
 * an implied op. So instantiation **mints** that identity here, under the passed `actorId`, with a
 * monotonic lamport.
 *
 * The steps, in order:
 *
 * 1. **Validate `args` against `params`** — types (plus `maxBytes` on strings) and enum
 *    membership. On failure it returns `{ok: false, reason: 'invalid_args', detail}` naming the
 *    offending param and what was expected, rather than minting a broken plan.
 * 2. **`store.createPlan(planId, {provenance: {kind: 'template', template: tpl.id, args}})`** — the
 *    provenance is persisted by the store and returned by `readProvenance`, for the renderer and
 *    for audit. It is **not** a taint mechanism (see the module TSDoc).
 * 3. **Substitute every `ParamRef`** with the corresponding argument value, then append
 *    `add_node` / `add_edge` / `set_bounds` ops.
 *
 * The result is an **ordinary `editable` plan**: no inherited approval, no special state, nothing
 * downstream needs to know it came from a template. Two instantiations of one template yield
 * independent plans with different ids and digests.
 *
 * `planId` is minted (not a parameter), because a fresh plan needs a fresh id — a caller does not
 * pre-choose one. If the mint races a duplicate, an error is thrown rather than returning a broken
 * or mislabelled result.
 *
 * @param store - The plan store to write into.
 * @param tpl - The registered template to materialise.
 * @param args - The concrete values, keyed by declared param `path`, to substitute for holes.
 * @param actorId - The identity under which the minted ops are authored.
 * @returns The instantiation result.
 */
export async function instantiateTemplate(
  store: PlanStore,
  tpl: PlanTemplate,
  args: Record<string, EncodableValue>,
  actorId: string
): Promise<InstantiateResult> {
  const checked = checkArgs(tpl.params, args)
  if (!checked.ok) {
    return { ok: false, reason: 'invalid_args', detail: checked.detail }
  }

  const planId = `plan-${crypto.randomUUID()}`
  const created = await store.createPlan(planId, {
    provenance: { template: tpl.id, args: checked.values },
  })
  if (!created.ok) {
    throw new Error(
      `instantiateTemplate: store refused to create plan "${planId}" (${created.reason}); ` +
        `a freshly-minted id collided or the store rejected the provenance.`
    )
  }

  // Mint fresh identity under the passed actor, with a monotonic lamport. The fold orders ops by
  // (lamport, actorId, opId), so each op needs a distinct opId even at the same lamport.
  const at = new Date().toISOString()
  const ops: PlanOp[] = []
  let lamport = 1
  const nextId = (): string => `${actorId}-${planId}-${lamport}-${crypto.randomUUID()}`

  for (const node of tpl.nodes) {
    ops.push({
      op: 'add_node',
      node: {
        ...node,
        definition: substituteParamRefs(node.definition, checked.values) as PlanNode['definition'],
      } as PlanNode,
      opId: nextId(),
      actorId,
      lamport,
      at,
    })
    lamport++
  }
  const bounds: PlanBounds = tpl.bounds ?? DEFAULT_PLAN_BOUNDS
  for (const edge of tpl.edges) {
    ops.push({
      op: 'add_edge',
      edge,
      opId: nextId(),
      actorId,
      lamport,
      at,
    })
    lamport++
  }
  ops.push({
    op: 'set_bounds',
    bounds,
    opId: nextId(),
    actorId,
    lamport,
    at,
  })
  lamport++

  const appended = await store.appendOps(planId, ops, 0)
  if (!appended.ok) {
    throw new Error(
      `instantiateTemplate: store refused to append ops to "${planId}" (${appended.reason}).`
    )
  }

  return { ok: true, planId, issues: [] }
}
