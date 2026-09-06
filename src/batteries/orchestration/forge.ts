/**
 * The model-facing tool forge for the orchestration battery.
 *
 * @module @nhtio/adk/batteries/orchestration/forge
 *
 * @remarks
 * This file is the ONLY place the wire↔IR conversion happens, and the ONLY place a model-facing
 * tool is constructed for orchestration. A tool call cannot transmit a class instance, so on the
 * wire a reference is `{$ref: {node, select, path?, branchId?}}` and a template hole is
 * `{$param: {path}}` — single-key wrappers whose keys are RESERVED — and the IR uses real
 * {@link NodeRef}/{@link ParamRef} instances. {@link hydrateRefs} converts wire→IR on the way in
 * and {@link dehydrateRefs} converts IR→wire on the way out, so a model reading a plan back sees
 * the same `$ref`/`$param` shape it writes. Nothing else in the battery ever sees the wire form.
 *
 * Three surfaces, three threat models:
 *
 * - **Tier A — `'front'`**, what a conversational agent sees: `list_templates`,
 *   `instantiate_plan`, `author_plan`. The from-scratch path passes the owner's request VERBATIM
 *   and UNPARSED — pre-parsing their words into categories is what discarded
 *   "at the Holly Springs Walgreens" in the prior art — and every return is RENDERED PROSE, never
 *   raw JSON, because a model that re-reads its own JSON echo tends to re-plan rather than
 *   continue.
 * - **Tier B — `'authoring'`**, graph mechanics, exposed only inside an authoring sub-dispatch:
 *   `create_plan`, `add_node`, `set_node_config`, `connect_nodes`, `remove_node`,
 *   `disconnect_edge`, `clone_plan`, `get_plan`, `validate_plan`, `freeze_plan`,
 *   `unfreeze_plan`, `submit_plan`, `plan_status`, `raw_plan`, `raw_diff`, plus the scoped
 *   reading pair `plan_outline` / `plan_read`.
 * - **Tier C is NOT a tool tier** — it is `runtime.invocable`, the allowlist of what a staged
 *   `call` may invoke. Deliberately separate from the agent's tool surface: adding an agent tool
 *   never adds it here. The allowlist and the registry are the SAME object — the prior art's
 *   worst wart was ten names listed against a registry with zero callers, so author-time
 *   validation passed and fire-time threw "not registered". There is no second list.
 *
 * Mutation tools return SCOPED PROSE, not the whole projected plan. The prior art returned
 * everything so the model always re-read current state; that was written for a large window and
 * is precisely the context problem here — 40 nodes echoed on every edit. Each mutation returns
 * what changed, what it now connects to, and any new issues, BOUNDED regardless of plan size.
 *
 * `submit_plan`/`freeze_plan` call {@link freezePlan} and surface each refusal with its
 * model-addressed message. The prior art's "the dry run produced no finding" refusal is ABSENT —
 * there is no dry run — and the reachability plus unedited-placeholder checks carry the weight it
 * used to.
 */

// This file constructs `Tool`, the documented CONTRIBUTING §13 exception for a battery whose job
// is to mint model-facing tool instances. See CONTRIBUTING.md §13 "Battery design — no concrete
// core-class coupling": `src/batteries/tools/**` and `src/batteries/orchestration/forge.ts` (by
// analogy with `media/forge.ts` and `dispatch_reasoner.ts`) construct `Tool` because a tool
// genuinely IS a core `Tool` instance and there is no lesser-coupled representation. That is why
// this module sits at its own subpath rather than in the battery barrel.
import { renderPlan } from './render'
import { validator } from '@nhtio/validation'
import { NodeRef, ParamRef } from './encoding'
import { rawPlan, rawOps, rawDiff } from './raw'
import { planOutline, planRead } from './outline'
import { freezePlan, collectIssues } from './validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'
import { approvePlan, computeAuthoritySet } from './approval'
import { isObject, isInstanceOf } from '../../lib/utils/guards'
import { runToolGate } from '@nhtio/adk/batteries/tools/_shared'
import { validateTemplate, instantiateTemplate } from './templates'
import type { PlanStore } from './store'
import type { DispatchContext } from '@nhtio/adk/types'
import type { InvocableTools, PredicateEvaluator } from './types'
import type { ToolGateFn } from '@nhtio/adk/batteries/tools/_shared'
import type {
  PlanTemplate,
  PlanOp,
  PlanNode,
  PlanEdge,
  PlanNodeKind,
  EdgeHandle,
  NodeId,
  PlanId,
  PlanIssue,
  AuthorityClaim,
  ApprovalRecord,
  RawPlanView,
  PlanBounds,
  EncodableValue,
  ArgValue,
} from './types'

// ─── the reserved wire keys ──────────────────────────────────────────────────
/** The single reserved wire key for a node-output reference. A wire `{$ref: {...}}` hydrates to a {@link NodeRef}. */
const REF_KEY = '$ref'
/** The single reserved wire key for a template hole. A wire `{$param: {...}}` hydrates to a {@link ParamRef}. */
const PARAM_KEY = '$param'

/** The exact node kinds a plan may carry. Frozen here so the vocabulary a model reads is the vocabulary the fold accepts. */
const NODE_KINDS = [
  'entry',
  'call',
  'reason',
  'transform',
  'branch',
  'select',
  'join',
] as const satisfies readonly PlanNodeKind[]

/** The edge handles a model may write, grouped by the source node kind they apply to — frozen so the grammar is never guessed. */
const HANDLES_BY_KIND: Record<PlanNodeKind, readonly EdgeHandle[]> = {
  entry: ['always'],
  call: ['always', 'error'],
  reason: ['always', 'error'],
  transform: ['always', 'error'],
  branch: ['match', 'no_match', 'default', 'error'],
  select: ['default', 'error'],
  join: ['always', 'error'],
}

/**
 * The graph-grammar vocabulary appended to every relevant tool description, so a model never
 * guesses a node kind, edge handle, or node-kind→handle applicability rule. Generated from the
 * same `NODE_KINDS` / `HANDLES_BY_KIND` tables the fold and freeze enforce, so it cannot drift
 * from either.
 */
const NODE_VOCABULARY = [
  '',
  'NODE GRAMMAR — the only node kinds are: ' + NODE_KINDS.join(', ') + '.',
  'EDGE HANDLES — the handle an edge may carry depends on its source node kind:',
  ...NODE_KINDS.map((k) => `  · ${k} → ${HANDLES_BY_KIND[k].join(' | ')}`),
  'A `select` node requires a `default` edge. On a node settling, every edge whose handle applies',
  'to that outcome fires once; on a FAILURE only `error` edges fire (`always` is a success-path edge,',
  'not a finally). Node ids are snake_case (no `/`, no leading `.`); edge ids match',
  '/^[A-Za-z0-9_-]{1,64}$/. References are written on the wire as {"$ref":{"node","select","path?","branchId?"}}',
  'and template holes as {"$param":{"path"}} — the `$ref`/`$param` keys are reserved.',
].join('\n')

// ─── wire↔IR conversion ──────────────────────────────────────────────────────
/**
 * The wire form of a {@link NodeRef}: a single-key wrapper whose key is the reserved `$ref`.
 *
 * @remarks
 * This is a tool-input shape; it never appears in the IR. {@link hydrateRefs} rebuilds a real
 * {@link NodeRef} instance from it, and {@link dehydrateRefs} emits it from one.
 */
type WireNodeRef = {
  [REF_KEY]: { node: NodeId; select: NodeRef['select']; path?: string; branchId?: unknown }
}
/**
 * The wire form of a {@link ParamRef}: a single-key wrapper whose key is the reserved `$param`.
 */
type WireParamRef = { [PARAM_KEY]: { path: string } }

/** True when `value` is the wire form of a {@link NodeRef} — exactly the one reserved key. */
const isWireNodeRef = (value: unknown): value is WireNodeRef =>
  isObject(value) &&
  Object.keys(value).length === 1 &&
  Object.prototype.hasOwnProperty.call(value, REF_KEY) &&
  isObject((value as Record<string, unknown>)[REF_KEY])

/** True when `value` is the wire form of a {@link ParamRef} — exactly the one reserved key. */
const isWireParamRef = (value: unknown): value is WireParamRef =>
  isObject(value) &&
  Object.keys(value).length === 1 &&
  Object.prototype.hasOwnProperty.call(value, PARAM_KEY) &&
  isObject((value as Record<string, unknown>)[PARAM_KEY])

/**
 * Rebuild a real {@link NodeRef} instance from its wire form, carrying `branchId` through
 * unchanged (it is itself an encodable record on the wire — the IR type is structural).
 */
const hydrateNodeRef = (w: WireNodeRef): NodeRef => {
  const b = w[REF_KEY]
  return new NodeRef(b.node, b.select, b.path, b.branchId as NodeRef['branchId'])
}

/** Rebuild a real {@link ParamRef} instance from its wire form. */
const hydrateParamRef = (w: WireParamRef): ParamRef => new ParamRef(w[PARAM_KEY].path)

/**
 * Recursively convert wire references to IR instances throughout a value.
 *
 * @remarks
 * Walks plain-object/array spines only; every other value (a `Date`, `RegExp`, `Map`, typed
 * array, bigint, …) rides through unchanged, the same distinction `encoding.ts`'s
 * `isPlainObject` makes. A `{$ref:…}` becomes a {@link NodeRef}, a `{$param:…}` becomes a
 * {@link ParamRef}; a plain object that merely LOOKS like a reference but carries extra keys is
 * left alone, because the reserved keys are single-key wrappers by contract.
 *
 * @param value - The wire value to hydrate.
 * @returns The IR value, with references rebuilt as real class instances.
 */
/**
 * True for a PLAIN object — prototype `Object.prototype` or `null`.
 *
 * @remarks
 * The same distinction `ops.ts`'s spine copy and `encoding.ts`'s digest sort already make, and it
 * is here for the same reason: `isObject` is true for `Date`, `Map`, `Set`, `RegExp` and typed
 * arrays, so rebuilding "an object" from `Object.keys` flattens every one of them. A `Date` has no
 * enumerable own keys, so it comes back `{}` — the staged argument is simply gone.
 */
const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const hydrateRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(hydrateRefs)
  if (isWireNodeRef(value)) return hydrateNodeRef(value)
  if (isWireParamRef(value)) return hydrateParamRef(value)
  if (isPlainRecord(value)) {
    // A PLAIN record — rebuild a fresh one so a caller's input is never mutated. The guard must
    // be `isPlainRecord` rather than `isObject`: the latter is true for `Date`/`Map`/`Set`/
    // `RegExp`/typed arrays, and rebuilding those from `Object.keys` returns `{}` — the staged
    // value silently erased on its way into the plan.
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = hydrateRefs(value[key])
    return out
  }
  // Encoder-owned (or primitive) — pass through UNTOUCHED so the encoder can serialise it
  // faithfully and the plan digest stays lossless.
  return value
}

/**
 * Recursively convert IR reference instances back to their wire form throughout a value.
 *
 * @remarks
 * The inverse of {@link hydrateRefs}: a {@link NodeRef} becomes `{$ref:…}`, a {@link ParamRef}
 * becomes `{$param:…}`, and everything else rides through. Used on the way OUT so a model
 * reading a plan back sees the same `$ref`/`$param` shape it writes.
 *
 * @param value - The IR value to dehydrate.
 * @returns The wire value, with references emitted as single-key wrappers.
 */
const dehydrateRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dehydrateRefs)
  if (isInstanceOf(value, 'NodeRef', NodeRef)) {
    const r = value as NodeRef
    return { [REF_KEY]: { node: r.node, select: r.select, path: r.path, branchId: r.branchId } }
  }
  if (isInstanceOf(value, 'ParamRef', ParamRef)) {
    return { [PARAM_KEY]: { path: (value as ParamRef).path } }
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = dehydrateRefs(value[key])
    return out
  }
  // Same rule as the inbound path: an encoder-owned value is handed back as it is. Rebuilding a
  // `Date` or `Map` from `Object.keys` here would show the model `{}` for a value the plan really
  // holds — a plan that reads back differently from what it contains.
  return value
}

// ─── op identity ─────────────────────────────────────────────────────────────
/** Distributive `Omit` over a union. A non-distributive `Omit<PlanOp, …>` collapses the union and
 *  loses every per-variant payload field (`node`/`edge`/`nodeId`/…); this form distributes because
 *  its conditional is over a naked type parameter `T`, which TS distributes over a union when the
 *  alias is instantiated with one. */
type DistributiveOmit<T, K extends keyof T> = T extends any ? Omit<T, K> : never
/** The payload of a `PlanOp` minus its identity keys — a union with one member per op variant. */
type OpBody = DistributiveOmit<PlanOp, 'opId' | 'actorId' | 'lamport' | 'at'>

/**
 * Mint a single authoring op under the forge's actor identity, with a monotonic lamport and a
 * unique op id.
 *
 * @remarks
 * The fold orders ops by `(lamport, actorId, opId)` and applies them last-writer-wins, so each
 * op needs a unique `opId` even at the same lamport. The lamport is seeded from the plan's
 * current revision (`revision + 1`) so a fresh op always sorts after every folded op for this
 * actor — a single-author forge tool is the common case, and the multi-writer CRDT case is the
 * store's concern, not the forge's.
 *
 * The `body` parameter is typed as a generic `T extends PlanOp` so the call site's literal
 * (`{ op: 'add_node', node }`, `{ op: 'remove_edge', edgeId }`, …) is checked against the
 * matching `PlanOp` union member directly. A non-generic `Omit<PlanOp, 'opId'|…>` parameter would
 * collapse the union and reject every payload field (`node`/`edge`/`nodeId`/…), so the op body
 * could not be expressed as a literal at all.
 *
 * @param store - The plan store holding the plan (unused at the mint site; kept for symmetry
 *   with the read helpers and so a subclass could override).
 * @param planId - The plan to append to.
 * @param actorId - The identity under which the op is authored.
 * @param revision - The plan's current revision, used to seed the lamport.
 * @param body - The op payload (everything except `opId`/`actorId`/`lamport`/`at`).
 * @returns The minted op.
 */
const mintOp = (
  store: PlanStore,
  planId: PlanId,
  actorId: string,
  revision: number,
  body: OpBody
): PlanOp => {
  void store
  void planId
  const lamport = revision + 1
  const opId = `${actorId}:${planId}:${lamport}:${crypto.randomUUID()}`
  return {
    opId,
    actorId,
    lamport,
    at: new Date().toISOString(),
    ...body,
  } as unknown as PlanOp
}

/**
 * Read the plan's current revision (the number of folded ops), seeding op lamports from it.
 *
 * @remarks
 * A fresh plan is at revision 0; the first authoring op makes revision 1. Used so each minted op
 * sorts after every folded op for this actor.
 */
const currentRevision = async (store: PlanStore, planId: PlanId): Promise<number> => {
  const state = await store.readState(planId)
  return state.revision
}

// ─── prose helpers ───────────────────────────────────────────────────────────
/** Render a plan as model-audience, as-planned prose. */
const renderModel = (view: RawPlanView): string =>
  renderPlan(view, { audience: 'model', view: 'as_planned' })

/** Render a plan as operator-audience, as-planned prose — the approval-gate view. */
const renderOperator = (view: RawPlanView): string =>
  renderPlan(view, { audience: 'operator', view: 'as_planned' })

/** Format a non-empty issue list as prose; an empty list yields a clean confirmation line. */
const renderIssues = (issues: readonly PlanIssue[]): string => {
  if (issues.length === 0) return 'No issues.'
  const lines = issues.map((i) => {
    const where = i.nodeId ? ` [node ${i.nodeId}]` : i.edgeId ? ` [edge ${i.edgeId}]` : ''
    return `  · (${i.severity}) ${i.code}${where}: ${i.message}`
  })
  return `Issues (${issues.length}):\n${lines.join('\n')}`
}

/**
 * Render a BOUNDED slice of a plan around a focal node id, plus its immediate neighbours and any
 * new issues — the scoped-prose return shape every mutation tool uses.
 *
 * @remarks
 * The prior art returned the whole projected plan on every edit so the model always re-read
 * current state; that was written for a large window and is precisely the context problem here.
 * This returns the focal node's slice (via the outline reader's self-locating slice), its
 * immediate predecessors and successors, and the plan's issues — BOUNDED regardless of plan size.
 *
 * @param store - The plan store holding the plan.
 * @param planId - The plan to read.
 * @param focal - The node id the edit touched, if any. Omitted renders the outline plus issues.
 * @returns The scoped prose.
 */
const renderScoped = async (store: PlanStore, planId: PlanId, focal?: NodeId): Promise<string> => {
  if (focal !== undefined) {
    try {
      const slice = await planRead(store, planId, { node: focal })
      const view = await rawPlan(store, planId)
      const head = `Plan ${planId} (rev ${view.revision}) — changed node ${focal}.`
      const neighbours =
        `Predecessors: ${slice.boundary.incoming.join(', ') || '(none)'}. ` +
        `Successors: ${slice.boundary.outgoing.join(', ') || '(none)'}.`
      const body = renderModel({ ...view, nodes: slice.nodes })
      return [head, neighbours, body, renderIssues(slice.issues)].join('\n\n')
    } catch {
      // The focal node is no longer present (a removal, or a rename in the same op batch) — fall
      // through to the outline view, which is always well-defined.
    }
  }
  const outline = await planOutline(store, planId)
  const view = await rawPlan(store, planId)
  const head = `Plan ${planId} (rev ${view.revision}, ${outline.nodeCount} node(s)).`
  const phases = outline.phases
    .concat(outline.unphased ? [outline.unphased] : [])
    .map((p) => `  · ${p.phase || '(unphased)'}: ${p.summary} [${p.nodeIds.join(', ')}]`)
    .join('\n')
  return [head, phases, renderIssues(view.digest ? [] : [])].join('\n\n')
}

// ─── schemas ─────────────────────────────────────────────────────────────────
/** A declared-field schema (the entry/call/transform `output` and entry `input` element shape). */
const declaredFieldSchema = validator.alternatives(
  validator
    .object({
      path: validator.string().required(),
      type: validator.string().valid('string').required(),
      maxBytes: validator.number().integer().min(1).optional(),
    })
    .unknown(false),
  validator
    .object({
      path: validator.string().required(),
      type: validator.string().valid('number').required(),
    })
    .unknown(false),
  validator
    .object({
      path: validator.string().required(),
      type: validator.string().valid('boolean').required(),
    })
    .unknown(false),
  validator
    .object({
      path: validator.string().required(),
      type: validator.string().valid('enum').required(),
      values: validator.array().items(validator.string().required()).min(1).required(),
    })
    .unknown(false)
)

/**
 * A schema for an open staged-value field — `args`, `predicate`, a transform step's `args`, or a
 * prompt part's value — where the value may hold a `NodeRef`/`ParamRef` (on the wire, a
 * `{$ref}`/`{$param}` wrapper) and the closed-shape check is freeze's job, not the schema's.
 *
 * @remarks
 * The `adk/require-validator-any-required` rule is satisfied by `.required()`: a staged value must
 * be present, and its internal shape is validated at freeze against the node kind's contract.
 */

const openValueSchema = validator.any().required()

/** A `PromptPart[]` schema: each item is `{text}` or a `{$ref}` wrapper (the wire form of a `NodeRef`). */
const promptPartsSchema = validator
  .array()
  .items(
    validator.alternatives(
      validator.object({ text: validator.string().required() }).unknown(false).required(),

      validator
        .object()
        .pattern(new RegExp(`^${REF_KEY}$`), validator.object().unknown(true).required())
        .unknown(false)
        .required()
    )
  )
  .required()

/** The seven exact node-definition schemas, keyed by kind, composed into the closed alternatives. */
const nodeDefinitionSchemas: Record<PlanNodeKind, ReturnType<typeof validator.any>> = {
  entry: validator
    .object({ input: validator.array().items(declaredFieldSchema).required() })
    .unknown(false)
    .required(),
  call: validator
    .object({
      tool: validator.string().required(),
      args: validator.object().unknown(true).required(),
      output: validator.array().items(declaredFieldSchema).required(),
      onMissingValue: validator.string().valid('fail', 'omit').required(),
      authority: validator
        .array()
        .items(
          validator
            .object({
              capability: validator.string().required(),
              scope: validator.string().required(),
              verb: validator
                .string()
                .valid('list', 'read', 'create', 'update', 'delete')
                .required(),
            })
            .unknown(false)
            .required()
        )
        .required(),
      replaySafe: validator.boolean().required(),
      onIndeterminate: validator.string().valid('retry', 'halt', 'skip').required(),
      declassifies: validator.array().items(validator.string().required()).optional(),
    })
    .unknown(false)
    .required(),
  reason: validator
    .object({
      prompt: promptPartsSchema,
      outputSchema: validator.string().required(),
      maxAttempts: validator.number().integer().min(1).required(),
    })
    .unknown(false)
    .required(),
  transform: validator
    .object({
      source: validator
        .object()
        .pattern(new RegExp(`^${REF_KEY}$`), validator.object().unknown(true).required())
        .unknown(false)
        .required(),
      steps: validator
        .array()
        .items(
          validator
            .object({
              name: validator.string().required(),
              args: validator.object().unknown(true).optional(),
            })
            .unknown(false)
            .required()
        )
        .required(),
      emit: validator
        .alternatives(
          validator
            .object({
              as: validator.string().valid('value').required(),
              field: validator.string().required(),
            })
            .unknown(false)
            .required(),
          validator
            .object({ as: validator.string().valid('rows').required() })
            .unknown(false)
            .required()
        )
        .required(),
      output: validator.array().items(declaredFieldSchema).required(),
    })
    .unknown(false)
    .required(),
  branch: validator
    .object({
      evaluator: validator.string().required(),
      predicate: openValueSchema,
    })
    .unknown(false)
    .required(),
  select: validator
    .object({
      evaluator: validator.string().required(),
      predicate: openValueSchema,
      cases: validator.array().items(validator.string().required()).required(),
    })
    .unknown(false)
    .required(),
  join: validator
    .object({ kind: validator.string().valid('diamond').optional() })
    .unknown(false)
    .required(),
}

/**
 * The CLOSED ALTERNATIVES schema for `set_node_config`'s `definition`: a node definition can only
 * be one of the seven exact node shapes, and unknown keys per kind are rejected (`.unknown(false)`
 * on every branch). The `kind` discriminator is required and closed over `NODE_KINDS`.
 */
const nodeDefinitionAlternatives = validator.alternatives(
  ...NODE_KINDS.map((kind) =>
    validator
      .object({
        kind: validator.string().valid(kind).required(),
        definition: nodeDefinitionSchemas[kind],
      })
      .unknown(false)
  )
)

/** A whole `PlanNode` schema: id, optional phase, and the closed kind/definition alternatives. */
const planNodeSchema = validator
  .object({
    id: validator
      .string()
      .pattern(/^[a-z0-9_]+$/)
      .required(),
    phase: validator.string().optional(),
    kind: validator
      .string()
      .valid(...NODE_KINDS)
      .required(),
    definition: validator.any().required(),
  })
  .unknown(false)

/** A `PlanEdge` schema with the edge-id charset rule freeze enforces. */
const planEdgeSchema = validator.object({
  id: validator
    .string()
    .pattern(/^[A-Za-z0-9_-]{1,64}$/)
    .required(),
  from: validator.string().required(),
  to: validator.string().required(),
  handle: validator.string().required(),
})

// ─── the forge ───────────────────────────────────────────────────────────────
/** The runtime a forge call is handed: the store, the tier-C allowlist, the wired predicate cells, and any registered templates. */
export interface ForgeOrchestrationRuntime {
  /** The plan store all tools read and mutate. */
  store: PlanStore
  /** The tier-C allowlist a staged `call` may invoke — the SAME object the tool registry is, never a second list. */
  invocable: InvocableTools
  /** The wired predicate cells; a needed-but-absent cell refuses at freeze. */
  evaluators: PredicateEvaluator[]
  /** Consumer-defined plan shapes a model can instantiate. */
  templates?: PlanTemplate[]
  /** The identity under which minted ops are authored. */
  actorId: string
}

/** Tier selection and optional per-tool overrides + a mutating-tool gate. */
export interface ForgeOrchestrationOptions {
  /** `'front'` for the conversational surface, `'authoring'` for the graph-mechanics surface. */
  tier: 'front' | 'authoring'
  /** Optional names and descriptions keyed by their default tool name. */
  overrides?: Record<string, { name?: string; description?: string }>
  /** Optional gate run before any MUTATING tool executes. Throwing aborts the call. */
  gate?: ToolGateFn
}

/**
 * Forge the model-facing orchestration tools for a configured runtime and tier.
 *
 * @remarks
 * Returns a `Record<string, Tool>` keyed by the (post-override) tool name. Tier A (`'front'`)
 * yields the three conversational tools; tier B (`'authoring'`) yields the graph-mechanics tools.
 * Tier C is `runtime.invocable`, not a tool tier, and is the SAME object the tool registry is.
 *
 * Where a `gate` is supplied it is run via {@link runToolGate} before any MUTATING tool executes;
 * read-only tools are not gated. The wire↔IR conversion ({@link hydrateRefs}/
 * {@link dehydrateRefs}) happens inside this function and nowhere else.
 *
 * @param runtime - The store, tier-C allowlist, predicate cells, templates, and actor identity.
 * @param options - Tier, per-tool overrides, and an optional mutating-tool gate.
 * @returns The forged tools, keyed by name.
 */
export function forgeOrchestrationTools(
  runtime: ForgeOrchestrationRuntime,
  options: ForgeOrchestrationOptions
): Record<string, Tool> {
  const { store, invocable, evaluators, templates, actorId } = runtime
  const { tier, overrides, gate } = options
  const tools: Record<string, Tool> = {}

  /**
   * Register a tool under its default name, applying any override and appending the
   * {@link NODE_VOCABULARY} to the description so the graph grammar is never guessed.
   */
  const make = (
    defaultName: string,
    description: string,
    schema: ReturnType<typeof validator.object> | ReturnType<typeof validator.any>,
    handler: (args: Record<string, unknown>, context: DispatchContext) => Promise<string>,
    mutating: boolean
  ): void => {
    const override = overrides?.[defaultName]
    const name = override?.name ?? defaultName
    const doc = `${description}${NODE_VOCABULARY}`
    const tool = new Tool({
      name,
      description: override?.description ?? doc,
      inputSchema: schema,
      artifactConstructor: () => SpooledJsonArtifact,
      handler: async (args, context) => {
        if (mutating && gate) {
          await runToolGate(gate, context, name, args)
        }
        return handler(args as Record<string, unknown>, context as DispatchContext)
      },
    })
    tools[name] = tool
  }

  // ─── Tier A: front ────────────────────────────────────────────────────────
  if (tier === 'front') {
    make(
      'list_templates',
      'List the registered plan templates — id, one-line summary, and declared params for each. ' +
        'Cheap and always safe; the natural first move for "is there already a shape for this?".',
      validator.object({}).unknown(false),
      async () => {
        const list = templates ?? []
        if (list.length === 0) {
          return 'No plan templates are registered. Use author_plan to build a plan from scratch.'
        }
        const lines = list.map((tpl) => {
          const params = tpl.params
            .map(
              (p) => `${p.path}: ${p.type}${p.type === 'enum' ? ` (${p.values.join('|')})` : ''}`
            )
            .join(', ')
          return `  · ${tpl.id} — ${tpl.summary}\n    params: ${params || '(none)'}`
        })
        return `Templates (${list.length}):\n${lines.join('\n')}`
      },
      false
    )

    make(
      'instantiate_plan',
      'Mint an editable plan from a registered template by filling its declared params. ' +
        'Returns the RENDERED PROSE of what it created plus any non-fatal issues; never raw JSON.',
      validator
        .object({
          template: validator.string().required(),
          args: validator.object().unknown(true).required(),
        })
        .unknown(false),
      async (args) => {
        const tplId = args.template as string
        const list = templates ?? []
        const tpl = list.find((t) => t.id === tplId)
        if (!tpl) {
          const available = list.map((t) => t.id).join(', ')
          return `Unknown template ${JSON.stringify(tplId)}. Registered templates: ${
            available || '(none)'
          }.`
        }
        // Validate the template against the live tier-C allowlist before instantiating, so an
        // unknown-tool refusal surfaces here rather than at freeze.
        const templateIssues = validateTemplate(tpl, invocable)
        if (templateIssues.some((i) => i.severity === 'blocking')) {
          return `Template ${JSON.stringify(tplId)} is not valid against the current tool allowlist:\n${renderIssues(
            templateIssues
          )}`
        }
        // The args map's values may hold wire references; hydrate them to IR before substitution.
        const hydratedArgs = hydrateRefs(args.args) as Record<string, EncodableValue>
        const result = await instantiateTemplate(store, tpl, hydratedArgs, actorId)
        if (!result.ok) {
          return `Could not instantiate template ${JSON.stringify(tplId)}: ${result.reason} — ${result.detail}`
        }
        const view = await rawPlan(store, result.planId)
        const head = `Instantiated plan ${result.planId} from template ${JSON.stringify(tplId)}.`
        return [head, renderModel(view), renderIssues(result.issues)].join('\n\n')
      },
      true
    )

    make(
      'author_plan',
      'Author a new plan from scratch from a natural-language request. Pass `request` VERBATIM and ' +
        'UNPARSED — do not pre-categorise the owner’s words; the authoring layer parses them. Returns ' +
        'rendered prose of what was created, never raw JSON.',
      validator
        .object({
          request: validator.string().required(),
          detail: validator.string().optional(),
        })
        .unknown(false),
      async (args) => {
        // The request is passed VERBATIM and UNPARSED. Pre-parsing the owner's words into
        // categories is what discarded "at the Holly Springs Walgreens" in the prior art, so this
        // tool does not parse them — it mints an empty editable plan and hands the request to the
        // authoring layer (tier B), which a sub-dispatch drives. The plan id is returned so the
        // caller can continue with the tier-B tools.
        const request = args.request as string
        const planId = `plan-${crypto.randomUUID()}`
        const created = await store.createPlan(planId, { label: request.slice(0, 80) })
        if (!created.ok) {
          return `Could not create a plan (${created.reason}).`
        }
        const view = await rawPlan(store, planId)
        const head =
          `Created empty plan ${planId} (editable). Hand the request to the authoring tools ` +
          `(create_plan/add_node/…/set_node_config) to build it out. Request, verbatim:\n"${request}"`
        return [head, renderModel(view)].join('\n\n')
      },
      true
    )
    return tools
  }

  // ─── Tier B: authoring ────────────────────────────────────────────────────
  // The graph-mechanics surface, exposed only inside an authoring sub-dispatch. Each mutation
  // returns SCOPED PROSE (what changed, what it now connects to, any new issues), BOUNDED
  // regardless of plan size — never the whole projected plan.

  make(
    'create_plan',
    'Mint a fresh empty editable plan. Returns rendered prose of the (empty) plan and its id.',
    validator
      .object({
        planId: validator
          .string()
          .pattern(/^plan-[A-Za-z0-9_-]+$/)
          .optional(),
        label: validator.string().optional(),
      })
      .unknown(false),
    async (args) => {
      const id = (args.planId as string | undefined) ?? `plan-${crypto.randomUUID()}`
      const created = await store.createPlan(id, { label: args.label as string | undefined })
      if (!created.ok) {
        return `Could not create plan ${JSON.stringify(id)} (${created.reason}).`
      }
      const view = await rawPlan(store, id)
      return [`Created plan ${id} (editable, rev 0).`, renderModel(view)].join('\n\n')
    },
    true
  )

  make(
    'add_node',
    'Add a node to an editable plan. The node kind must be one of the seven exact shapes; unknown ' +
      'keys per kind are rejected. Returns scoped prose around the new node.',
    validator
      .object({
        planId: validator.string().required(),
        node: planNodeSchema.required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const rawNode = args.node as PlanNode
      // Rebuild the node with hydrated references and a closed kind/definition pair.
      const kind = rawNode.kind as PlanNodeKind
      if (!NODE_KINDS.includes(kind)) {
        return `Unknown node kind ${JSON.stringify(kind)}; valid kinds are ${NODE_KINDS.join(', ')}.`
      }
      const node = {
        id: rawNode.id,
        ...(rawNode.phase !== undefined ? { phase: rawNode.phase } : {}),
        kind,
        definition: hydrateRefs(rawNode.definition) as PlanNode['definition'],
      } as PlanNode
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'add_node', node })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not add node ${JSON.stringify(node.id)} to ${planId} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, node.id)
    },
    true
  )

  make(
    'set_node_config',
    'Replace a node’s whole definition. Takes a CLOSED ALTERNATIVES schema: a definition can only ' +
      'be one of the seven exact node shapes, unknown keys per kind rejected. Returns scoped prose ' +
      'around the changed node.',
    validator
      .object({
        planId: validator.string().required(),
        nodeId: validator.string().required(),
        definition: nodeDefinitionAlternatives.required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const nodeId = args.nodeId as NodeId
      const def = args.definition as { kind: PlanNodeKind; definition: PlanNode['definition'] }
      const definition = hydrateRefs(def.definition) as PlanNode['definition']
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, {
        op: 'set_node_definition',
        nodeId,
        definition,
      })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not set config for node ${JSON.stringify(nodeId)} on ${planId} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, nodeId)
    },
    true
  )

  make(
    'set_node_field',
    'Set a single dot-path field within a node’s definition. The value may hold references on the ' +
      'wire as {"$ref":…}/{"$param":…}. Returns scoped prose around the changed node.',
    validator
      .object({
        planId: validator.string().required(),
        nodeId: validator.string().required(),
        path: validator.string().required(),
        value: openValueSchema,
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const nodeId = args.nodeId as NodeId
      const path = args.path as string
      const value = hydrateRefs(args.value) as ArgValue
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'set_node_field', nodeId, path, value })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not set field ${JSON.stringify(path)} on node ${JSON.stringify(nodeId)} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, nodeId)
    },
    true
  )

  make(
    'set_node_phase',
    'Set, change, or clear a node’s phase label. `phase: null` clears it. Phases group nodes for ' +
      'reading and rendering only; they have no execution meaning. Returns scoped prose.',
    validator
      .object({
        planId: validator.string().required(),
        nodeId: validator.string().required(),
        phase: validator
          .alternatives(validator.string(), validator.any().valid(null).required())
          .required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const nodeId = args.nodeId as NodeId
      const phase = (args.phase ?? null) as string | null
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'set_node_phase', nodeId, phase })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not set phase for node ${JSON.stringify(nodeId)} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, nodeId)
    },
    true
  )

  make(
    'connect_nodes',
    'Add an edge between two nodes. The handle must apply to the source node’s kind. Returns scoped ' +
      'prose around the source node.',
    validator
      .object({
        planId: validator.string().required(),
        edge: planEdgeSchema.required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const edge = args.edge as PlanEdge
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'add_edge', edge })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not add edge ${JSON.stringify(edge.id)} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, edge.from)
    },
    true
  )

  make(
    'remove_node',
    'Remove a node and its incident edges from an editable plan. Returns scoped prose (the outline, ' +
      'since the focal node is gone).',
    validator
      .object({
        planId: validator.string().required(),
        nodeId: validator.string().required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const nodeId = args.nodeId as NodeId
      // Compute the incident edge ids BEFORE removal so the op is order-independent (the fold
      // uses them to cascade removal without a second read).
      const view = await rawPlan(store, planId)
      const incident = view.edges
        .filter((e) => e.from === nodeId || e.to === nodeId)
        .map((e) => e.id)
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, {
        op: 'remove_node',
        nodeId,
        incidentEdgeIds: incident,
      })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not remove node ${JSON.stringify(nodeId)} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId)
    },
    true
  )

  make(
    'disconnect_edge',
    'Remove a single edge from an editable plan. Returns scoped prose around the edge’s source node.',
    validator
      .object({
        planId: validator.string().required(),
        edgeId: validator.string().required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const edgeId = args.edgeId as string
      const view = await rawPlan(store, planId)
      const edge = view.edges.find((e) => e.id === edgeId)
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'remove_edge', edgeId })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not remove edge ${JSON.stringify(edgeId)} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId, edge?.from)
    },
    true
  )

  make(
    'set_bounds',
    'Override the plan’s bounds (the fold seed is DEFAULT_PLAN_BOUNDS; this op overrides it by LWW). ' +
      'All members are required so an override is total and cannot half-specify. Returns scoped prose.',
    validator
      .object({
        planId: validator.string().required(),
        bounds: validator
          .object({
            maxNodes: validator.number().integer().min(1).required(),
            maxEdges: validator.number().integer().min(1).required(),
            maxSteps: validator.number().integer().min(1).required(),
            maxConcurrentFrames: validator.number().integer().min(1).required(),
            maxEncodedBytes: validator.number().integer().min(1).required(),
          })
          .unknown(false)
          .required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const bounds = args.bounds as PlanBounds
      const rev = await currentRevision(store, planId)
      const op = mintOp(store, planId, actorId, rev, { op: 'set_bounds', bounds })
      const appended = await store.appendOps(planId, [op])
      if (!appended.ok) {
        return `Could not set bounds on ${planId} (${appended.reason}; actual state ${appended.actual.state} rev ${appended.actual.revision}).`
      }
      return renderScoped(store, planId)
    },
    true
  )

  make(
    'clone_plan',
    'Clone a plan into a fresh editable id, seeded with the source’s folded state at a revision. ' +
      'Inherits no approval and no run. Returns scoped prose of the clone.',
    validator
      .object({
        sourcePlanId: validator.string().required(),
        newPlanId: validator
          .string()
          .pattern(/^plan-[A-Za-z0-9_-]+$/)
          .required(),
        atRevision: validator.number().integer().min(0).optional(),
      })
      .unknown(false),
    async (args) => {
      const sourcePlanId = args.sourcePlanId as string
      const newPlanId = args.newPlanId as string
      const atRevision = args.atRevision as number | undefined
      const cloned = await store.clonePlan(sourcePlanId, newPlanId, atRevision)
      if (!cloned.ok) {
        return `Could not clone ${sourcePlanId} → ${newPlanId} (${cloned.reason}).`
      }
      return renderScoped(store, newPlanId)
    },
    true
  )

  make(
    'get_plan',
    'Read a plan’s full rendered prose. With no argument, returns everything — scoped reading is ' +
      'available via plan_outline/plan_read, not mandatory.',
    validator
      .object({
        planId: validator.string().required(),
        audience: validator.string().valid('model', 'operator').optional(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const audience = (args.audience as 'model' | 'operator' | undefined) ?? 'model'
      const view = await rawPlan(store, planId)
      const body = audience === 'operator' ? renderOperator(view) : renderModel(view)
      return [`Plan ${planId} (rev ${view.revision}, ${view.nodes.length} node(s)).`, body].join(
        '\n\n'
      )
    },
    false
  )

  make(
    'validate_plan',
    'Run the freeze-time checks against a plan WITHOUT freezing it. Surfaces every issue the graph ' +
      'raises, blocking and advisory. No dry run exists; reachability and placeholder checks carry ' +
      'the weight a dry run used to.',
    validator.object({ planId: validator.string().required() }).unknown(false),
    async (args) => {
      const planId = args.planId as string
      const view = await rawPlan(store, planId)
      const issues = await collectIssues(view, { invocable, evaluators })
      return [`Validation of ${planId} (rev ${view.revision}).`, renderIssues(issues)].join('\n\n')
    },
    false
  )

  make(
    'freeze_plan',
    'Freeze an editable plan into reviewable. Runs the freeze checks and, only on a clean pass, ' +
      'commits the editable→reviewable transition. Each refusal is surfaced with its model-addressed ' +
      'message. There is no dry run.',
    validator.object({ planId: validator.string().required() }).unknown(false),
    async (args) => {
      const planId = args.planId as string
      const result = await freezePlan(store, planId, { invocable, evaluators })
      const head = result.ok
        ? `Plan ${planId} is now reviewable.`
        : `Plan ${planId} could not be frozen.`
      return [head, renderIssues(result.issues)].join('\n\n')
    },
    true
  )

  make(
    'unfreeze_plan',
    'Return a reviewable plan to editable. Free re-entry; no approval is carried. Returns scoped prose.',
    validator.object({ planId: validator.string().required() }).unknown(false),
    async (args) => {
      const planId = args.planId as string
      const state = await store.readState(planId)
      if (state.state !== 'reviewable') {
        return `Plan ${planId} is in state ${state.state}, not reviewable; only reviewable plans can be unfrozen.`
      }
      const transition = await store.transition(planId, {
        from: 'reviewable',
        to: 'editable',
        expectedDigest: state.digest,
      })
      if (!transition.ok) {
        const detail =
          transition.reason === 'illegal_transition'
            ? `${transition.from}→${transition.to}`
            : `${transition.actual.state}`
        return `Could not unfreeze ${planId} (${transition.reason}; ${detail}).`
      }
      return renderScoped(store, planId)
    },
    true
  )

  make(
    'submit_plan',
    'Freeze a plan and then approve it, moving it all the way to executable. The authority set is ' +
      'recomputed over the reachable workflow and must match the supplied decision exactly. Each ' +
      'refusal is surfaced with its model-addressed message. No dry run.',
    validator
      .object({
        planId: validator.string().required(),
        decidedBy: validator.string().required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const decidedBy = args.decidedBy as string
      // 1. Freeze.
      const frozen = await freezePlan(store, planId, { invocable, evaluators })
      if (!frozen.ok) {
        return [`Could not freeze ${planId} for submission.`, renderIssues(frozen.issues)].join(
          '\n\n'
        )
      }
      // 2. Recompute the reachable authority set and approve against it.
      const view = await rawPlan(store, planId)
      const authoritySet = computeAuthoritySet(view) as AuthorityClaim[]
      const record: ApprovalRecord = {
        planId,
        digest: view.digest,
        authoritySet,
        decidedBy,
        decidedAt: new Date().toISOString(),
        disposition: 'approved',
      }
      const approved = await approvePlan(store, planId, record)
      if (!approved.ok) {
        const detail =
          approved.reason === 'illegal_transition'
            ? `${approved.from}→${approved.to}`
            : `${approved.actual.state}`
        return `Plan ${planId} was frozen but could not be approved (${approved.reason}; ${detail}).`
      }
      return [
        `Plan ${planId} is now executable.`,
        `Authority set (${authoritySet.length} claim(s)):`,
        ...authoritySet.map((c) => `  · ${c.capability} / ${c.scope} / ${c.verb}`),
      ].join('\n')
    },
    true
  )

  make(
    'plan_status',
    'Read a plan’s lifecycle state, digest, and revision NOW. Lifecycle state is not an op and cannot ' +
      'be folded from the log, so it is read from the store directly.',
    validator.object({ planId: validator.string().required() }).unknown(false),
    async (args) => {
      const planId = args.planId as string
      const state = await store.readState(planId)
      return `Plan ${planId}: state=${state.state}, rev=${state.revision}, digest=${state.digest}.`
    },
    false
  )

  make(
    'raw_plan',
    'Read the machine-readable folded content of a plan, optionally at a historical revision. This ' +
      'is the data view (no narrative, no trust framing), for a UI or a model that wants exact state. ' +
      'References are emitted in their wire form ($ref/$param).',
    validator
      .object({
        planId: validator.string().required(),
        revision: validator.number().integer().min(0).optional(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const view = await rawPlan(store, planId, {
        revision: args.revision as number | undefined,
      })
      return JSON.stringify(dehydrateRefs(view), null, 2)
    },
    false
  )

  make(
    'raw_diff',
    'A STRUCTURAL delta between two folded states of a plan (`a` and `b`, each a revision number or ' +
      '“current”). A node edited and then reverted across the span produces no row. References are ' +
      'emitted in their wire form ($ref/$param).',
    validator
      .object({
        planId: validator.string().required(),
        a: validator
          .alternatives(validator.number().integer().min(0), validator.string().valid('current'))
          .required(),
        b: validator
          .alternatives(validator.number().integer().min(0), validator.string().valid('current'))
          .required(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const a = args.a as number | 'current'
      const b = args.b as number | 'current'
      const diff = await rawDiff(store, planId, a, b)
      return JSON.stringify(dehydrateRefs(diff), null, 2)
    },
    false
  )

  make(
    'raw_ops',
    'Read the plan’s raw op log, optionally filtered by Lamport clock or a revision prefix. The op ' +
      'log is the source of truth the fold reads.',
    validator
      .object({
        planId: validator.string().required(),
        sinceLamport: validator.number().integer().min(0).optional(),
        throughRevision: validator.number().integer().min(0).optional(),
      })
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const ops = await rawOps(store, planId, {
        sinceLamport: args.sinceLamport as number | undefined,
        throughRevision: args.throughRevision as number | undefined,
      })
      return JSON.stringify(dehydrateRefs(ops), null, 2)
    },
    false
  )

  // ─── scoped reading pair ──────────────────────────────────────────────────
  // `plan_outline` takes no argument (no enum needed). `plan_read` takes a phase name or node id
  // that must be present in the LIVE plan: the closed-enum check runs at call time against the
  // live graph (the schema cannot close over a mutable graph, and the store is async), and a
  // stale or invented id throws naming the valid set — a schema-shaped error, never an empty
  // result a model might surface as an answer.
  make(
    'plan_outline',
    'Build a flat outline of a plan: one entry per phase plus a single entry for unphased nodes. ' +
      'Each entry carries the EXACT node ids and tool names a model cites back. ONE flat level, never two.',
    validator.object({ planId: validator.string().required() }).unknown(false),
    async (args) => {
      const planId = args.planId as string
      const outline = await planOutline(store, planId)
      const phases = outline.phases
        .concat(outline.unphased ? [outline.unphased] : [])
        .map((p) => {
          const toolList = p.tools.length > 0 ? ` tools: ${p.tools.join(', ')}` : ''
          return `  · ${p.phase || '(unphased)'} [${p.nodeIds.join(', ')}]${toolList} — ${p.summary} (${p.issueCount} issue(s))`
        })
        .join('\n')
      return [
        `Outline of ${planId} (state ${outline.state}, ${outline.nodeCount} node(s), digest ${outline.digest}).`,
        phases || '(no nodes)',
      ].join('\n')
    },
    false
  )

  make(
    'plan_read',
    'Read a self-locating slice of a plan by the exact identifier the outline printed: `{phase}` for a ' +
      'whole phase or `{node}` for the slice around a single node. A stale or invented id is rejected ' +
      'naming the valid set, never returned as an empty slice.',
    validator
      .object({
        planId: validator.string().required(),
        phase: validator.string().optional(),
        node: validator.string().optional(),
      })
      .xor('phase', 'node')
      .unknown(false),
    async (args) => {
      const planId = args.planId as string
      const sel =
        args.phase !== undefined ? { phase: args.phase as string } : { node: args.node as NodeId }
      // planRead throws naming the valid set when the id is unknown — the closed-enum check
      // against the live plan, surfaced as a tool error rather than an empty result.
      const slice = await planRead(store, planId, sel)
      const view = await rawPlan(store, planId)
      const where = slice.phase
        ? `phase ${JSON.stringify(slice.phase)}`
        : `node ${JSON.stringify((slice.nodes[0] ?? { id: '?' }).id)}`
      const head = `Slice of ${planId} around ${where}. Predecessors: ${
        slice.boundary.incoming.join(', ') || '(none)'
      }; successors: ${slice.boundary.outgoing.join(', ') || '(none)'}.`
      return [head, renderModel({ ...view, nodes: slice.nodes }), renderIssues(slice.issues)].join(
        '\n\n'
      )
    },
    false
  )

  return tools
}
