/**
 * The orchestration battery's shared type contracts — the normative source for every type more
 * than one part of the battery touches.
 *
 * @module @nhtio/adk/batteries/orchestration/types
 *
 * @remarks
 * A type belongs here when two or more modules read or write it. Anything with no dependents —
 * a cell's internal AST, the in-memory store's private index, a renderer's line-wrapping helper
 * — is deliberately left to its implementation rather than fixed here.
 *
 * Two conventions in this file are load-bearing and easy to undo by accident. Discrimination is
 * by CLASS, not by a `kind` field: `NodeRef` and `ParamRef` are registered encoder classes whose
 * `is*` guards are `instanceof` checks, because a plain record can wear `{kind: 'nodeRef'}` and a
 * resolver keying on that would silently rewrite a literal. And `EncodableValue` is a deliberate
 * SUBSET of the encoder's own `Encodable` — it omits `Function`, `Error` and consumer-defined
 * custom classes, so a staged argument cannot carry a closure that serialises by source text or
 * a class the battery cannot register on the consumer's behalf.
 */
import type { renderPlan } from './render'
import type { planOutline } from './outline'
import type { Tool } from '@nhtio/adk/common'
import type { PlanLockFactory } from './locks'
import type { NodeRef, ParamRef } from './encoding'
import type { rawPlan, rawOps, rawDiff } from './raw'
import type { DateTime, Duration, Interval } from 'luxon'
import type { PlanStore, TransitionResult } from './store'
import type { ObjectSchema, Schema } from '@nhtio/validation'

// ── identity and lifecycle ───────────────────────────────────────────────────
/**
 * The three lifecycle states, in the only order they may be traversed.
 *
 * @remarks
 * The permission gate IS the `reviewable → executable` transition, which is what makes "approved"
 * and "executable" one fact rather than two that can disagree. `editable` admits free mutation;
 * `reviewable` is frozen content awaiting a decision; `executable` is approved and may run at most
 * once. There is no path back — recovery from a spent or rejected plan is `clonePlan`, which mints
 * a fresh `editable` plan.
 */
export type PlanState = 'editable' | 'reviewable' | 'executable'
/** A plan's stable identity, unique per store and never reused across a clone. */
export type PlanId = string
/**
 * A node's identity within one plan. Validated snake_case with no `/` and no leading `.`, so it can
 * never be mistaken for a path or copied as a citation.
 */
export type NodeId = string

// ── the value domain ────────────────────────────────────────────────────────
/**
 * The value space of a staged argument and of a node's output: a DELIBERATE SUBSET of
 * `@nhtio/encoder`'s `Encodable`, declared structurally here rather than re-exported.
 *
 * Why a subset. The encoder's own `Encodable`
 * (`nhtio-encoder/src/private/types.ts:46-69`) also admits `Error` and its subclasses,
 * `PhoneModel`, `Function`, arbitrary call signatures, and `CustomEncodable`. Re-exporting it
 * would (a) let a live function into a staged tool argument — the encoder serialises functions by
 * SOURCE TEXT, so closures silently lose their bindings, and a plan is exactly the wrong place
 * for that; (b) admit consumer-defined `CustomEncodable` classes whose decode requires
 * `registerClass` calls this battery cannot make on the consumer's behalf, so a plan could
 * encode successfully and then fail hydration; and (c) undermine `predicate: EncodableValue`,
 * which is meant to exclude live evaluator objects by domain.
 *
 * The subset below is closed, digest-safe, and hydratable with only
 * `registerOrchestrationEncodables()`:
 */
export type EncodableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | RegExp
  | DateTime
  | Duration
  | Interval
  | ArrayBuffer
  | DataView
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | EncodableValue[]
  | { [key: string]: EncodableValue }
  | Map<EncodableValue, EncodableValue>
  | Set<EncodableValue>
// DISCRIMINATION IS BY CLASS, NOT BY A `kind` FIELD. A plain record can wear
// `{kind: 'nodeRef', …}` — it is an ordinary encodable record — so a marker property cannot
// separate a reference from a literal that happens to look like one, and a resolver keying on it
// would silently rewrite the literal. So `NodeRef` and `ParamRef` are registered ENCODER CLASSES
// (instances with `[ENCODE_METHOD]`/`[DECODE_METHOD]`, registered by
// `registerOrchestrationEncodables()`): the `is*` guards are `instanceof` checks no record can
// satisfy, and the encoder round-trips them as `custom:NodeRef`/`custom:ParamRef` rather than as
// records. Same mechanism core uses for `Media`/`Tokenizable`, and why
// `registerOrchestrationEncodables()` must run before any `decode()`.
//
// THE WIRE PROBLEM THIS CREATES, AND ITS ONE ANSWER. A tool call cannot transmit a class
// instance — a model's `add_node`/`set_node_config`/`set_node_field` arguments arrive as decoded
// JSON records, which by the rule above are literals. So the IR's in-memory form and the tool
// surface's wire form are deliberately DIFFERENT, and the forge is the single named conversion
// point between them:
//
//   · WIRE (tool inputs only): a reference is `{$ref: {node, select, path?, branchId?}}` and a
//     template hole is `{$param: {path}}`. Single-key wrapper objects, whose keys are reserved:
//     freeze refuses a staged record whose sole key is `$ref` or `$param` reaching the IR
//     unconverted, so an author cannot smuggle a literal that mimics the wire form.
//   · IR (everything persisted, digested, resolved): real `NodeRef`/`ParamRef` instances.
//   · CONVERSION: `forge.ts` normalises wire → IR on the way in (`hydrateRefs`) and IR → wire on
//     the way out, so a model reading a plan back sees the same `$ref` shape it writes. Nothing
//     else in the battery sees the wire form; nothing outside the forge constructs these classes
//     from model input.
//
// The wrapper form is unambiguous on the wire because `$ref`/`$param` are reserved there, and the
// IR stays unambiguous because it holds classes. Neither representation alone could do both jobs.
// A freeze-time guard rejects any value outside this subset — a `Function`, an `Error`, or an
// unregistered custom class reaching a plan is refused with a named error rather than discovered
// at hydration.
//
// TYPE MEMBERSHIP IS NOT SUFFICIENT: a record, array, `Map` or `Set` is inside the subset and can
// still be CYCLIC, and the encoder tracks seen values and throws `E_CIRCULAR_REFERENCE`
// (`nhtio-encoder/src/private/structured_data.ts`). A cyclic staged argument would therefore pass
// a subset-only guard and then blow up while computing the digest — the one operation the whole
// lifecycle depends on. So the freeze guard is an *encodability* check, not a type check: it walks
// each staged value with a seen-set and refuses a cycle as a named submit-time issue. Equivalently
// and more cheaply, freeze may simply attempt the encode it is about to need and surface a thrown
// `E_CIRCULAR_REFERENCE` as that issue — the encoder is already the authority on what encodes.

/** A staged argument: any encodable value, or a reference to another node's output. */
export type ArgValue = EncodableValue | NodeRef | ArgValue[] | { [k: string]: ArgValue }

/**
 * A serializable reference to another node's output. Never a live value, never a string DSL.
 *
 * `branchId` identifies WHICH EXECUTION of `node` to read — the same path identity `NodeOutput`
 * and `FrameRef` carry. It is NOT an outgoing branch of `node`: a node fanning out to two
 * successors still runs once and produces one output, so there is nothing per-outgoing-edge to
 * address. What creates several outputs for one node is that node being *reached* by several
 * paths, which is exactly what a path identity distinguishes.
 */
// `NodeRef` is a real runtime CLASS and its single definition lives in `./encoding`, which is the
// module that implements it and registers it with the encoder. It is re-exported here as a TYPE
// only, so this module stays the one place to import the battery's type surface from without
// declaring a second, implementation-free copy of a value that must exist at runtime.
export type { NodeRef } from './encoding'

// ── node outputs ────────────────────────────────────────────────────────────
/**
 * One unit of a node's output. Items, after n8n — a node may emit several. The field is named
 * `json` for continuity with that lineage, but its values are `EncodableValue`, so a tool may
 * legitimately return a `Date`, a `RegExp`, a `Map` — the same domain a staged argument may hold,
 * which is what lets an output feed an argument without a lossy hop. It is NOT restricted to
 * JSON-representable values, and an earlier draft's "JSON-shaped only" gloss was wrong.
 */
export interface OutputItem {
  /**
   * The item's fields, addressable by a `NodeRef.path`. Named `json` for continuity with the n8n
   * lineage, but its values are `EncodableValue` — a `Date`, `RegExp` or `Map` is legitimate here.
   */
  json: Record<string, EncodableValue>
}
/**
 * A PATH identity — the route from `entry` to a frame, kept as the ROUTE ITSELF, not a hash of it,
 * so ancestry questions are answered by reading the value. (An earlier draft hashed it and then
 * tried to correlate joins by "longest common prefix of the ids", which computes nothing: a hash
 * has no prefix relation to what it hashes.)
 *
 * A route is a list of SEGMENTS. A segment is either one traversed edge, or a join — which is what
 * makes the structure total: a join has no single parent route, but a node *after* a join still
 * needs a route relative to something. An earlier draft gave a join `{edges: [], joinOf}`, which
 * reset the route to empty and made every post-join frame's `edges` relative to nothing, so two
 * different post-join paths collided.
 *
 * - **Entry frame:** `{ segments: [] }`.
 * - **Produced by an edge:** parent's `segments` + `{ edge: edgeId }`.
 * - **Produced by a JOIN:** the **correlation prefix** (the arriving route truncated at the fork —
 *   the same prefix `JoinState.correlationKey` is built from) + `{ join: nodeId, of: sorted(ALL
 *   incoming edge ids) }`. Subsequent edges then extend it normally.
 *
 *   Retaining that prefix is load-bearing: `of` is a graph constant, so a join segment ALONE is
 *   the same value for every execution of the join. If the route were reset to just that segment,
 *   two executions of the fork reached by different outer routes would produce identical merged
 *   identities and collide in `OutputTable` — even though their barriers correctly stayed
 *   separate. The prefix is exactly the coordinate that distinguishes them, and it is already
 *   computed for correlation, so nothing new is needed.
 *
 * `branchKey` is the canonical string form used for map keys and in events. It MUST be injective,
 * because it keys `OutputTable`, identifies `NodeRef.branchId`, orders join contributors, and makes
 * duplicate arrivals idempotent — a collision would overwrite one node's output with another's or
 * merge unrelated barriers. Naive delimiter-joining is NOT injective: an edge id containing the
 * delimiter (`a>b`) collides with two segments (`a`, `b`), and an id shaped like `join:x(y)`
 * collides with a join segment.
 *
 * Two mutually-reinforcing measures, both required:
 * 1. **Freeze validates edge ids** against `/^[A-Za-z0-9_-]{1,64}$/` — no delimiter, no colon, no
 *    parenthesis, so the grammar below cannot be forged. Node ids already carry an equivalent
 *    charset rule (see the re-cite-loop guard), and edge ids are minted by the same authoring
 *    tools, so this costs authors nothing.
 * 2. **The rendering is length-prefixed**, not delimiter-joined: each segment renders as
 *    `` `e${id.length}:${id}` `` or `` `j${nodeId.length}:${nodeId}(${of.map(len-prefix).join('')})` ``,
 *    concatenated with no separator. Length-prefixing is injective regardless of content, so the
 *    charset rule is defence in depth rather than the sole guarantee.
 *
 * Bounded by the acyclicity invariant plus `PlanBounds.maxNodes` — a route cannot revisit a node,
 * so it cannot exceed the node count.
 *
 * Why no run coordinate: a plan has at most one run ever (decision 10) and the graph is acyclic,
 * so a node executes exactly once per route reaching it. And why not an edge ordinal: given
 * `entry→a`, `entry→b`, `a→c`, `b→c`, both incoming edges of `c` are ordinal 0 among their own
 * source's outgoing edges, so two distinct frames would collide.
 */
export type RouteSegment = { edge: string } | { join: NodeId; of: string[] }
/** A path identity: the route from `entry` to a frame, kept as the route itself. */
export interface BranchId {
  /**
   * The route, in traversal order. Empty for the entry frame. A join segment carries the
   * correlation prefix before it — see the type's own remarks for why that prefix is load-bearing.
   */
  segments: RouteSegment[]
}
/**
 * The canonical string form of a `BranchId`, used for map keys and in events.
 *
 * @remarks
 * MUST be injective: it keys `OutputTable` and `ArtifactTable`, identifies `NodeRef.branchId`,
 * orders join contributors and makes duplicate arrivals idempotent, so a collision would overwrite
 * one node's output with another's. The rendering is length-prefixed rather than delimiter-joined,
 * which is injective regardless of content; the freeze-time edge-id charset rule is defence in
 * depth rather than the sole guarantee. Always build a key with this function, never by
 * interpolating the object.
 */
export type { branchKey } from './ops'

/** What a node produced on one path. Always an ARRAY, even for a single result. */
export interface NodeOutput {
  /** Always an array, even for a single result. */
  items: OutputItem[]
  /** Which execution of the node produced this — the path that reached it. */
  branchId: BranchId
}
/** Append-only, keyed `${nodeId}:${branchKey(branchId)}` — path-unique, which is what makes a
 *  NodeRef resolve. Always build the key with `branchKey`, never by interpolating the object. */
export type OutputTable = ReadonlyMap<string, NodeOutput>

/**
 * Live artifact instances produced by `call` nodes, keyed **identically** to `OutputTable`
 * (`${nodeId}:${branchKey(branchId)}`) so a `transform`'s `source: NodeRef` addresses one with no
 * second addressing scheme. This is the channel a `transform` receives its instance through — see
 * `TransformNodeDefinition`, which explains why the value dataflow cannot carry it.
 *
 * An entry exists only where `CallInvokerFn` returned a `SpooledArtifactLike`; a `string`-returning
 * call contributes nothing. Persisted as encoder HANDLES (`{tag, locator}` via each artifact's own
 * `[ENCODE_METHOD]`), never bytes, and rebound on resume through `resolveSpoolReader` — so
 * registering a durable store's reader resolver is load-bearing for resume, not optional hygiene.
 */
export type ArtifactTable = ReadonlyMap<string, SpooledArtifactLike>

// ── node definitions, closed per kind ───────────────────────────────────────
/** The closed set of node kinds. Each has its own definition type, and freeze validates per kind. */
export type PlanNodeKind = 'entry' | 'call' | 'reason' | 'transform' | 'branch' | 'select' | 'join'
/**
 * An edge's firing condition, drawn from the outcome of its source node.
 *
 * @remarks
 * Applicability is by source kind and is enforced at freeze; any other pairing is refused:
 * `entry` → `always`; `call`/`reason`/`transform` → `always` | `error`; `branch` → `match` |
 * `no_match` | `default` | `error`; `select` → `` case_${string} `` | `default` | `error` (a
 * `default` edge is REQUIRED); `join` → `always` | `error`.
 *
 * On a node settling, EVERY edge whose handle applies fires, each exactly once — so `always` fires
 * alongside `match`/`case_*` on success, and duplicates of one handle are legal fan-out. On a
 * FAILURE outcome only `error` edges fire; `always` does NOT — an `always` edge is a success-path
 * edge, not a finally. `default` fires only when no `match`/`case_*` matched.
 */
export type EdgeHandle = 'always' | 'match' | 'no_match' | 'default' | 'error' | `case_${string}`

/** A directed edge. Its `handle` decides when it fires; the graph alone orders execution. */
export interface PlanEdge {
  /**
   * The edge's identity. Matches `/^[A-Za-z0-9_-]{1,64}$/` so `branchKey` cannot be forged.
   * Uniqueness is a FREEZE-time invariant, not an append-time one: refusing "whichever arrived
   * second" would make the op fold order-dependent, so a same-id collision resolves by LWW on
   * `(lamport, actorId, opId)` and the losing edge is surfaced as a submit-time issue naming both.
   */
  id: string
  /** Source node. */
  from: NodeId
  /** Target node. */
  to: NodeId
  /** When this edge fires, given the source's outcome. */
  handle: EdgeHandle
}
// HANDLE APPLICABILITY, by source node kind — enforced at freeze; any other pairing is refused:
//   entry            → 'always'
//   call | reason | transform → 'always' | 'error'
//   branch           → 'match' | 'no_match' | 'default' | 'error'
//   select           → `case_${string}` | 'default' | 'error'   (a 'default' edge is REQUIRED)
//   join             → 'always' | 'error'
// FIRING: on a node settling, EVERY edge whose handle applies to that outcome fires, and each
// fires exactly once. So `always` fires alongside `match`/`case_*` on success, and duplicates of
// one applicable handle are legal fan-out (two `always` edges = two successors, both enqueued).
// On a FAILURE outcome only `error` edges fire; `always` does NOT — an `always` edge is a
// success-path edge, not a finally. `default` fires only when no `match`/`case_*` matched.

/**
 * One field a node promises to produce, or that an entry/template accepts. Declaring a field is
 * what makes it addressable by a `NodeRef.path` and checkable at freeze rather than at run time.
 */
export type DeclaredField =
  | { path: string; type: 'string'; maxBytes?: number }
  | { path: string; type: 'number' }
  | { path: string; type: 'boolean' }
  | { path: string; type: 'enum'; values: string[] }

/**
 * The one place external input enters the graph.
 *
 * @remarks
 * TOPOLOGY INVARIANTS, all enforced at freeze: EXACTLY ONE `entry` node — zero means nothing can
 * start, more than one means `executePlan` cannot tell which to materialise, and it takes no entry
 * argument by design. The entry node has NO incoming edges. Every other node is reachable from it.
 * The graph is acyclic over every handle, `error` and `default` included. Every `join` is a
 * DIAMOND (see `JoinNodeDefinition`). Every edge id matches `/^[A-Za-z0-9_-]{1,64}$/`.
 */
export interface EntryNodeDefinition {
  /** The fields a run's `input` must supply. Validated before any node runs. */
  input: DeclaredField[]
}
// TOPOLOGY INVARIANTS, all enforced at freeze:
//  · EXACTLY ONE `entry` node — zero means nothing can start, more than one means
//    `executePlan(planId, options)` cannot tell which to materialise, and it takes no entry
//    argument by design.
//  · The entry node has NO incoming edges.
//  · Every other node is reachable from it (the reachability check).
//  · The graph is acyclic over every handle, `error` and `default` included.
//  · Every `join` is a DIAMOND: all routes from `entry` to it pass through one common fork (its
//    immediate dominator), and the fork→join region contains no nested join. `required` is the
//    number of fork→join routes. See JoinNodeDefinition — this is what makes joins implementable,
//    and it is stated over the fork, NOT over immediate predecessors (which would refuse the
//    canonical diamond `a→b→j`, `a→c→j`).
//  · Every edge id matches /^[A-Za-z0-9_-]{1,64}$/ so `branchKey` cannot be forged. Uniqueness is
//    not cosmetic — `remove_edge {edgeId}`, `edge_taken.edgeId`, route identity, `PlanDiff` and
//    join-arrival idempotence (keyed `(branchKey, edgeId)`) all treat it as an identifier — but it
//    is NOT enforced by refusal, because refusing "whichever arrived second" would make the fold
//    order-dependent and two offline writers can each legally append before their logs meet. See
//    the op-log section: a same-id collision resolves by LWW on `(lamport, actorId, opId)`, so the
//    fold stays convergent, and the LOSING edge is surfaced as a submit-time `issue` naming both
//    so the author renames one. Uniqueness is therefore a freeze-time invariant, not an
//    append-time one.

/** A staged tool invocation — the node kind the whole staging environment exists to gate. */
export interface CallNodeDefinition {
  /** The tool to invoke. Refused at freeze unless `InvocableTools.has(tool)` — the Tier-C boundary. */
  tool: string
  /** The staged arguments. A value may be a literal or a `NodeRef` to another node's output. */
  args: Record<string, ArgValue>
  /** The fields this call promises to produce, so downstream `NodeRef`s are checkable at freeze. */
  output: DeclaredField[]
  /** What to do when a `NodeRef` resolves to nothing. Required, no default. */
  onMissingValue: 'fail' | 'omit'
  /** What this call is authorised to do. Approval binds the canonicalised union of these. */
  authority: AuthorityClaim[]
  /**
   * Whether re-invoking this tool with the same arguments is safe. Required, and a fact about the
   * TOOL — not a decision about this call, which is what `onIndeterminate` records.
   */
  replaySafe: boolean
  /**
   * What to do when this call was entered but never settled — a resume cannot tell whether the
   * side effect happened. Required, and a decision about THIS call, which is why it is separate
   * from `replaySafe`.
   */
  onIndeterminate: 'retry' | 'halt' | 'skip'
  /**
   * Output field paths this tool is trusted to have SANITISED — the only way taint is cleared.
   * Omitted (the default) means this node declassifies nothing. See the taint rules: type
   * validation is not sanitisation, so declassification must be asserted, never inferred.
   */
  declassifies?: string[]
}

/**
 * A prompt is a SEQUENCE of literal text and references — never a string with an embedded DSL.
 *
 * @remarks
 * Same reasoning as `ArgValue`: this repo represents references structurally so they are checkable
 * at freeze and need no parser. The battery joins the parts, substituting each ref's resolved
 * value, immediately before calling `ReasonerFn`.
 */
export type PromptPart = { text: string } | NodeRef
/**
 * A reason node ENDS IN A TOOL CALL, and that tool call IS its output — it never returns prose
 * to be parsed. `outputSchema` becomes the forced tool's `inputSchema`, so the model physically
 * cannot answer unstructured: the validator rejects malformed args and the battery retries
 * within `maxAttempts`. The captured, validated args are the node's `OutputItem.json`.
 * Note this node carries a Schema, NOT DeclaredField[] — a validator expresses nested objects
 * and unions that DeclaredField cannot, and it is what the forced tool needs anyway.
 */
export interface ReasonNodeDefinition {
  /** The prompt as a sequence of literal text and references, joined immediately before dispatch. */
  prompt: PromptPart[]
  /**
   * The output schema as an ENCODED STRING, not a live `Schema`. A live validation schema is NOT
   * `Encodable` — encoding one throws
   * `E_UNENCODABLE_VALUE: Value of type symbol (Symbol(override)) is not encodable` — so
   * embedding it would make the plan unpersistable.
   *
   * The repo already solved this exact problem in `Tool` (src/lib/classes/tool.ts:449-490):
   * `[ENCODE_METHOD]` stores `encodeSchema(this.#inputSchema)` and `[DECODE_METHOD]` rebuilds it.
   * NOTE the real export names — `@nhtio/validation` exports `encode` and `decode`, and
   * tool.ts:7 aliases them at the import:
   * `import { validator, encode as encodeSchema, decode as decodeSchema } from '@nhtio/validation'`.
   * There is no export literally named `encodeSchema`. Use the same aliasing so the call sites
   * read unambiguously next to the encoder's own `encode`/`decode`.
   */
  outputSchema: string
  /** Bounds the retry loop when the model's forced-tool args fail validation. Required, no default. */
  maxAttempts: number
}

/**
 * `predicate` is `EncodableValue`, NOT `unknown` — the whole plan must persist, and an `unknown`
 * could hold a symbol, a circular object, or a live evaluator object that
 * `@nhtio/encoder` refuses. Each cell interprets the value its own way (the structured cell reads
 * a `{path, op, value}` tree; the jexl and Lua cells read a source string), and a cell's
 * `validate()` is what rejects a shape it cannot use — but the outer type guarantees the plan is
 * serialisable regardless of which cell is wired.
 */
/**
 * A `transform` node converts one node's output into the shape a downstream node needs — the
 * bridge between what ADK tools actually return (`string | Uint8Array | SpooledArtifact | Media[]`)
 * and the pathable fields a `NodeRef` reads.
 *
 * **It invents no mapping language.** Each step names a descriptor from the artifact classes' OWN
 * `toolMethods` registry (`src/lib/classes/spooled_artifact.ts:56-70` — `{name, method,
 * description, argsSchema?, serialise?}`), which is exactly the declarative surface `forgeTools`
 * already drives for the model.
 *
 * **ONE VOCABULARY, stated once: a step names the descriptor's `name`** — the absolute,
 * LLM-facing identifier (`artifact_json_get`, `artifact_head`), which is why the field is called
 * `name` and not `method`: it is byte-equal to the `ArtifactMethodDescriptor` field it must match.
 * The battery then invokes that descriptor's own `method` (`json_get`, `head`) on the instance.
 * So the rule is: **the plan names what the model sees; the battery invokes what the descriptor
 * says.** An earlier draft called the field `method` while its examples used `name` values, so
 * two WPs and the test fixture read one contract two incompatible ways — and the two sets are
 * disjoint strings (`artifact_json_get` ≠ `json_get`), so half the examples were wrong either
 * way. `name` is the right half to keep: it is documented as "Absolute tool name as exposed to
 * the LLM", it is the identifier a model has already seen in a tool catalogue, and it is unique
 * across a class chain in a way `method` is not guaranteed to be. Note also that three base
 * `method` values are camelCase (`byteLength`, `lineCount`, `estimateTokens`) while every `name`
 * is snake_case — one more reason authoring against `name` is the stabler surface.
 *
 * The vocabulary is therefore `artifact_json_get`/`_pluck`/`_filter`/`_slice`,
 * `artifact_md_sections`/`_frontmatter`/`_headings`, `artifact_head`/`_tail`/`_grep`/`_cat` and
 * the rest of the base seven, plus whatever a consumer's own `SpooledArtifact` subclass adds — a
 * battery-specific expression language would have been a second surface to specify, validate and
 * lint, and this needs none.
 *
 * **Class-aware, and EXTENSIBLE for free.** The source class comes from
 * `InvocableTools.returns(tool)` — the consumer's declaration of what each tool returns, which is
 * the only party that knows. Freeze validates `steps[].name` against the class's **effective**
 * descriptor set and `args` against the descriptor's own `argsSchema`, so an `artifact_json_get`
 * on a Markdown artifact or a bad path is refused before approval. Where `returns()` yields
 * `undefined`, freeze refuses the transform naming the undeclared tool — the battery does not
 * guess a class.
 *
 * **`toolMethods` SHADOWS, so the effective set must be computed — the battery does it, not the
 * consumer.** This is the trap that makes `returns()` carry the CLASS rather than a descriptor
 * array. `spooled_artifact.ts:232-240` states it outright: *"Each `toolMethods` array lists
 * **only** its own class's descriptors — subclasses do not concatenate inherited descriptors."*
 * `SpooledJsonArtifact.toolMethods` is its seven JSON descriptors and nothing else; the base
 * seven are composed at a different layer entirely (`SpooledJsonArtifact.forgeTools` calls
 * `SpooledArtifact.forgeTools(ctx)` and merges registries). So `instance.constructor.toolMethods`
 * returns the LEAF set only, and an earlier draft that took a descriptor array from the consumer
 * advertised a vocabulary including `artifact_head`/`_tail`/`_grep`/`_cat` that freeze would then
 * have refused on every JSON or Markdown artifact — a stated invariant the seam could not uphold.
 * There is no helper in core that unions the chain.
 *
 * So the battery ships one, and it is the only place the union is computed —
 * `effectiveToolMethods(ctor)`, declared below alongside `ArtifactClassLike`.
 *
 * It collects each class's OWN `toolMethods` (`Object.getOwnPropertyDescriptor`, so an inherited
 * static is not counted twice) from the leaf up through `Object.getPrototypeOf`, and dedupes by
 * `name` with **nearest class wins** — matching the `Tool.onCollision = 'replace'` semantics core
 * already documents for the same overlap. WP 01 owns it; WP 04 (freeze) and WP 07 (the transform
 * runtime) both call it, and it is exported so a consumer and the tests can assert the same set.
 *
 * The consequence for the consumer is that they declare a class, not a list — which is the
 * declaration they can actually get right, since `Tool.artifactConstructor` is exactly a
 * `() => SpooledArtifact subclass` closure they already wrote.
 *
 * Two consequences worth stating: freeze validates against a **declaration**, so a consumer whose
 * declaration disagrees with the tool's actual return gets a node failure at run time (the
 * transform's own output validation catches it) rather than a silent wrong answer; and
 * `{kind: 'text'}` needs no transform at all when the node declares a single field.
 *
 * Because the vocabulary IS the registry rather than a list this battery maintains, a new
 * `SpooledArtifact` subclass becomes usable in a `transform` the moment it exists, with no
 * orchestration change at all: a future `SpooledYamlArtifact` declaring
 * `artifact_yaml_get`/`_keys` is immediately a legal `transform` source, its args validated by its
 * own `argsSchema`, its docs generated from its own descriptors. The same holds for a consumer's
 * private subclass — the battery never needs to know the format. This is the concrete reason to
 * prefer the registry over a mapping DSL: a DSL would have to grow a YAML accessor; this does not.
 *
 * **This is what makes a handle useful in a plan.** A `call` returning a `SpooledArtifact` keeps
 * its bytes out of the plan; a `transform` reads exactly the slice the next node needs and emits
 * structured `OutputItem`s. No **plan content** holds a reference to bytes — the instance lives in
 * run state and the artifact is consumed on the branch that produced it — so the no-media-handles
 * rule survives intact in the sense that actually matters: nothing inside the approved digest
 * points at a store. See the content-vs-execution-state boundary stated with that rule.
 *
 * ### How the transform actually RECEIVES the artifact — the `artifacts` channel
 *
 * The methods a step names are real async instance methods reading through a `SpoolReader`
 * (`SpooledJsonArtifact.json_get` calls `this.#resolveRecords()` against its reader), so they
 * cannot be invoked on a plain value. `OutputItem.json` is `EncodableValue`-only by design and
 * `NodeRef` resolution yields `item.json`, so **the dataflow path that carries values cannot
 * carry the instance.** An earlier draft specified the node's purpose without ever naming the
 * channel that feeds it, which left WP 07 an interface with no implementable input and made the
 * resume note ("its source artifact must still be resolvable") a fallback assigned to a condition
 * no mechanism could satisfy.
 *
 * **The mechanism already exists in core, and it is a HANDLE, not a side table.** A
 * `SpooledArtifact` is itself encoder-round-trippable: `[ENCODE_METHOD]` emits
 * `{reader: ReaderDescriptor}` — a `{tag, locator}` pointer, *never* the bytes
 * (`spooled_artifact.ts:287-315`) — and `[DECODE_METHOD]` re-binds it through
 * `resolveSpoolReader(descriptor)`, the registry whose resolver closure re-injects the live
 * binding (a flydrive `Disk`, an OPFS root, `fetch`) a locator cannot carry
 * (`src/lib/contracts/reader_resolvers.ts`). Subclasses override the snapshot to add their own
 * discriminator, so a decoded `SpooledJsonArtifact` comes back as a `SpooledJsonArtifact`.
 * **This is verified in-repo, not inferred:** `tests/unit/encoding/round_trip.cross.spec.ts:190-198`
 * — *"SpooledArtifact round-trips as an in-memory handle and re-reads its bytes"* — plus a
 * durable-reader case with a consumer-registered resolver at :261-278. The whole file is green
 * (15/15).
 *
 * So the channel is a second, **non-encodable-by-value but handle-encodable** table alongside
 * `OutputTable`, keyed identically:
 *
 * `ArtifactTable` (declared in Shared contracts alongside `OutputTable`) —
 * `ReadonlyMap<string, SpooledArtifactLike>`, keyed `${nodeId}:${branchKey(branchId)}`, the SAME
 * key as `OutputTable`, so a `transform`'s `source: NodeRef` addresses one without a second
 * addressing scheme.
 *
 * - **Populated at `call` settlement.** When `CallInvokerFn` returns a `SpooledArtifactLike`, the
 *   executor records the *declared-output* `NodeOutput` in `OutputTable` as usual **and** the
 *   instance in `ArtifactTable` under the same key. A `call` whose result is a `string` puts
 *   nothing here.
 * - **Carried on the frame.** `PendingFrame` gains `artifacts: ArtifactTable`, branch-local and
 *   cloned on fan-out exactly like `outputs`, and `edge_taken` carries it for the same reason it
 *   carries `outputs`: a successor must receive its own branch's accumulation.
 * - **Persisted as HANDLES.** `PendingFrame.artifacts` and `edge_taken.artifacts` encode via each
 *   artifact's own `[ENCODE_METHOD]`, so the run log holds `{tag, locator}` pointers and never
 *   bytes — which is precisely the property the no-bytes-in-plan-state rule wanted, now achieved
 *   by the same mechanism core already uses rather than by refusing to persist anything.
 * - **Resume rebinds through the resolver registry**, which is what makes the previously-unsatisfiable
 *   resume note true: a resumed `transform` decodes its source handle and gets a working instance
 *   **iff** a resolver for that `tag` is registered. Two honest consequences, both stated rather
 *   than papered over:
 *     · The **`registerSpoolReaderResolver` requirement is load-bearing for resume**, not
 *       optional hygiene. In-memory and fetch resolvers auto-register with the encoding battery;
 *       a durable store's resolver the consumer must register themselves, because only they hold
 *       the live binding (already a verified fact in this plan's table). A missing resolver throws
 *       `E_NO_READER_RESOLVER`, which the transform surfaces as an ordinary node failure naming
 *       the tag — the specified mechanism the earlier "producing turn is gone" note lacked.
 *     · An **in-memory reader's locator carries its own bytes base64-encoded** (per
 *       `ReaderDescriptor`'s own contract), so an in-memory artifact survives resume but counts
 *       against `PlanBounds.maxEncodedBytes` — the reason a durable spool store is the right
 *       choice for a plan whose calls produce large artifacts. Stated, not enforced: this is a
 *       deployment decision, not something the battery can pick.
 *
 * ### What a step's result feeds the next step
 *
 * Chaining passes the **raw method return value**, never a serialised form. `serialise` is
 * `(result: unknown) => string`, so chaining through it would flatten exactly the structure a
 * following `emit: {as:'rows'}` needs as an array. Note this is not hypothetical laxity: **no
 * descriptor in any of the three core classes actually carries `serialise`** (verified: 7/7/8
 * descriptors, none), so an unstated rule would have been guessed differently by every
 * implementor.
 *
 * `serialise` is therefore consulted at exactly one point — converting a **final** result into a
 * string for an `emit: {as:'value'}` field whose `DeclaredField` type is `string` — and where the
 * descriptor supplies none, the battery calls core's **exported** `defaultSerialise`
 * (`spooled_artifact.ts:129`, documented *"Exported for reuse by subclass `forgeTools`
 * overrides"*) rather than reimplementing its rules (string as-is; `string[]` newline-joined with
 * `'(empty list)'` when empty; `number` via `String`; `undefined` → `'(undefined)'`; otherwise
 * `JSON.stringify(v, null, 2)`).
 */
export interface TransformNodeDefinition {
  /** Which node's output to read. Its declared artifact class determines the legal methods. */
  source: NodeRef
  /**
   * Applied in order; each step's result feeds the next. `name` is the DESCRIPTOR'S `name` —
   * the absolute LLM-facing tool name (`artifact_json_get`), never the instance method name
   * (`json_get`). Validated at freeze against `effectiveToolMethods(sourceClass)`.
   */
  steps: { name: string; args?: Record<string, EncodableValue> }[]
  /** How the final result becomes items. `rows` expects an array and emits one item per element. */
  emit: { as: 'value'; field: string } | { as: 'rows' }
  /** What downstream nodes may reference — validated against the emitted items, as for `call`. */
  output: DeclaredField[]
}

/** A two-way branch: the predicate's verdict picks the `match` or `no_match` handle. */
export interface BranchNodeDefinition {
  /** Which `PredicateEvaluator` cell interprets `predicate`. Refused at freeze if not wired. */
  evaluator: string
  /** The cell's own predicate form. `EncodableValue` so the whole plan stays persistable. */
  predicate: EncodableValue
}
/** An n-way switch: the verdict names a case, or falls to the required `default` handle. */
export interface SelectNodeDefinition {
  /** Which `PredicateEvaluator` cell interprets `predicate`. Refused at freeze if not wired. */
  evaluator: string
  /** The cell's own predicate form. `EncodableValue` so the whole plan stays persistable. */
  predicate: EncodableValue
  /** The legal case labels. Each names a `` case_${label} `` handle. */
  cases: string[]
}
/**
 * A join is a **DIAMOND join only**: it closes a fan-out that a single ancestor opened. The
 * restriction is what makes joins implementable, and it is stated over the DIVERGENCE POINT, not
 * over the immediate predecessors.
 *
 * Freeze-enforced topology, checked by walking the graph:
 * - The join's **fork** is its immediate dominator. `entry → a; a → b; a → c; b → j; c → j` is the
 *   canonical diamond and its fork is `a`. (An earlier draft required all incoming edges to share
 *   one *immediate source*, which refused exactly this graph while admitting only a degenerate
 *   double-edge. The fork is the right notion.)
 * - **The fork must actually diverge toward the join: there must be MORE THAN ONE distinct
 *   fork→join route.** Without this the rule accepts two degenerate shapes that are not diamonds
 *   at all: `entry → a → join` (a one-route "barrier" that is just a pass-through), and
 *   `fork → left|right → shared → join`, where the paths have already reconverged at `shared`, so
 *   the immediate dominator slides down to `shared` and the join again sees one route. Both are
 *   refused: a `join` whose fork→join route count is 1 is a `join` that should not exist, and the
 *   error says so.
 * - **No reconvergence inside the diamond**: the fork→join region must contain no node with
 *   in-degree > 1 other than the join itself. This is what makes "the immediate dominator is the
 *   divergence point" true rather than accidental, and it removes the second degenerate case above
 *   at its root.
 * - Every route from the fork to the join is join-free: no nested join inside the diamond, so the
 *   contributor set cannot itself depend on another barrier.
 * - `required` is not authored. It IS the number of distinct routes from fork to join, computable
 *   at freeze because the region is acyclic, join-free and reconvergence-free.
 *
 * Four consequences, each an unresolvable problem under general DAG joins:
 *
 * 1. **Correlation is decidable from the first arrival**, because the fork is known statically:
 *    the barrier key is the arriving route truncated at the fork (see `JoinState.correlationKey`).
 * 2. **Late arrivals cannot occur**: `required` equals the route count, so the barrier fires when
 *    every route has arrived and never before. No fired-barrier state, no dropped work, no second
 *    firing.
 * 3. **The join's identity is a GRAPH CONSTANT**: `of` is the sorted list of ALL its incoming edge
 *    ids — known at freeze, independent of which predicates fired — so a downstream `NodeRef` to
 *    a post-join node is authorable.
 * 4. **Its output is deterministic and its SHAPE is specified**: one `OutputItem` per **arrival**
 *    — which equals the incoming-edge count exactly because the reconvergence-free rule makes
 *    every fork→join route traverse a distinct incoming edge, so "per arrival" and "per edge"
 *    cannot disagree. Sorted by `via` then `branch` for a total order. Each carries
 *    `{ via: <edgeId>, from: <source nodeId>, branch: <branchKey of that arrival> }`. A join
 *    contributes no data of its own — it is a barrier — so its items are *provenance*, which is
 *    the only thing it actually knows. A downstream `NodeRef` to the join therefore reads which
 *    routes converged (useful in a predicate: "did the retry path contribute?"), while the
 *    contributing nodes' real outputs are read by referencing those nodes directly, which the
 *    successor's unioned `OutputTable` makes possible. Leaving the shape unstated would let one
 *    implementation emit `{}` and another wrap arrival tables — incompatible observable APIs.
 *
 * Interaction with branching, stated because it is the sharp edge: a `branch`/`select` INSIDE a
 * diamond can leave a route unfired, so the barrier never completes. That is not a hang — the
 * executor settles the run `halted` with `{kind:'join_unsatisfiable', nodeId}` once no live frame
 * can still reach it. An author who wants "proceed with whichever finished" wants a `select` on a
 * prior result, not a partial join; the plan says so rather than offering a quorum knob whose
 * semantics it cannot pin down.
 *
 * The successor frame's `OutputTable` is the UNION of the arrivals' tables; keys are
 * `${nodeId}:${branchKey}`, path-unique, so the union cannot collide and needs no merge policy.
 */
export interface JoinNodeDefinition {
  /** Nothing to configure. `required` and the fork are both derived from the graph. */
  readonly kind?: 'diamond'
}

/**
 * `phase` is a LABEL: it groups nodes for reading, rendering and progress, and has NO execution
 * meaning — edges alone order execution. A NodeId is validated snake_case (no `/`, no leading
 * `.`) so it can never be mistaken for a path or copied as a citation.
 */
interface PlanNodeBase {
  id: NodeId
  phase?: string
}
/** A node: its identity and phase, plus exactly one kind-specific definition. */
export type PlanNode = PlanNodeBase &
  (
    | { kind: 'entry'; definition: EntryNodeDefinition }
    | { kind: 'call'; definition: CallNodeDefinition }
    | { kind: 'reason'; definition: ReasonNodeDefinition }
    | { kind: 'transform'; definition: TransformNodeDefinition }
    | { kind: 'branch'; definition: BranchNodeDefinition }
    | { kind: 'select'; definition: SelectNodeDefinition }
    | { kind: 'join'; definition: JoinNodeDefinition }
  )

// ── the scoped reading surface ───────────────────────────────────────────────
/** ONE flat level. Entries carry exact surface forms, not paraphrase. */
export interface PlanOutline {
  /** The plan this outlines. */
  planId: PlanId
  /** Its lifecycle state NOW — read from the store, not folded from the log. */
  state: PlanState
  /** The content digest at the revision outlined. */
  digest: string
  /** Total nodes, so a reader knows what the phase entries account for. */
  nodeCount: number
  /** One entry per phase label, in authoring order. */
  phases: PhaseEntry[]
  /** Nodes with no `phase`, addressed exactly the same way. `undefined` when every node has one. */
  unphased: PhaseEntry | undefined
}
/** One phase's entry in an outline. Carries exact surface forms, never paraphrase. */
export interface PhaseEntry {
  /** The phase label. */
  phase: string
  /** One line. */
  summary: string
  /** VERBATIM node ids — this is what a `NodeRef` must cite, so it cannot be abbreviated. */
  nodeIds: NodeId[]
  /** Verbatim tool names of this phase's `call` nodes. */
  tools: string[]
  /** How many issues fall in this phase, so a reader knows where to look without reading all. */
  issueCount: number
}
/** A slice. Self-locating: it carries enough neighbourhood to keep linking without re-reading. */
export interface PlanSlice {
  /** The nodes in this slice, in full. */
  nodes: PlanNode[]
  /** The phase this slice was taken from, when it was taken by phase. */
  phase?: string
  /** Immediate predecessors/successors of the slice, by id, so linking needs no second read. */
  boundary: { incoming: NodeId[]; outgoing: NodeId[] }
  /** Issues falling within this slice. */
  issues: PlanIssue[]
}

// ── run events: the persisted wire contract ─────────────────────────────────
/** How one frame settled. The three cases are exhaustive — a frame that has not settled has none. */
export type NodeOutcome =
  | { status: 'ok'; output: NodeOutput }
  | { status: 'failed'; handled: boolean; error: { name: string; message: string } }
  | { status: 'skipped'; reason: 'indeterminate_skip' }

/**
 * Identifies one execution of one node: the node, and the path that reached it. `kind` rides
 * along so the fold can classify without the graph (only a `call` frame can be indeterminate).
 * `viaEdgeId` is the edge that produced this frame — `undefined` for the entry frame, which no
 * edge produced. `branchId` is the path identity and is what makes a frame unique.
 */
export interface FrameRef {
  /** Which node. */
  nodeId: NodeId
  /** Rides along so the fold can classify without the graph — only a `call` can be indeterminate. */
  kind: PlanNodeKind
  /** The path that reached it. This is what makes a frame unique. */
  branchId: BranchId
  /** The edge that produced this frame. `undefined` for the entry frame, which no edge produced. */
  viaEdgeId: string | undefined
}

/**
 * The persisted wire contract. `foldRun` derives an entire `RunProjection` from a list of these
 * with no graph, no store and no side channel, which is what makes resume a pure function of the
 * log rather than of surviving process state.
 */
export type RunEvent =
  /** Carries `runId` so `foldRun` can produce it from events alone, with no side channel. */
  | { kind: 'run_started'; runId: string; digest: string; at: string }
  | { kind: 'node_entered'; frame: FrameRef; at: string }
  /** Carries the OUTPUT, not merely a status — this is what the resume fold rebuilds from. */
  | { kind: 'node_settled'; frame: FrameRef; outcome: NodeOutcome; at: string }
  /**
   * Carries the frame it PRODUCED **and that frame's branch-local `outputs`**, so the fold can
   * rebuild a complete `PendingFrame` without the graph. Carrying only `from`/`to` was not enough:
   * a `PendingFrame` needs the accumulated branch-local table, and the global outputs fold cannot
   * supply it — a successor must receive precisely its own branch's accumulation, not every output
   * recorded run-wide, which after a fan-out or a join are different things.
   *
   * Size note, since this duplicates state: the table holds `NodeOutput` values already present
   * in earlier `node_settled` events, so an implementation may persist it as the list of
   * `${nodeId}:${branchKey}` keys and rehydrate the values from those settlements. The contract is
   * the *content*; the encoding is the store's business.
   */
  | {
      kind: 'edge_taken'
      edgeId: string
      handle: EdgeHandle
      from: FrameRef
      to: FrameRef
      outputs: OutputTable
      artifacts: ArtifactTable
      evidence?: EncodableValue
      at: string
    }
  | { kind: 'frontier_snapshot'; frames: PendingFrame[]; joins: JoinState[]; at: string }
  | { kind: 'run_interrupted'; cause: InterruptionCause; frame?: FrameRef; at: string }
  | { kind: 'run_settled'; outcome: 'completed' | 'halted' | 'aborted'; at: string }

/**
 * A live frame: its identity, its branch-local value table, and its branch-local artifact table.
 * `artifacts` is cloned on fan-out exactly like `outputs` and is what a `transform` reads its
 * source instance from; it persists as handles, so a snapshot carries pointers, never bytes.
 */
export interface PendingFrame {
  /** Which execution of which node this frame is. */
  frame: FrameRef
  /** The branch-local value table this frame sees. Cloned on fan-out. */
  outputs: OutputTable
  /**
   * The branch-local artifact table — where a `transform` reads its source instance. Cloned on
   * fan-out exactly like `outputs`, and persisted as handles, so a snapshot carries pointers,
   * never bytes.
   */
  artifacts: ArtifactTable
}
/**
 * A join's partial barrier.
 *
 * **Correlation is decidable from ONE arrival**, and the diamond restriction is what buys it: the
 * join's **fork** is known at freeze, so the barrier key is the arriving route **truncated at the
 * fork** — the prefix of segments up to and including the one that entered the fork:
 * `` correlationKey = `${nodeId}@${branchKey(truncateAtFork(arriving, fork))}` ``.
 * Every sibling route passes through the same fork by the topology rule, so every sibling
 * truncates to the same prefix; and two different *executions* of the fork (reached by different
 * outer routes) truncate to different prefixes, so their barriers stay separate.
 *
 * Two rules that do NOT work, recorded because both were tried: the longest common prefix of the
 * *contributors* is unknown when the first arrival lands, and "drop the last segment" gives the
 * immediate predecessor's route — which differs per sibling on a real diamond
 * (`a→b→j` truncates to `e1`, `a→c→j` to `e2`). Truncating at a statically-known fork is what
 * makes all three properties hold at once.
 *
 * This is also why `BranchId` keeps its route rather than a hash: the rule needs the structure.
 * And why edge ids alone are insufficient: two arrivals over the same incoming edge from different
 * fork executions differ only in earlier segments.
 *
 * `arrivals` records what landed; the barrier fires when `arrivals.length` equals `required`, and
 * a repeat of the same `(branchKey, edgeId)` pair is idempotent. Because the threshold IS the
 * fork→join route count, there is no late-arrival case. The merged frame's identity is the
 * correlation prefix + `{ join: nodeId, of: sorted(ALL incoming edge ids) }` — see `BranchId` for
 * why the prefix must be retained, and note `of` being a graph constant is what makes a downstream
 * `NodeRef` to a post-join node authorable at freeze.
 */
export interface JoinState {
  /** The join this barrier belongs to. */
  nodeId: NodeId
  /**
   * The barrier's identity: `` `${nodeId}@${branchKey(truncateAtFork(arriving, fork))}` ``. Every
   * sibling route truncates to the same prefix; two executions of the fork truncate to different
   * ones, so their barriers stay separate. See this type's remarks for the two rules that do not
   * work and why.
   */
  correlationKey: string
  /**
   * Each arrival carries the branch-local `OutputTable` **and `ArtifactTable`** it arrived with.
   * Without these a resumed half-satisfied join could not build its successor's dataflow context:
   * the contributing branches' outputs and artifact handles were consumed into the barrier and are
   * nowhere else in the frontier. `artifacts` is here for exactly the reason `outputs` is — a
   * `transform` downstream of a join must still reach an instance a contributing branch produced.
   */
  arrivals: {
    branch: BranchId
    edgeId: string
    outputs: OutputTable
    artifacts: ArtifactTable
  }[]
  /** The join's in-degree. Not authored — derived from the graph, so it cannot disagree with it. */
  required: number
}

/**
 * The fold. Every field derives from the events alone — no graph, no store, no side channel:
 * `runId`/`digest` from `run_started`; `outputs` from each `node_settled` with status 'ok';
 * `frameStatus` from the entered/settled pairing per frame; `indeterminate` from entered-unsettled
 * frames whose `FrameRef.kind === 'call'`; the frontier from the last `frontier_snapshot`, then
 * advanced by the events after it — each later `node_settled` removes its frame and each later
 * `edge_taken` adds its `to` frame **with the `outputs` and `artifacts` that event carries**,
 * which is why `edge_taken` carries the produced frame and both of its branch-local tables: a
 * `PendingFrame` is `{frame, outputs, artifacts}` and no part is derivable from the others.
 *
 * `artifacts` is the one field whose values are not plain data: they decode from persisted
 * `{tag, locator}` handles through `resolveSpoolReader`, so folding a log whose artifact tags have
 * no registered resolver throws `E_NO_READER_RESOLVER` from the decode rather than yielding a
 * half-built projection. That is the same "register before you decode" precondition the encoding
 * battery already imposes, surfacing here rather than silently later.
 *
 * Deterministic and total. A list whose first event is not `run_started` is malformed and throws
 * rather than defaulting.
 */
export type { foldRun } from './runs'

// ── injected seams ──────────────────────────────────────────────────────────
/** The `call` node's invoker. Consumer owns tool resolution and execution; the battery owns
 *  validating the result against the node's declared `output` and recording it. */
/**
 * Returns the tool's result **in the shape the tool actually produced** — the same union an ADK
 * `ToolHandler` returns (`src/lib/classes/tool.ts:57`). An earlier draft had this return
 * `OutputItem[]`, which quietly obliged every consumer to invent a conversion the plan never
 * specified: a tool returning a JSON-in-a-string, or a `SpooledArtifact` handle, has no obvious
 * mapping to pathable fields, and three implementors would have chosen three.
 *
 * So the invoker just invokes, and the conversion is explicit in the graph:
 *   · a `string` result the node declares as one field → available directly;
 *   · anything needing extraction (a JSON string, an artifact, a markdown document) → a
 *     `transform` node names the artifact method that extracts it.
 * `Media`/`Uint8Array` results are refused at freeze for a node whose `output` declares fields —
 * bytes are not pathable and the IR holds no media handles.
 */
export type CallInvokerFn = (req: {
  tool: string
  args: Record<string, EncodableValue> // NodeRefs already resolved
  signal?: AbortSignal
}) => Promise<ToolResult>

/** Exactly what an ADK tool handler may return. The battery narrows it, never guesses at it. */
export type ToolResult = string | Uint8Array | SpooledArtifactLike | MediaLike | MediaLike[]
/**
 * Structural, per CONTRIBUTING §13 — the battery does not import the core classes. Note
 * `argsSchema`: an earlier draft omitted it while claiming freeze validates a step's args against
 * it, so the type could not support the check it was cited for. `serialise` likewise, since the
 * transform runtime needs the descriptor's own formatter rather than a guess.
 */
export interface ArtifactMethodDescriptor {
  /** Absolute, LLM-facing tool name (`'artifact_json_get'`). What a `steps[].name` cites. */
  name: string
  /** Instance method this descriptor invokes (`'json_get'`, `'head'`). Not what a step names. */
  method: string
  /** The model-facing description, as core wrote it. */
  description: string
  /** The method's argument schema. Freeze validates a step's `args` against it. */
  argsSchema?: ObjectSchema
  /**
   * The descriptor's own formatter, consulted at exactly ONE point: converting a FINAL result into
   * a string for an `emit: {as:'value'}` field whose declared type is `string`. Never used when
   * chaining steps — that would flatten the structure a following `emit: {as:'rows'}` needs. Where
   * absent, the battery calls core's exported `defaultSerialise` rather than reimplementing it.
   */
  serialise?: (result: unknown) => string
}

/**
 * An artifact CLASS, structurally. Carries only its OWN descriptors — the base seven are on an
 * ancestor, per core's shadowing rule — so the battery must walk the chain rather than read this
 * one array. `effectiveToolMethods` is the only place that walk happens.
 */
export interface ArtifactClassLike {
  /**
   * This class's OWN descriptors only. Core's `toolMethods` SHADOWS rather than concatenates, so
   * reading this array directly yields the leaf set — use `effectiveToolMethods` to get the union.
   */
  readonly toolMethods?: readonly ArtifactMethodDescriptor[]
}
/**
 * Every descriptor reachable on a class, leaf-first up the static prototype chain, deduped by
 * `name` with nearest-class-wins. Counts only OWN `toolMethods` per class
 * (`Object.getOwnPropertyDescriptor`) so an inherited static is not collected twice. Exported
 * because freeze (WP 04), the transform runtime (WP 07) and the tests must all agree on the set,
 * and a consumer needs to be able to print it.
 */
export type { effectiveToolMethods } from './artifact_methods'

/**
 * A spooled artifact instance, structurally — per CONTRIBUTING §13, the battery does not import
 * the core classes. This is the value a `call` may return and a `transform` reads its methods from.
 */
export interface SpooledArtifactLike {
  /** The class, for `effectiveToolMethods`. NOT a pre-unioned descriptor list — see above. */
  readonly constructor: ArtifactClassLike
  /** The descriptor-named instance methods, invoked by a `transform` step. */
  [method: string]: unknown
}
/** A media value, structurally. Refused at freeze for a node whose `output` declares fields. */
export interface MediaLike {
  /** The media's MIME type — the only member the battery reads. */
  readonly mimeType: string
}

/**
 * How a run is started, and the only place external input enters the graph. The `entry` node's
 * output is materialised from `input` BEFORE any other node runs — validated against its
 * `EntryNodeDefinition.input` (`DeclaredField[]`), then committed as the entry frame's
 * `node_settled`, so `NodeRef`s address it exactly like any other node's output and the resume
 * fold rebuilds it from events like any other.
 *
 * `input` is the taint origin: every value in it is tainted, and provenance propagates from here
 * (see the taint rules). Input that fails validation aborts the run before any side effect —
 * never a partially-started run.
 */
/**
 * The execution dependencies. Supplied at construction, per run, or both.
 *
 * PRECEDENCE, stated once so it cannot drift: **per-run wins, field by field, over construction**;
 * anything absent from both is a construction-time error if the plan needs it. `evaluators` merges
 * by cell `id` (a per-run cell replaces the configured one with the same id, others survive)
 * because a run legitimately swaps one cell while keeping the rest. Everything else replaces
 * wholesale.
 */
export interface RunDeps {
  /** How a `call` node actually invokes its tool. The consumer owns resolution and execution. */
  invokeCall: CallInvokerFn
  /** How a `reason` node dispatches to a model. */
  reason: ReasonerFn
  /** The predicate cells. A plan needing a cell that is absent is refused at freeze, not at run. */
  evaluators: PredicateEvaluator[]
  /**
   * Optional execution lease. Best-effort COORDINATION, not mutual exclusion: a TTL lease without
   * a fencing token cannot exclude a partitioned holder.
   */
  locks?: PlanLockFactory
}

/**
 * Per-run inputs. Every `RunDeps` member is OPTIONAL here: `createOrchestration` already holds
 * whatever was configured, so a caller repeats only what it wants to override. `Orchestration`'s
 * `executePlan` is therefore this shape, not the fully-required `RunDeps` — an earlier draft made
 * every dependency mandatory per run while also calling construction the assembly point, which
 * meant a caller had to repeat what it had just configured and left the override rule undefined.
 */
export interface RunOptions extends Partial<RunDeps> {
  /**
   * The run's input, materialised as the entry node's output before any other node runs. This is
   * the taint origin: every value here is tainted, and provenance propagates from it. Input that
   * fails validation aborts the run before any side effect — never a partially-started run.
   */
  input: Record<string, EncodableValue>
  /** Resume an interrupted run rather than start one. */
  resumeRunId?: string
  /** Cancels the run. Surfaces as a `turn_abort` interruption. */
  signal?: AbortSignal
  /**
   * Deliberately uninhabited. Indeterminate policy is per-node (`CallNodeDefinition.onIndeterminate`)
   * and never a run-level default — the decision belongs with the call whose side effect is at stake.
   */
  indeterminate?: never
}
/**
 * Starts or resumes a run. Takes no entry argument — the entry node is unique by freeze invariant
 * and its output is materialised from `RunOptions.input`.
 */
export type ExecutePlanFn = (planId: PlanId, options: RunOptions) => Promise<RunProjection>

/** The `reason` node's dispatcher. See ReasonNodeDefinition: it terminates in a tool call. */
export type ReasonerFn = (req: {
  prompt: string // parts already joined and refs resolved
  outputSchema: Schema // already decoded by the battery
  maxAttempts: number
  signal?: AbortSignal
}) => Promise<Record<string, EncodableValue>> // the captured, validated tool args

/**
 * A predicate cell: the seam that lets a `branch`/`select` interpret its own predicate form without
 * this battery specifying an expression language.
 */
export interface PredicateEvaluator {
  /** How a node names this cell in `evaluator`. Cells merge by this id across construction and run. */
  readonly id: string
  /**
   * Acquire whatever the cell needs — typically an optional peer. Awaited at construction, so a
   * missing peer fails at boot with a named error rather than part-way through a freeze.
   */
  load(): Promise<void>
  /** Reject a predicate shape this cell cannot use. Called at freeze, so refusal precedes approval. */
  validate(node: PlanNode): Promise<void>
  /** Decide the node's outcome. Called once per frame reaching the node. */
  evaluate(node: PlanNode, ctx: PredicateContext): Promise<PredicateVerdict>
}
/** What a cell may read when evaluating. Deliberately narrow: outputs and the frame, nothing live. */
export interface PredicateContext {
  /** The frame's branch-local value table. */
  outputs: OutputTable
  /** Which execution of which node is being decided. */
  frame: FrameRef
}
/** A cell's decision, in the shape the node kind that asked for it expects. */
export type PredicateVerdict =
  | { kind: 'branch'; matched: boolean }
  | { kind: 'select'; caseLabel: string | null } // null → the 'default' handle

/**
 * One unit of authority a `call` node claims. Approval binds the canonicalised union of every claim
 * in the plan, so what an operator approved and what may run are the same set.
 */
export interface AuthorityClaim {
  /** What kind of thing may be acted on. */
  capability: string
  /** Which instances of it. */
  scope: string
  /** What may be done to them. */
  verb: AuthorityVerb
}
/** The closed verb set. Closed so an authority set is comparable, not merely readable. */
export type AuthorityVerb = 'list' | 'read' | 'create' | 'update' | 'delete'

// ── ops, projections and views ──────────────────────────────────────────────
/** Every op carries actor/lamport identity; the fold is deterministic over any arrival order. */
interface OpBase {
  opId: string
  actorId: string
  lamport: number
  at: string
}
/**
 * One authoring edit. Every op carries actor and lamport identity, and the fold is deterministic
 * over any arrival order — so two offline authors' logs converge when they meet.
 */
export type PlanOp = OpBase &
  (
    | { op: 'add_node'; node: PlanNode }
    /** Records the removed node AND its incident edge ids so the fold is order-independent. */
    | { op: 'remove_node'; nodeId: NodeId; incidentEdgeIds: string[] }
    /**
     * `ArgValue`, not `EncodableValue` — a staged argument or a `PromptPart` may contain a
     * `NodeRef`, and `NodeRef` sits deliberately OUTSIDE `EncodableValue`
     * (`ArgValue = EncodableValue | NodeRef | …`). Typing the op's value as `EncodableValue` made
     * the only node-update op unable to express the commonest authoring edit — "point this
     * argument at that node's output" — so an implementor would have had to cast around the
     * contract or invent a second op.
     */
    | { op: 'set_node_field'; nodeId: NodeId; path: string; value: ArgValue }
    /** Replace a whole definition — what tier B's `set_node_config` compiles to. */
    | { op: 'set_node_definition'; nodeId: NodeId; definition: PlanNode['definition'] }
    | { op: 'set_node_phase'; nodeId: NodeId; phase: string | null }
    | { op: 'add_edge'; edge: PlanEdge }
    | { op: 'remove_edge'; edgeId: string }
    | { op: 'set_bounds'; bounds: PlanBounds }
  )

/** The resource envelope. Plan CONTENT, so it is digested and an operator approves it. */
export interface PlanBounds {
  /** Cap on nodes. Also bounds route length, since a route cannot revisit a node. */
  maxNodes: number
  /** Cap on edges. */
  maxEdges: number
  /** Cap on total node executions in a run — the bound on fan-out breadth times depth. */
  maxSteps: number
  /** Cap on simultaneously live frames. */
  maxConcurrentFrames: number
  /** Cap on the encoded plan size in bytes — the bound on staged byte payloads. */
  maxEncodedBytes: number
}

/**
 * The canonical initial bounds — the **fold's seed**, not an op. `foldOps` starts from these, so a
 * plan at revision 0 (an empty log) has a complete `RawPlanView` and a well-defined digest, and
 * `set_bounds` ops override it thereafter. Without a fixed seed each implementor would invent a
 * default or leave bounds absent, and since bounds are plan CONTENT that would give the same
 * logical plan different digests across stores — breaking approval binding and store conformance.
 * Every member stays required, so an override is total and cannot half-specify.
 */
export const DEFAULT_PLAN_BOUNDS: PlanBounds = {
  maxNodes: 256,
  maxEdges: 512,
  maxSteps: 4096,
  maxConcurrentFrames: 32,
  maxEncodedBytes: 1_048_576,
}

/**
 * What freeze validation needs that is NOT derivable from the plan itself. Passed to
 * `freezePlan()` by whoever holds it — WP 09's forge holds the Tier-C allowlist, WP 04's
 * `validation.ts` consumes this interface, so WP 04 depends on the TYPE (declared here, in WP 01)
 * and never on WP 09's implementation. That is what keeps the dependency acyclic: `validation.ts`
 * imports `InvocableTools` from shared contracts; the forge supplies an instance at call time.
 */
/**
 * THE battery's single entry point. Everything public is reached through the object it returns, so
 * it is the one place a precondition can be enforced for every operation — which is why the
 * encoder check lives here (see Serialization).
 *
 * It is `async` because it eagerly `await import('@nhtio/encoder')`, throwing
 * `E_ORCH_ENCODER_REQUIRED` (naming the package and install command) before any plan can exist.
 * It also `await`s `load()` on every supplied evaluator cell, so a missing optional peer surfaces
 * at construction rather than at freeze. A cell supplied per-run instead is loaded at that point,
 * with the same named error.
 */
export type CreateOrchestration = (config: {
  store: PlanStore
  invocable: InvocableTools
  /** Defaults for every run. A run may override any field — see `RunOptions` for precedence. */
  deps?: Partial<RunDeps>
  /** Consumer-defined plan shapes a model can instantiate. Validated at construction. */
  templates?: PlanTemplate[]
}) => Promise<Orchestration>

// ── templates ───────────────────────────────────────────────────────────────
/**
 * A consumer-defined plan shape, written in TypeScript and registered at construction — so it
 * versions with the consuming application, needs no store seeding, and can be validated once at
 * boot rather than per instantiation.
 *
 * Note what a template holds: **op INPUTS without identity**. A `PlanOp` requires
 * `opId`/`actorId`/`lamport`/`at`, none of which a static literal can carry (the same reason
 * bounds are a fold seed rather than an implied op). Instantiation mints that identity.
 */
export interface PlanTemplate {
  /** Stable identity — what a model names to instantiate. */
  id: string
  /** One line, shown by `list_templates`. */
  summary: string
  /** Declared holes, same type as the entry node's input — so a model fills a form, not a graph. */
  params: DeclaredField[]
  /**
   * The shape. NOT `PlanNode[]` — a template's staged values may hold a `ParamRef`, which
   * `ArgValue` deliberately excludes, so a consumer writing a template in TypeScript could not
   * place a hole without a cast. `TemplateNode` widens exactly that one axis.
   */
  nodes: TemplateNode[]
  /**
   * The shape's edges. Identical to a plan's — an edge holds no staged values, so no hole can sit
   * in one.
   */
  edges: PlanEdge[]
  /** Omitted ⇒ `DEFAULT_PLAN_BOUNDS`. */
  bounds?: PlanBounds
}

/** A plan node whose staged values may additionally contain template holes. */
export type TemplateArgValue =
  | ArgValue
  | ParamRef
  | TemplateArgValue[]
  | { [k: string]: TemplateArgValue }
/** A `PlanNode` whose definition may additionally contain template holes. */
export type TemplateNode = Omit<PlanNode, 'definition'> & {
  definition: TemplateDefinitionOf<PlanNode['definition']>
}
/** Structurally identical to the node definitions, with `ArgValue` widened to `TemplateArgValue`. */
export type TemplateDefinitionOf<D> = {
  [K in keyof D]: D[K] extends ArgValue
    ? TemplateArgValue
    : D[K] extends Record<string, ArgValue>
      ? Record<string, TemplateArgValue>
      : D[K] extends PromptPart[]
        ? ({ text: string } | NodeRef | ParamRef)[]
        : D[K]
}

/**
 * A hole in a template's staged values, substituted at instantiation. A CLASS for the same reason
 * `NodeRef` is: a look-alike record must not be mistaken for a hole. Registered by
 * `registerOrchestrationEncodables()` so a template value round-trips.
 */
// A real runtime CLASS; its single definition lives in `./encoding`. Type-only re-export, for the
// same reason as `NodeRef` above.
export type { ParamRef } from './encoding'

/** The outcome of instantiating a template. Failure is a value, not a throw — a model reads it. */
export type InstantiateResult =
  | { ok: true; planId: PlanId; issues: PlanIssue[] } // issues are non-fatal; plan is `editable`
  | { ok: false; reason: 'unknown_template' | 'invalid_args'; detail: string }

/** The public surface. Each member is specified in its own section; this is the assembly. */
export interface Orchestration {
  /**
   * `inputs` is optional because `createOrchestration` already holds `invocable` and any
   * configured `evaluators`; a caller passes it only to override, with the same field-by-field
   * precedence as `RunOptions` (evaluators merging by cell id).
   *
   * **A supplied `invocable` REPLACES the configured allowlist wholesale — it is not intersected
   * with it.** That is deliberate: `evaluators` merge because two cells with different ids are
   * additive, while two allowlists are a single answer to "what may a staged call invoke", and
   * silently intersecting them would make the effective allowlist something neither the assembly
   * nor the caller wrote.
   *
   * The consequence is worth stating plainly: passing a WIDER `invocable` here freezes a plan
   * against that wider set, so a plan naming a tool outside the assembly's allowlist can reach
   * `executable`. This is a HOST-ONLY capability — the forged tools always pass the assembly's
   * own `invocable`, so no model can reach this parameter — but if you expose `freezePlan` to
   * anything less trusted than your own assembly code, pass no `inputs` at all.
   *
   * Freeze needs them because a
   * `branch`/`select` with no wired cell, or a `call` naming a tool outside tier C, is refused
   * there — so a plan whose cell is supplied per-run must supply it here too, and that is the
   * point of the override. An earlier draft exported `freezePlan(planId)` while specifying
   * `freezePlan(planId, inputs: FreezeInputs)` elsewhere, which left WP 04 and WP 12 without one
   * contract to implement.
   */
  freezePlan(
    planId: PlanId,
    inputs?: Partial<FreezeInputs>
  ): Promise<{ ok: boolean; issues: PlanIssue[] }>
  /**
   * The permission gate: it IS the `reviewable → executable` transition, so "approved" and
   * "executable" are one fact. Refused unless the record's digest and authority set match the
   * frozen plan exactly — approving content that was never shown is the failure this prevents.
   */
  approvePlan(planId: PlanId, record: ApprovalRecord): Promise<TransitionResult>
  /** Start or resume the plan's one run. A plan id admits at most one run, ever. */
  executePlan: ExecutePlanFn
  /** Mint a new `editable` plan from a registered template with `args` substituted for its holes. */
  instantiate(templateId: string, args: Record<string, EncodableValue>): Promise<InstantiateResult>
  /** The registered templates, as a model sees them: what to name, what it does, what to fill. */
  templates(): readonly { id: string; summary: string; params: DeclaredField[] }[]
  /** Prose rendering — what an operator actually reads before approving. */
  render: typeof renderPlan
  /** The structured views, for diff-rendering UIs rather than for reading. */
  raw: {
    plan: typeof rawPlan
    ops: typeof rawOps
    diff: typeof rawDiff
    outline: typeof planOutline
  }
  /**
   * The forge. Tier A (`front`) withholds graph mechanics; tier B (`authoring`) exposes them.
   * There is no tier C here — that is `invocable`, the consumer's own tools, which this battery
   * gates rather than forges.
   */
  tools(tier: 'front' | 'authoring'): Record<string, Tool>
  /**
   * The backing store, exposed so a consumer can list, read history and clone without a second
   * handle.
   */
  readonly store: PlanStore
}

/**
 * The Tier-C boundary: which of the consumer's tools a staged `call` may invoke, and what each
 * returns. Supplied by the consumer, because they are the only party that knows.
 */
export interface InvocableTools {
  /** `true` if a staged `call` may invoke this tool unattended. The Tier-C boundary. */
  has(tool: string): boolean
  /** For a model-addressed refusal that names what IS available. */
  names(): readonly string[]
  /**
   * What this tool returns, so freeze can validate a downstream `transform` against it. The
   * consumer knows: an ADK `Tool` carries `artifactConstructor` — a `() => SpooledArtifact
   * subclass` closure they already wrote (`src/lib/classes/tool.ts:103`) — so
   * `{kind:'artifact', artifactClass: tool.artifactConstructor()}` is a declaration they can
   * make correctly with no new bookkeeping. `undefined` for a tool the consumer has not
   * declared: a `transform` over such a node is then refused at freeze (naming the tool), rather
   * than the battery guessing a class it cannot know.
   *
   * **It carries the CLASS, not a descriptor array, and that is the fix for a real trap.** Core's
   * `toolMethods` static SHADOWS rather than concatenates — `SpooledJsonArtifact.toolMethods` is
   * its seven JSON descriptors only, with the base seven composed at the `forgeTools` layer
   * instead (`spooled_artifact.ts:232-240`). A seam taking a descriptor array would therefore
   * have been handed the leaf set by every consumer reading `.toolMethods`, and freeze would
   * refuse `artifact_head` on a JSON artifact while the plan advertised it. Handing over the
   * class moves the union into the battery, where `effectiveToolMethods` computes it once.
   *
   * This is also the channel the transform freeze-check needs, and an earlier draft claimed the
   * check without providing any channel at all — no IR field and no seam exposed a tool's
   * artifact class, so the "refuse a step absent from the source class, naming the legal set"
   * rule was unbuildable.
   */
  returns(
    tool: string
  ):
    | { kind: 'text' }
    | { kind: 'bytes' }
    | { kind: 'media' }
    | { kind: 'artifact'; artifactClass: ArtifactClassLike }
    | undefined
}
/**
 * What freeze validation needs that is NOT derivable from the plan itself.
 *
 * @remarks
 * Resolved the same way as `RunDeps`: construction supplies the defaults, a call may override
 * field by field, evaluators merge by cell id. `Orchestration.freezePlan` therefore takes
 * `Partial<FreezeInputs>` and `validation.ts`'s internal entry point takes this fully-resolved
 * shape — the resolution happens once, at the assembly point.
 */
export interface FreezeInputs {
  /** The Tier-C allowlist, and the source of each tool's declared return class. */
  invocable: InvocableTools
  /** The wired cells. A `branch`/`select` naming an absent cell is refused here. */
  evaluators: PredicateEvaluator[]
}
// Resolved the same way as RunDeps: construction supplies the defaults, a call may override
// field by field, evaluators merge by cell id. `Orchestration.freezePlan` therefore takes
// `Partial<FreezeInputs>`, and `validation.ts`'s internal entry point takes the fully-resolved
// `FreezeInputs` — the resolution happens once, at the assembly point (WP 12).

/**
 * A clone's lineage. `completedAtClone` is the part that is not derivable later: the renderer must
 * warn that "the parent already completed X, Y, Z, and approving this repeats them", and the
 * parent's id/digest/revision identify CONTENT, not execution — a plan at that revision may never
 * have run, may be halted, or may have completed a subset. So `clonePlan` snapshots the parent's
 * completed node ids at clone time, which also makes the warning stable if the parent's run is
 * later re-read or the parent is archived.
 */
export type PlanProvenance =
  | ({ kind: 'clone' } & ClonedFrom)
  | ({ kind: 'template' } & InstantiatedFrom)

/** A clone's lineage. */
export interface ClonedFrom {
  /** The plan cloned from. */
  parent: PlanId
  /** The parent's content digest at clone time. */
  parentDigest: string
  /** The parent's revision at clone time. */
  parentRevision: number
  /** Node ids the parent had settled `ok` when the clone was taken; `[]` if it never ran. */
  completedAtClone: NodeId[]
}

/**
 * Instantiation lineage, for the renderer and for audit. **Not a taint mechanism** — see below.
 */
export interface InstantiatedFrom {
  /** The template's id. */
  template: string
  /** The arguments substituted for its holes. */
  args: Record<string, EncodableValue>
}

// WHERE TEMPLATE TAINT IS ACTUALLY ENFORCED — and why not here.
//
// An earlier draft carried `taintedPaths: {nodeId, path}[]` recording where each hole landed, and
// had freeze treat those paths as entry-derived. That cannot work, and its own specified test
// proved it: the test required an IDENTICAL literal authored directly to be accepted, which means
// after instantiation an ordinary `set_node_field` can copy the substituted value into a `call`
// arg and it is indistinguishable from the accepted one. Paths also go stale under the free
// mutation `editable` guarantees, and `clonePlan` replaces provenance wholesale so a clone lost
// the origin entirely. A per-value taint marker is no better: a literal is a literal.
//
// The check belongs where the thing being checked is IMMUTABLE — the template itself, which is
// code-defined and validated at construction:
//
//   · At CONSTRUCTION, for each registered template: a `ParamRef` reaching a `call` node's `args`
//     is refused unless a node on every route to it declares the corresponding field in
//     `declassifies`. Static, total, and decidable over a fixed graph — the template cannot
//     change afterwards, so the answer cannot go stale.
//   · At INSTANTIATION nothing further is needed: a template that could not launder its params
//     cannot produce a plan that does.
//   · AFTER instantiation the result is an ordinary `editable` plan, and a subsequent edit that
//     routes a literal into a `call` arg is exactly as scrutinised as any authored plan — which
//     is to say: it is in the operator's rendered prose, and the operator approves it. That is the
//     honest boundary, and it is the same one every hand-authored plan already has.
//
// So the invariant the plan now claims is narrower and true: A TEMPLATE CANNOT LAUNDER ITS OWN
// PARAMETERS. It does not claim that a value's template origin is tracked through arbitrary later
// edits, because nothing in a freely-mutable graph can track that.

/**
 * The folded plan CONTENT at a revision. `rawPlan()` returns this; the renderer and validator
 * read it. Note there is deliberately no `state` field: lifecycle state is not a `PlanOp`, so it
 * cannot be folded from the log, and a historical revision therefore has no recoverable
 * lifecycle state to report. `state` is a property of the plan NOW — read it from
 * `PlanStore.readState()`, which is where it lives. A `RawPlanView` at revision 7 answers "what
 * did the content look like then", not "what state was it in then".
 */
export interface RawPlanView {
  /** The plan. */
  planId: PlanId
  /**
   * The content digest at this revision. Lossless, not a canonicalisation — see the digest rules.
   */
  digest: string
  /** Which revision this view folded to. */
  revision: number
  /** The nodes at that revision. */
  nodes: PlanNode[]
  /** The edges at that revision. */
  edges: PlanEdge[]
  /**
   * The bounds at that revision, seeded from `DEFAULT_PLAN_BOUNDS` and overridden by `set_bounds`.
   */
  bounds: PlanBounds
  /** Where the plan came from, when it was not authored from scratch. */
  provenance?: PlanProvenance
}

/** A plan's headline, for listings. Carries `state`, which `RawPlanView` deliberately does not. */
export interface PlanSummary {
  /** The plan. */
  planId: PlanId
  /** Its lifecycle state NOW. */
  state: PlanState
  /** The current content digest. */
  digest: string
  /** The current revision. */
  revision: number
  /** How many nodes it holds. */
  nodeCount: number
  /** An author-supplied label, when one was set. */
  label?: string
  /** Where the plan came from, when it was not authored from scratch. */
  provenance?: PlanProvenance
  /** When the plan last changed, ISO-8601. */
  updatedAt: string
}

/** One finding from validation. Model-addressed, because a model is what usually acts on it. */
export interface PlanIssue {
  /** Stable code, e.g. `'missing_authority'`, `'dangling_edge'`. Safe to branch on. */
  code: string
  /** Model-addressed prose that NAMES THE FIX, not merely the fault. */
  message: string
  /** The node at fault, where one is implicated. */
  nodeId?: NodeId
  /** The edge at fault, where one is implicated. */
  edgeId?: string
  /** `blocking` refuses the freeze; `advisory` is surfaced and allowed through. */
  severity: 'blocking' | 'advisory'
}

/** Structural delta between two folded states — what a diff UI renders. */
export interface PlanDiff {
  /** The revision compared from. */
  from: { revision: number; digest: string }
  /** The revision compared to. */
  to: { revision: number; digest: string }
  /** Nodes present in `to` and absent from `from`. */
  nodesAdded: PlanNode[]
  /** Nodes present in `from` and absent from `to`. */
  nodesRemoved: PlanNode[]
  /** `ArgValue`, not `EncodableValue` — a changed field may hold a `NodeRef`, and typing it
   *  narrower would make a legitimate change unrepresentable in the diff (the `set_node_field`
   *  correction has to propagate here too). */
  nodesChanged: { nodeId: NodeId; fields: { path: string; before: ArgValue; after: ArgValue }[] }[]
  /** Edges present in `to` and absent from `from`. */
  edgesAdded: PlanEdge[]
  /** Edges present in `from` and absent from `to`. */
  edgesRemoved: PlanEdge[]
}

/**
 * An operator's decision, bound to exactly the content they were shown. The digest is lossless, so
 * two plans that differ in any staged value cannot share one — which is what stops an approval
 * authorising a plan that was never rendered.
 */
export interface ApprovalRecord {
  /** The plan approved. */
  planId: PlanId
  /** The content digest approved. A later revision does not inherit this approval. */
  digest: string
  /** Canonicalised: deduped and lexicographically sorted, so set equality is a byte comparison. */
  authoritySet: AuthorityClaim[]
  /** Who decided. */
  decidedBy: string
  /** When, ISO-8601. */
  decidedAt: string
  /** A denial is not recorded as an approval; it is ABSENT. So this has exactly one inhabitant. */
  disposition: 'approved'
}

/** Why a run stopped short of completing. Closed, so a caller can handle every case it must. */
export type InterruptionCause =
  | { kind: 'turn_abort' }
  | { kind: 'operator_stop' }
  | { kind: 'gate_timeout' }
  | { kind: 'process_death' }
  /**
   * The run hit `maxSteps` — its own declared settlement budget — and stopped.
   *
   * @remarks
   * Distinct from `process_death` on purpose. Process death is NEVER inferred (see `foldRun`); it
   * reaches the log only when a resuming caller records it. Budget exhaustion is the opposite: the
   * executor knows exactly why it stopped, and reporting it as a death both lies about the cause
   * and tells an operator to look for a crash that never happened. It is also NOT a cycle — freeze
   * proves the graph acyclic, so a plan can exhaust a budget through legitimate fan-out.
   *
   * `settled` is the count reached, so a caller can decide whether to raise `maxSteps` and clone,
   * or accept that the plan is too large for its bound.
   */
  | { kind: 'budget_exhausted'; settled: number }
  | { kind: 'deviation_abort'; detail: string }
  | { kind: 'node_failed'; nodeId: NodeId; handled: false }
  | { kind: 'predicate_unevaluatable'; nodeId: NodeId }
  /** A join can no longer be satisfied: no live frame can still reach it. */
  | { kind: 'join_unsatisfiable'; nodeId: NodeId }
  | { kind: 'output_schema_violation'; nodeId: NodeId }
  | { kind: 'authority_revoked'; claim: AuthorityClaim }

/** What `foldRun` returns: the whole answer to "where did it stop and what happened". */
export interface RunProjection {
  /** The run. Folded from `run_started`, so it needs no side channel. */
  runId: string
  /** The plan digest the run started against. */
  digest: string
  /**
   * Keyed by FRAME, not by NodeId: a node may run on several branches and several runs, so one
   * node can simultaneously have a settled frame and an entered-but-unsettled one. The key is
   * `${nodeId}:${branchKey(branchId)}`. `nodeStatusById` is the convenience rollup — a node is
   * `running` if any frame is, `failed` if any frame failed, `done` only if every frame settled.
   */
  frameStatus: ReadonlyMap<string, 'running' | 'done' | 'failed' | 'skipped'>
  /**
   * The per-node rollup: `running` if any frame is, `failed` if any failed, `done` only if every
   * frame settled.
   */
  nodeStatusById: ReadonlyMap<NodeId, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>
  /** Every `ok` settlement's output, run-wide. Plain data, unlike the artifact tables. */
  outputs: OutputTable
  /**
   * DELIBERATELY no run-wide `artifacts` counterpart. `outputs` is run-wide because a
   * `RunProjection` is the audit answer to "what did each node produce", and its values are plain
   * data. Artifact instances are *branch-local execution state*, not results: they are read by the
   * `transform` running on the branch that produced them, and they live on `PendingFrame.artifacts`
   * and `JoinState.arrivals[].artifacts`, which the `frontier` already carries. A run-wide table
   * would additionally force every artifact of every completed branch to be rebound on every fold
   * — resolver calls, and for in-memory readers base64 bytes — to answer a question nothing asks.
   */
  frontier: { frames: PendingFrame[]; joins: JoinState[] }
  /** Entered without settling AND of kind `call` — the indeterminate set, exactly. Other kinds
   *  are re-entered unconditionally (see the commit protocol), so they never appear here. */
  indeterminate: FrameRef[]
  /** Every edge that fired, with whatever evidence the predicate recorded. */
  edgesTaken: { edgeId: string; handle: EdgeHandle; evidence?: EncodableValue }[]
  /**
   * Where the run stands. `running` is what a fold reports for a log with no `run_settled` — it
   * does NOT assert the process is alive, because a dead process's log is byte-identical to a live
   * in-flight one. The difference is liveness, not history, and `foldRun` reads only history.
   */
  outcome: 'running' | 'completed' | 'halted' | 'aborted'
  /** Why it stopped, when it stopped short. */
  interruption?: InterruptionCause
}
