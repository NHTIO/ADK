/**
 * Declarative contracts for validating the ordering of ADK conversation primitives.
 *
 * @module @nhtio/adk/batteries/validation/types
 */

import type { Message, Thought, ToolCall } from '@nhtio/adk/common'

/** Primitive categories that can appear in an ordering timeline. */
export type OrderingPrimitiveKind = 'message' | 'thought' | 'toolCall'

/** One time-ordered timeline entry merging Message, Thought, and ToolCall values. */
export interface OrderingTimelineEntry {
  /** Category of the value. */
  kind: OrderingPrimitiveKind
  /** Creation time in milliseconds, derived from the primitive's `createdAt`. */
  at: number
  /** Stable insertion-order tie-break captured before sorting the timeline. */
  seq: number
  /** Conversation role when the primitive has a meaningful user/assistant role. */
  role?: 'user' | 'assistant'
  /** The original ADK primitive, retained for metadata and correlation checks. */
  value: Message | Thought | ToolCall
}

/**
 * The plain-object projection of a {@link OrderingTimelineEntry.value} stored under
 * `ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY` — `ctx.stash` klona-clones its entire store on
 * every read, and klona's generic-object clone strategy calls `new x.constructor()` with zero
 * args before copying properties, which throws for the real Message/Thought/ToolCall classes.
 * Only `id`, `payload`, and `replayCompatibility` are preserved (the only fields any consumer of
 * this stash key reads); it is never a live class instance.
 */
export interface OrderingStashedTimelineEntry {
  /** Category of the value. */
  kind: OrderingPrimitiveKind
  /** Creation time in milliseconds, derived from the primitive's `createdAt`. */
  at: number
  /** Stable insertion-order tie-break captured before sorting the timeline. */
  seq: number
  /** Conversation role when the primitive has a meaningful user/assistant role. */
  role?: 'user' | 'assistant'
  /** Plain-object projection of the original primitive — never a live class instance. */
  value: {
    id?: unknown
    payload?: unknown
    replayCompatibility?: unknown
  }
}

/** Relative order required between two primitive kinds. */
export interface OrderRule {
  /** Discriminator selecting the relative-order evaluator. */
  type: 'order'
  /** Stable identifier used in violations and advisory configuration. */
  id: string
  /** Primitive that must occur first. */
  before: OrderingPrimitiveKind
  /** Primitive that must occur after {@link OrderRule.before}. */
  after: OrderingPrimitiveKind
  /** Whether the relationship is local to a role group or spans the whole turn. */
  scope: 'adjacent-same-role-group' | 'entire-turn'
  /**
   * When true, evaluate only the current/latest group; earlier malformed historical groups are
   * intentionally ignored, as with Anthropic's current-turn thinking requirement.
   */
  onlyLatestGroup?: boolean
}

/** Requires provider-specific metadata on selected primitives. */
export interface RequiredMetadataRule {
  /** Discriminator selecting the metadata-presence evaluator. */
  type: 'requiredMetadata'
  /** Stable identifier used in violations. */
  id: string
  /** Primitive whose payload is required to carry the metadata. */
  kind: OrderingPrimitiveKind
  /** Whether metadata is required only on the group leader or on every matching primitive. */
  applyTo: 'first-in-group' | 'every'
  /** Dot-path into `value.payload` for the required provider metadata. */
  requiredPayloadKey: string
  /**
   * Whether a missing value blocks dispatch. Omitted means `blocking`; `advisory` records the
   * same metadata check without allowing it to reject a dispatch. This models Gemini 3's hard
   * `thought_signature` requirement versus Gemini 2.5's advisory version of the same check.
   */
  severity?: 'blocking' | 'advisory'
  /**
   * Optional producer tags that gate this check; metadata is required only when the primitive's
   * replay-compatibility tag identifies one of these wire formats.
   */
  gatedByReplayCompatibility?: string[]
  /**
   * Vendor-documented sentinel used when the genuine metadata is unavailable (for example,
   * Gemini's `skip_thought_signature_validator` for translated or model-switched history).
   * Consumed only by mutate-mode repair, and only with {@link OrderingGuardOptions.allowMetadataFallbackRepair};
   * it must never be applied by ordinary mutate mode because it represents a provenance claim.
   */
  fallbackPayloadValue?: unknown
  /**
   * Replay-adapter convention to attach alongside {@link fallbackPayloadValue}. A payload requires
   * this tag so the ADK knows which adapter may replay it. Consumed only by the separately opted-in
   * mutate-mode fallback repair, never by validation or ordinary mutation.
   */
  fallbackReplayCompatibility?: string
}

/** Requires a strict sequence of conversation roles. */
export interface AlternationRule {
  /** Discriminator selecting the role-alternation evaluator. */
  type: 'alternation'
  /** Stable identifier used in violations. */
  id: string
  /** Allowed role cycle, normally `['user', 'assistant']`. */
  roles: ReadonlyArray<'user' | 'assistant'>
  /** The only supported mode in this version: every successive turn must alternate. */
  mode: 'strict'
  /**
   * Optional cap on ToolCall entries within one same-role group. Llama 3's parallel-tool-call
   * limitation is represented as `1`; Llama 4 lifts that limitation by omitting this field.
   */
  maxPerGroup?: number
}

/**
 * Requires a first-kind primitive to be immediately followed by a permitted primitive.
 *
 * @remarks The ADK's {@link Message} has no `payload` field, and its MessageRole documentation
 * says tool results never appear in persisted message history. Results live on {@link ToolCall}
 * itself, so the former field-correlation model could never resolve a tool result. This rule
 * therefore directly forbids selected kinds as the immediate successor.
 */
export interface AdjacencyRule {
  /** Discriminator selecting the adjacency evaluator. */
  type: 'adjacency'
  /** Stable identifier used in violations. */
  id: string
  /** Primitive whose immediate successor is constrained. */
  first: OrderingPrimitiveKind
  /** Primitive kinds that may not immediately follow a `first`-kind primitive. */
  disallowBetween: OrderingPrimitiveKind[]
}

/** Requires historical primitive content to remain present and/or stable. */
export interface PreservationRule {
  /** Discriminator selecting the stateful preservation evaluator. */
  type: 'preservation'
  /** Stable identifier used in violations and snapshots. */
  id: string
  /** Historical primitive kind whose continuity is required. */
  kind: OrderingPrimitiveKind
  /**
   * Whether the count may not decrease, or a selected payload field must remain unchanged across
   * dispatch iterations.
   */
  /**
   * Continuity invariant: `count-non-decreasing` never permits historical loss,
   * `payload-field-stable` preserves a selected field, and `pruned-after-latest-turn` permits
   * absence only before the latest non-tool-call user Message; content after that boundary must
   * remain present AND unchanged, mirroring `payload-field-stable` for the retained recent range.
   * The latter means never drop recent or alter it, may drop old, and is distinct from full-history
   * preservation.
   */
  invariant: 'count-non-decreasing' | 'payload-field-stable' | 'pruned-after-latest-turn'
  /** Dot-path into the primitive payload when `invariant` is `payload-field-stable`. */
  payloadField?: string
  /** Reset the comparison baseline when the producing model changes. */
  resetOnModelSwitch?: boolean
}

/** Describes a required provider wire-role mapping for a primitive. */
export interface RoleRemapRule {
  /** Discriminator selecting the role-remapping evaluator. */
  type: 'roleRemap'
  /** Stable identifier used in violations. */
  id: string
  /** Primitive whose provider-specific role representation is required. */
  kind: OrderingPrimitiveKind
  /** Profile-defined mapping variant, such as a Granite generation. */
  variant: string
  /** Dot-path into `value.payload` containing the producer's expected wire-role tag. */
  expectedRoleTag: string
}

/**
 * Records vendor-recommended stale-content hygiene without ever creating a blocking violation.
 *
 * @remarks
 * This is intentionally not a preservation rule: the vendor recommendation is optional and has
 * an explicit opt-out. Evaluators may report the advisory, but it must never reject or mark a
 * dispatch unrepaired.
 */
export interface StaleContentAdvisoryRule {
  /** Discriminator selecting the non-blocking advisory evaluator. */
  type: 'staleContentAdvisory'
  /** Stable identifier used for reporting and selective disabling. */
  id: string
  /** Historical primitive kind whose stale content is being recommended against. */
  kind: OrderingPrimitiveKind
  /** Content older than the latest non-tool-call user turn is advisory-stale. */
  scope: 'before-latest-user-turn'
  /**
   * Name of the vendor's explicit opt-out setting, such as `preserveThinking`; this documents why
   * the advisory exists and corresponds to {@link OrderingGuardOptions.disableAdvisoryRuleIds}.
   */
  optOutOptionKey: string
}

/** Every declarative ordering rule supported by the validation battery. */
export type OrderingRule =
  | OrderRule
  | RequiredMetadataRule
  | AlternationRule
  | AdjacencyRule
  | PreservationRule
  | RoleRemapRule
  | StaleContentAdvisoryRule

/** A named collection of ordering rules for a model or hosting layer. */
export interface OrderingProfile {
  /** Stable profile or behavior name. */
  name: string
  /** Vendor citation and date checked, or an explanation of the profile's scope. */
  description: string
  /** True when the target documents no role-order limitation. */
  permissive?: boolean
  /** Rules evaluated for this profile. */
  rules: OrderingRule[]
}

/** Configuration for an ordering guard middleware. */
export interface OrderingGuardOptions {
  /** Profiles to resolve and evaluate, by registry name or consumer-authored profile object. */
  profiles: (string | OrderingProfile)[]
  /** Profile composition strategy; defaults to `union-of-rules`. */
  mode?: 'union-of-rules' | 'each' | 'first-match'
  /** `enforce` validates without mutation; `mutate` applies safe repairs before re-evaluation. */
  action?: 'enforce' | 'mutate'
  /** Whether remaining blocking violations are nacked or thrown; defaults to `nack`. */
  onViolation?: 'nack' | 'throw'
  /** Whether applied repairs are logged or kept silent; defaults to `log`. */
  onRepair?: 'log' | 'silent'
  /**
   * Stronger, separate opt-in for vendor metadata fabrication. `action: 'mutate'` alone never
   * fills missing metadata: unlike reordering or an empty filler, this can make a provenance claim.
   * Both this flag and mutate action must be enabled for fallback repair to run.
   */
  allowMetadataFallbackRepair?: boolean
  /** Stash key used for the stateful preservation snapshot. */
  snapshotStashKey?: string
  /** Advisory rule ids to skip entirely; this cannot suppress any blocking rule. */
  disableAdvisoryRuleIds?: string[]
}

/** The rule types that are permitted to feed the nack/throw path. */
export type BlockingOrderingRuleType = Exclude<OrderingRule['type'], 'staleContentAdvisory'>

/** A violation that is structurally eligible for repair or rejection. */
export interface BlockingOrderingViolation {
  /** Stable rule identifier. */
  ruleId: string
  /** A non-advisory rule discriminator; required metadata is blocking unless its severity opts out. */
  ruleType: BlockingOrderingRuleType
  /**
   * Required discriminant proving this entry may feed repair or rejection. A required metadata
   * rule uses this same shape only when its configured severity is `blocking`.
   */
  severity: 'blocking'
  /** Profile that produced the violation. */
  profileName: string
  /** Primitive ids involved in the failed invariant. */
  primitiveIds: string[]
  /** Human-readable explanation of the failed invariant. */
  detail: string
}

/** A non-blocking informational advisory violation. */
export interface OrderingAdvisoryViolation {
  /** Stable advisory rule identifier. */
  ruleId: string
  /** Advisory-producing rule types; required metadata is included when `severity: 'advisory'`. */
  ruleType: StaleContentAdvisoryRule['type'] | RequiredMetadataRule['type']
  /**
   * Required discriminant proving this entry can never feed the nack/throw path. Advisory
   * required-metadata findings use this shape when their configured severity is `advisory`.
   */
  severity: 'advisory'
  /** Profile that produced the advisory. */
  profileName: string
  /** Primitive ids carrying the advisory stale content. */
  primitiveIds: string[]
  /** Human-readable explanation of the recommendation. */
  detail: string
}

/** Any reported ordering issue, whether blocking or informational. */
export type OrderingViolation = BlockingOrderingViolation | OrderingAdvisoryViolation

/** One safe mutation applied while repairing a blocking violation. */
export interface OrderingRepair {
  /** The blocking violation this repair addressed. */
  violation: BlockingOrderingViolation
  /** Safe repair strategy used by mutate mode. */
  strategy: 'reorder' | 'insert-alternation-filler' | 'fill-required-metadata'
  /** Description of the concrete timeline or primitive change. */
  detail: string
  /** `'reorder'` only: id of the primitive that was moved. Typed so the applying middleware never
   *  has to parse `detail`'s prose to recover what it already computed. */
  targetId?: string
  /** `'reorder'` only: id of the primitive the target was moved to sort immediately before. */
  blockerId?: string
}

/** Result retained by the guard after evaluating or repairing a dispatch. */
export interface OrderingGuardResult {
  /** Repairs applied during this invocation. */
  repaired: OrderingRepair[]
  /** Blocking violations remaining after any requested repairs; only these can reject a dispatch. */
  unrepaired: BlockingOrderingViolation[]
  /** Advisory findings retained for observability and explicitly excluded from rejection. */
  advisories: OrderingAdvisoryViolation[]
}
