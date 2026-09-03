import { validateOptions } from './validation'
import { getOrderingProfile } from './profiles'
import { isInstanceOf } from '@nhtio/adk/guards'
import { createOrderingViolationError } from './exceptions'
import { Message, Thought, ToolCall } from '@nhtio/adk/common'
import { FAMILY_RECIPES, resolveFamilyRecipe } from './profiles/families'
import { ENCODE_METHOD, DECODE_METHOD } from '../../lib/utils/encoder_symbols'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
  setDotPath,
  unionOfRules,
} from './helpers'
import type { NextFn } from '@nhtio/middleware'
import type {
  TurnContext,
  DispatchContext,
  TurnPipelineMiddlewareFn,
  DispatchPipelineMiddlewareFn,
} from '@nhtio/adk/types'
import type {
  BlockingOrderingViolation,
  OrderingAdvisoryViolation,
  OrderingGuardOptions,
  OrderingGuardResult,
  OrderingProfile,
  OrderingRepair,
  OrderingStashedTimelineEntry,
  OrderingTimelineEntry,
} from './types'

/** `ctx.stash` key under which the prior-iteration primitive snapshot is kept for
 *  {@link @nhtio/adk!PreservationRule} statefulness — see the plan's "Statefulness for
 *  `PreservationRule`" section. Exported (as `ORDERING_GUARD_SNAPSHOT_STASH_KEY`) so a caller
 *  can pass a custom `options.snapshotStashKey` without guessing the default's exact string. */
const SNAPSHOT = '__orderingGuardSnapshot'
/**
 * Id prefix marking a message this guard synthesised as an alternation filler.
 *
 * @remarks
 * Load-bearing in two places: fillers are excluded from the timeline the guard evaluates (so its
 * own output can never become its next input), and a consumer can recognise and drop them when
 * persisting turn state.
 */
const FILLER_PREFIX = '__ordering-guard-filler-'
/**
 * Body of a synthesised filler turn.
 *
 * @remarks
 * Deliberately anodyne. A filler exists only to satisfy a provider's role-alternation grammar, so
 * its content should be the least assertive thing that still counts as a turn — it must not put
 * words in the model's mouth or in the user's.
 */
const FILLER_CONTENT = 'Understood.'
/**
 * Monotonic source of filler ids, never reset.
 *
 * @remarks
 * Per-dispatch numbering would repeat ids across dispatches, which only stays harmless while
 * `ctx.deleteMessage` is available to reap the previous batch. `deleteMessage` is optional on
 * {@link GuardContext}, so a store that keeps them would end up holding several messages under one
 * id. Counting for the life of the process costs nothing and removes that dependency.
 */
let fillerSequence = 0
/** `ctx.stash` key under which the most recent {@link OrderingGuardResult} (repaired +
 *  unrepaired + advisories) is recorded, so a caller or a later pipeline stage can inspect
 *  exactly what this middleware did on the current iteration without parsing the nack error. */
const RESULT = '__orderingGuardLastResult'
/** `ctx.stash` key under which the post-repair "effective timeline" (the in-memory,
 *  already-ordered copy `repairViolations` produced, with any inserted alternation fillers)
 *  is recorded for the current iteration, so repairs can be re-evaluated against it. */
const EFFECTIVE_TIMELINE = '__orderingGuardEffectiveTimeline'

type GuardContext = Pick<
  TurnContext,
  | 'stash'
  | 'turnMessages'
  | 'turnThoughts'
  | 'turnToolCalls'
  | 'storeMessage'
  | 'mutateMessage'
  | 'mutateToolCall'
  | 'mutateThought'
> &
  // Optional: `toolIdentity` and `schemaIntegrity` read the request's declared tools, and
  // `deleteMessage` reaps this guard's own spent fillers. Optional so every existing caller — and
  // every test double — keeps working without them.
  Partial<Pick<TurnContext, 'tools' | 'deleteMessage'>> &
  Partial<Pick<DispatchContext, 'nack'>> &
  Pick<TurnContext, 'abort'>

type SnapshotEntry = {
  id: string
  kind: OrderingTimelineEntry['kind']
  payload: unknown
  at: number
}

type Snapshot = SnapshotEntry[]

const idOf = (entry: OrderingTimelineEntry): string => {
  const id = (entry.value as { id?: unknown }).id
  return typeof id === 'string' ? id : `${entry.kind}:${entry.seq}`
}

const path = (value: unknown, key: string): unknown => {
  let current = value
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const snapshotOf = (timeline: OrderingTimelineEntry[]): Snapshot =>
  timeline.map((entry) => ({
    id: idOf(entry),
    kind: entry.kind,
    payload: (entry.value as { payload?: unknown }).payload,
    at: entry.at,
  }))

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const preservationViolations = (
  timeline: OrderingTimelineEntry[],
  prior: Snapshot | undefined,
  profiles: OrderingProfile[]
): { blocking: BlockingOrderingViolation[]; advisories: OrderingAdvisoryViolation[] } => {
  if (!prior) return { blocking: [], advisories: [] }
  const current = snapshotOf(timeline)
  const output: BlockingOrderingViolation[] = []
  const advisories: OrderingAdvisoryViolation[] = []
  const seen = new Set<string>()
  for (const profile of profiles) {
    for (const rule of profile.rules) {
      if (rule.type !== 'preservation' || seen.has(`${profile.name}:${rule.id}`)) continue
      // Model identity is not part of DispatchContext/TurnContext, so resetOnModelSwitch is deliberately deferred until the runner exposes it.
      seen.add(`${profile.name}:${rule.id}`)
      const before = prior.filter((entry) => entry.kind === rule.kind)
      const now = current.filter((entry) => entry.kind === rule.kind)
      let broken: SnapshotEntry[] = []
      if (rule.invariant === 'count-non-decreasing') {
        if (now.length < before.length)
          broken = before.filter((entry) => !now.some((item) => item.id === entry.id))
      } else if (rule.invariant === 'payload-field-stable') {
        broken = before.filter((entry) => {
          const found = now.find((item) => item.id === entry.id)
          return (
            found === undefined ||
            !same(
              path(entry.payload, rule.payloadField ?? ''),
              path(found.payload, rule.payloadField ?? '')
            )
          )
        })
      } else {
        const latestUser = timeline
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.kind === 'message' && entry.role === 'user')
          .at(-1)
        const boundary = latestUser ? timeline[latestUser.index].at : -Infinity
        const retained = before.filter((entry) => entry.at >= boundary)
        broken = retained.filter((entry) => {
          const found = now.find((item) => item.id === entry.id)
          return found === undefined || !same(found.payload, entry.payload)
        })
      }
      if (broken.length > 0) {
        const detail = `Preservation invariant ${rule.invariant} was violated for ${rule.kind}.`
        const shared = {
          ruleId: rule.id,
          ruleType: 'preservation' as const,
          profileName: profile.name,
          primitiveIds: broken.map((entry) => entry.id),
          detail,
        }
        // Honour the rule's own severity, defaulting to ADVISORY like every other rule type. This
        // was hardcoded `blocking`, which meant a preservation profile gated dispatch regardless of
        // what the recipe asked for. See OrderRule.severity for why advisory is the default.
        if (rule.severity === 'blocking') output.push({ ...shared, severity: 'blocking' })
        else advisories.push({ ...shared, severity: 'advisory' })
      }
    }
  }
  return { blocking: output, advisories }
}

const resolveProfiles = (options: OrderingGuardOptions): OrderingProfile[] => {
  const profiles = options.profiles.map((profile) => {
    if (typeof profile !== 'string') return profile
    if (profile === 'grok' || Object.prototype.hasOwnProperty.call(FAMILY_RECIPES, profile))
      return resolveFamilyRecipe(profile)
    return getOrderingProfile(profile)
  })
  if (options.mode === 'first-match') return profiles.slice(0, 1)
  if (options.mode === 'union-of-rules' || options.mode === undefined)
    return [unionOfRules(profiles)]
  return profiles
}

const logRepair = (repair: OrderingRepair): void => {
  // Middleware contexts have no helpers.log channel; console.warn preserves the repository's warn-level intent until observability injection exists.
  console.warn({
    kind: 'ordering-guard-repair',
    message: repair.detail,
    payload: repair,
  })
}

const enforceViolation = (
  ctx: GuardContext,
  options: OrderingGuardOptions,
  violations: BlockingOrderingViolation[]
): void => {
  const error = createOrderingViolationError(violations.length, violations[0].detail, violations)
  if (options.onViolation === 'throw') throw error
  if (ctx.nack) ctx.nack(error)
  else ctx.abort(error)
}

const applyRepairs = async (
  ctx: GuardContext,
  repairs: OrderingRepair[],
  timeline: OrderingTimelineEntry[],
  profiles: OrderingProfile[]
): Promise<{
  timeline: OrderingTimelineEntry[]
  placement: Map<string, string>
}> => {
  const synthetic: OrderingTimelineEntry[] = []
  const syntheticPlacement = new Map<string, string>()
  const effective = timeline.map((entry) => ({ ...entry }))
  for (const repair of repairs) {
    if (repair.strategy === 'fill-required-metadata') {
      const rule = profiles
        .find((p) => p.name === repair.violation.profileName)
        ?.rules.find((r) => r.id === repair.violation.ruleId)
      const entry = effective.find((e) => idOf(e) === repair.violation.primitiveIds[0])
      if (rule?.type !== 'requiredMetadata' || rule.fallbackPayloadValue === undefined || !entry)
        continue
      if (entry.kind === 'message') {
        // Message has no payload field; this repair cannot materialize on messages.
        continue
      }
      const snapshot = {
        ...((entry.value as ToolCall | Thought)[ENCODE_METHOD]() as Record<string, unknown>),
      }
      const payload =
        snapshot.payload && typeof snapshot.payload === 'object'
          ? { ...(snapshot.payload as Record<string, unknown>) }
          : {}
      setDotPath(payload, rule.requiredPayloadKey, rule.fallbackPayloadValue)
      snapshot.payload = payload
      if (
        snapshot.replayCompatibility === undefined &&
        rule.fallbackReplayCompatibility !== undefined
      )
        snapshot.replayCompatibility = rule.fallbackReplayCompatibility
      const replacement =
        entry.kind === 'toolCall'
          ? ToolCall[DECODE_METHOD](snapshot as never)
          : Thought[DECODE_METHOD](snapshot as never)
      if (entry.kind === 'toolCall') await ctx.mutateToolCall(replacement as ToolCall)
      else await ctx.mutateThought(replacement as Thought)
      effective[effective.indexOf(entry)] = { ...entry, value: replacement }
      continue
    }
    // `reorder-adjacent` (adjacency) and `reorder` (order) differ in how helpers.ts CHOOSES the
    // pair, not in how the move is applied: both name a target to place before a blocker, and both
    // populate the same typed fields. One materialiser serves both.
    if (repair.strategy === 'reorder' || repair.strategy === 'reorder-adjacent') {
      // Typed fields, not a prose-parsing regex against `detail` — `detail` is a human-readable
      // description that can legitimately be reworded in helpers.ts without this consumer noticing,
      // and a silently-broken parse here would let a violation continue to report as "repaired"
      // while never actually reaching the live turn state.
      const targetId = repair.targetId
      const blockerId = repair.blockerId
      const targetEntry = targetId ? effective.find((e) => idOf(e) === targetId) : undefined
      const blockerEntry = blockerId ? effective.find((e) => idOf(e) === blockerId) : undefined
      if (!targetEntry || !blockerEntry) continue
      // Timestamps, not array position, are what every LLM adapter's own history assembly sorts
      // by — moving `targetEntry` in this in-memory copy alone never reaches the wire. Nudge its
      // createdAt to sort at or before `blockerEntry`'s so the real turn state (not just this
      // guard's own bookkeeping) reflects the repaired order on the next timeline build.
      //
      // Never goes negative: some parts of this codebase (e.g. the context/compact summarizer) use
      // epoch-zero as a documented "sort before every real turn" sentinel — shifting a repaired
      // primitive to a NEGATIVE timestamp would sort it before that sentinel, inverting its
      // meaning, and a negative value can also throw inside `new Date(at).toISOString()`. When the
      // blocker is already at epoch zero, `at` ties rather than strictly precedes — this alone does
      // NOT guarantee the fix, so it is deliberately NOT reported as repaired here; the mandatory
      // post-repair re-evaluation (in runGuard, below) is what actually decides whether a tie
      // still resolves the violation (a tie can still resolve it, since the timeline's own tie-break
      // on identical timestamps is the target's position within its Set, and #replaceById-style
      // repairs preserve that position rather than moving the primitive to the end) — this comment
      // exists so a future reader doesn't mistake the clamp itself for the correctness guarantee.
      const at = Math.max(0, blockerEntry.at - 1)
      const snapshot = {
        ...(targetEntry.value[ENCODE_METHOD]() as Record<string, unknown>),
        createdAt: new Date(at).toISOString(),
      }
      const replacement =
        targetEntry.kind === 'toolCall'
          ? ToolCall[DECODE_METHOD](snapshot as never)
          : targetEntry.kind === 'thought'
            ? Thought[DECODE_METHOD](snapshot as never)
            : Message[DECODE_METHOD](snapshot as never)
      if (targetEntry.kind === 'toolCall') await ctx.mutateToolCall(replacement as ToolCall)
      else if (targetEntry.kind === 'thought') await ctx.mutateThought(replacement as Thought)
      else await ctx.mutateMessage(replacement as Message)
      const index = effective.indexOf(targetEntry)
      effective[index] = { ...targetEntry, at, value: replacement }
      continue
    }
    const [firstId, secondId] = repair.violation.primitiveIds
    const first = timeline.find((entry) => idOf(entry) === firstId)
    const second = timeline.find((entry) => idOf(entry) === secondId)
    if (!first || !second) continue
    const role = first.role === 'user' ? 'assistant' : 'user'
    const at = (first.at + second.at) / 2
    // A CONTENT-FREE id. It used to embed both neighbour ids, which is precisely why they nested:
    // a filler placed between two fillers inherited both of their already-compound ids. A counter
    // keeps it bounded and readable, and uniqueness now comes from position rather than lineage.
    const id = `${FILLER_PREFIX}${fillerSequence++}`
    const date = new Date(at)
    const message = new Message({
      id,
      role,
      // Neutral prose, NOT the id. The content used to be the id itself, so a
      // `__ordering-guard-filler-…` string was sent to the model as a genuine conversational turn —
      // a synthetic token sequence no vendor has ever seen, inserted to satisfy a role-alternation
      // check. This says the minimum a turn can say while still being a turn.
      content: FILLER_CONTENT,
      createdAt: date,
      updatedAt: date,
    })
    await ctx.storeMessage(message)
    synthetic.push({
      kind: 'message',
      at,
      seq: first.seq + 0.5,
      role,
      value: message,
    })
    syntheticPlacement.set(id, firstId)
  }
  return {
    timeline: [...effective, ...synthetic],
    placement: syntheticPlacement,
  }
}

const runGuard = async (
  ctx: GuardContext,
  options: OrderingGuardOptions
): Promise<{
  blocked: BlockingOrderingViolation[]
  result: OrderingGuardResult
}> => {
  const profiles = resolveProfiles(options)
  // Reap the previous dispatch's fillers before doing anything else.
  //
  // A filler is scaffolding for ONE dispatch: it exists to satisfy a provider's role-alternation
  // grammar for the request about to be sent, and has no meaning in the persisted transcript. Left
  // behind it accumulates without bound — issue #15 defect 2 — so each dispatch removes what the
  // last one built and re-derives from the real turn state. Excluding them from the timeline (just
  // below) keeps the guard correct even where `deleteMessage` is unavailable; this keeps the STORE
  // clean too.
  if (ctx.deleteMessage !== undefined) {
    for (const message of ctx.turnMessages) {
      if (message.id.startsWith(FILLER_PREFIX)) await ctx.deleteMessage(message.id)
    }
  }

  // Exclude this guard's OWN fillers from the timeline it evaluates.
  //
  // Issue #15 defect 2: a filler was materialised via `ctx.storeMessage` and never removed, so on
  // the next dispatch it was itself an input to alternation checking — the guard generated fillers
  // BETWEEN its own fillers, with ids nesting exponentially. Measured before this fix: 2 -> 5 -> 9
  // fillers over three iterations, ids reaching 139 characters, 5 of them duplicates, and
  // `repaired` AND `unrepaired` both non-empty for the same dispatch. A repair function whose
  // output is its own next input has no fixed point; excluding them gives it one.
  const timeline = buildOrderingTimeline(
    ctx.turnMessages,
    ctx.turnThoughts,
    ctx.turnToolCalls
  ).filter((entry) => !idOf(entry).startsWith(FILLER_PREFIX))
  // Supply the request's declared tools so `toolIdentity` and `schemaIntegrity` can run. Both
  // catch SILENT failures — a tool result naming an undeclared tool, and a schema whose `required`
  // names a key its `properties` omit — that providers answer with a normal 200 and no error.
  const declaredTools = (
    ctx as { tools?: { all?: () => ReadonlyArray<{ name: string; describe?: () => unknown }> } }
  ).tools
    ?.all?.()
    ?.map((tool) => {
      const described = tool.describe?.() as { name?: string; inputSchema?: unknown } | undefined
      return {
        name: described?.name ?? tool.name,
        inputSchema: described?.inputSchema,
      }
    })
  const evaluationContext = declaredTools === undefined ? undefined : { tools: declaredTools }
  const evaluations = profiles.map((profile) =>
    evaluateOrderingProfile(timeline, profile, evaluationContext)
  )
  const blocked = evaluations.flatMap((evaluation) => evaluation.blocking)
  const advisories = evaluations
    .flatMap((evaluation) => evaluation.advisories)
    .filter((violation) => !options.disableAdvisoryRuleIds?.includes(violation.ruleId))
  const prior = ctx.stash.get<Snapshot | undefined>(options.snapshotStashKey ?? SNAPSHOT)
  const preservation = preservationViolations(timeline, prior, profiles)
  const allBlocked = [...blocked, ...preservation.blocking]
  // Preservation advisories join the evaluator's own, and are subject to the same opt-out.
  const allAdvisories = [
    ...advisories,
    ...preservation.advisories.filter(
      (violation) => !options.disableAdvisoryRuleIds?.includes(violation.ruleId)
    ),
  ]
  // The snapshot is replaced even on rejection so retries compare against the state just observed.
  ctx.stash.set(options.snapshotStashKey ?? SNAPSHOT, snapshotOf(timeline))
  if (options.action !== 'mutate')
    return {
      blocked: allBlocked,
      result: { repaired: [], unrepaired: allBlocked, advisories: allAdvisories },
    }
  const repaired = repairViolations(
    timeline,
    allBlocked,
    options.allowMetadataFallbackRepair === true ? profiles : undefined,
    // Rules that authorize their own fallback are repairable WITHOUT the global flag. Narrowed to
    // just those rules, so enabling one vendor's documented sentinel never widens the surface to
    // sibling rules in the same profile.
    profiles
      .map((profile) => ({
        ...profile,
        rules: profile.rules.filter(
          (rule) => rule.type === 'requiredMetadata' && rule.fallbackRepairAuthorized === true
        ),
      }))
      .filter((profile) => profile.rules.length > 0)
  )
  const applied = await applyRepairs(ctx, repaired.repaired, timeline, profiles)
  const effectiveTimeline = [...repaired.timeline]
  for (const entry of applied.timeline) {
    const index = effectiveTimeline.findIndex((candidate) => idOf(candidate) === idOf(entry))
    if (index >= 0) effectiveTimeline[index] = entry
  }
  const synthetic = {
    timeline: applied.timeline.filter((entry) => idOf(entry).startsWith(FILLER_PREFIX)),
    placement: applied.placement,
  }
  for (const entry of synthetic.timeline) {
    const firstId = synthetic.placement.get(idOf(entry))
    const firstIndex = effectiveTimeline.findIndex((candidate) => idOf(candidate) === firstId)
    effectiveTimeline.splice(firstIndex < 0 ? effectiveTimeline.length : firstIndex + 1, 0, entry)
  }
  // `ctx.stash` (a Registry) klona-clones its ENTIRE store on every `.get()`, including for
  // unrelated keys — and klona's generic-object strategy does `new x.constructor()` before
  // copying properties. Message/Thought/ToolCall all throw on zero-arg construction (schema
  // validation requires a raw payload), so stashing `effectiveTimeline` with its live `.value`
  // instances verbatim poisons every subsequent `.get()` call for the rest of the dispatch. Its
  // own `[ENCODE_METHOD]()` snapshot doesn't fix this either — it still nests other live class
  // instances (`Identity`, Luxon `DateTime`) that klona chokes on the same way one level down.
  // Every consumer of the stashed timeline (`helpers.ts`, this file's own repair/apply paths,
  // and every profile spec that reads this stash key back out) only ever reads `.value.id`,
  // `.value.payload`, and `.value.replayCompatibility` — all plain values already — so project
  // just those onto a bare object instead of round-tripping through the full encoder snapshot.
  // A `.value` that isn't a real primitive instance (already-plain test doubles) is left as-is;
  // klona's crash is specific to non-plain-object constructors, so a plain object is already
  // stash-safe. `payload` itself is vendor-opaque (`unknown`) and can independently nest a
  // clone-hostile class instance (a caller-supplied `Identity`, a `DateTime`, anything with a
  // non-`Object` constructor) — every documented `payload` shape is meant to round-trip to a
  // wire protocol, i.e. JSON-serializable, so a JSON round-trip both proves that contract and
  // guarantees klona never walks into anything but plain objects/arrays/primitives.
  const toPlainJson = (value: unknown): unknown => {
    if (value === undefined) return undefined
    try {
      return JSON.parse(JSON.stringify(value)) as unknown
    } catch {
      return null
    }
  }
  const stashableTimeline: OrderingStashedTimelineEntry[] = effectiveTimeline.map((entry) => {
    const isPrimitiveInstance =
      isInstanceOf(entry.value, 'Message', Message) ||
      isInstanceOf(entry.value, 'Thought', Thought) ||
      isInstanceOf(entry.value, 'ToolCall', ToolCall)
    if (!isPrimitiveInstance) {
      const plain = entry.value as { payload?: unknown }
      return {
        ...entry,
        value: {
          ...(entry.value as OrderingStashedTimelineEntry['value']),
          payload: toPlainJson(plain.payload),
        },
      }
    }
    const raw = entry.value as { id?: unknown; payload?: unknown; replayCompatibility?: unknown }
    return {
      ...entry,
      value: {
        id: raw.id,
        payload: toPlainJson(raw.payload),
        replayCompatibility: raw.replayCompatibility,
      },
    }
  })
  ctx.stash.set(EFFECTIVE_TIMELINE, stashableTimeline)
  const postRepairBlocking = profiles.flatMap(
    (profile) => evaluateOrderingProfile(effectiveTimeline, profile, evaluationContext).blocking
  )
  const unrepaired = [...repaired.unrepaired]
  const known = new Set(
    unrepaired.map((violation) => `${violation.ruleId}:${violation.primitiveIds.join(',')}`)
  )
  for (const violation of postRepairBlocking) {
    const key = `${violation.ruleId}:${violation.primitiveIds.join(',')}`
    if (!known.has(key)) {
      known.add(key)
      unrepaired.push(violation)
    }
  }
  const result = { repaired: repaired.repaired, unrepaired, advisories }
  ctx.stash.set(RESULT, result)
  if (options.onRepair !== 'silent') repaired.repaired.forEach(logRepair)
  return { blocked: unrepaired, result }
}

const makeMiddleware = (
  options: OrderingGuardOptions
): DispatchPipelineMiddlewareFn | TurnPipelineMiddlewareFn => {
  const checked = validateOptions(options)
  return (async (ctx: DispatchContext | TurnContext, next: NextFn) => {
    const { blocked, result } = await runGuard(ctx as GuardContext, checked)
    if (checked.action === 'enforce') ctx.stash.set(RESULT, result)
    if (blocked.length > 0) {
      enforceViolation(ctx as GuardContext, checked, blocked)
      return
    }
    await next()
  }) as DispatchPipelineMiddlewareFn | TurnPipelineMiddlewareFn
}

/**
 * Builds a {@link @nhtio/adk!DispatchPipelineMiddlewareFn} that validates (and, in `'mutate'`
 * mode, best-effort repairs) turn-state primitive ordering against `options.profiles` before
 * every executor call.
 *
 * @remarks
 * Runs on every `dispatchInputPipeline` iteration, since that is the point where a caught
 * ordering bug is cheapest to fix — before the wire payload is ever built. See the plan's
 * "Middleware — `dispatchInputPipeline`/`turnInputPipeline` integration" section for why this
 * insertion point was chosen over a one-shot turn-level check alone.
 *
 * @param options - Validated via {@link validateOptions} at call time; throws
 * `E_INVALID_ORDERING_GUARD_OPTIONS` synchronously on malformed input.
 * @returns A middleware function following the `(ctx, next) => void | Promise<void>` idiom —
 * nacks via `ctx.nack(error)` (or throws, per `options.onViolation`) without calling `next()`
 * on an unrepaired blocking violation.
 */
export const orderingGuardDispatchMiddleware = (
  options: OrderingGuardOptions
): DispatchPipelineMiddlewareFn => makeMiddleware(options) as DispatchPipelineMiddlewareFn

/**
 * Builds a {@link @nhtio/adk!TurnPipelineMiddlewareFn} running the same ordering-guard core as
 * {@link orderingGuardDispatchMiddleware}, once per turn before the first executor call.
 *
 * @remarks
 * `TurnContext` has no `nack()` — only `abort()` — so the default `onViolation: 'nack'`
 * behavior maps to `ctx.abort(error)` here rather than a dispatch-style nack; `onViolation:
 * 'throw'` still throws in both middleware. This asymmetry is a real, documented difference
 * between the two contexts, not an inconsistency.
 *
 * @param options - Same shape and validation as {@link orderingGuardDispatchMiddleware}.
 * @returns A turn-pipeline middleware function with the same enforce/mutate semantics.
 */
export const orderingGuardTurnMiddleware = (
  options: OrderingGuardOptions
): TurnPipelineMiddlewareFn => makeMiddleware(options) as TurnPipelineMiddlewareFn

export {
  SNAPSHOT as ORDERING_GUARD_SNAPSHOT_STASH_KEY,
  RESULT as ORDERING_GUARD_RESULT_STASH_KEY,
  EFFECTIVE_TIMELINE as ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
}
