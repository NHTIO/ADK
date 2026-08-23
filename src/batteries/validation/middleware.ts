import { validateOptions } from './validation'
import { getOrderingProfile } from './profiles'
import { createOrderingViolationError } from './exceptions'
import { Message, Thought, ToolCall } from '@nhtio/adk/common'
import { FAMILY_RECIPES, resolveFamilyRecipe } from './profiles/families'
// Not re-exported from any public barrel (no battery-facing use case for the raw symbols exists
// yet); this battery's repair path is one of the few real consumers of the snapshot round-trip
// mechanism itself, mirroring the accepted-shared-runtime tier's rationale in CONTRIBUTING.md #13.
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
  OrderingGuardOptions,
  OrderingGuardResult,
  OrderingProfile,
  OrderingRepair,
  OrderingTimelineEntry,
} from './types'

/** `ctx.stash` key under which the prior-iteration primitive snapshot is kept for
 *  {@link @nhtio/adk!PreservationRule} statefulness — see the plan's "Statefulness for
 *  `PreservationRule`" section. Exported (as `ORDERING_GUARD_SNAPSHOT_STASH_KEY`) so a caller
 *  can pass a custom `options.snapshotStashKey` without guessing the default's exact string. */
const SNAPSHOT = '__orderingGuardSnapshot'
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
): BlockingOrderingViolation[] => {
  if (!prior) return []
  const current = snapshotOf(timeline)
  const output: BlockingOrderingViolation[] = []
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
        output.push({
          ruleId: rule.id,
          ruleType: 'preservation',
          severity: 'blocking',
          profileName: profile.name,
          primitiveIds: broken.map((entry) => entry.id),
          detail: `Preservation invariant ${rule.invariant} was violated for ${rule.kind}.`,
        })
      }
    }
  }
  return output
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
    if (repair.strategy === 'reorder') {
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
    const id = `__ordering-guard-filler-${firstId}-${secondId}`
    const date = new Date(at)
    const message = new Message({
      id,
      role,
      content: id,
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
  const timeline = buildOrderingTimeline(ctx.turnMessages, ctx.turnThoughts, ctx.turnToolCalls)
  const evaluations = profiles.map((profile) => evaluateOrderingProfile(timeline, profile))
  const blocked = evaluations.flatMap((evaluation) => evaluation.blocking)
  const advisories = evaluations
    .flatMap((evaluation) => evaluation.advisories)
    .filter((violation) => !options.disableAdvisoryRuleIds?.includes(violation.ruleId))
  const prior = ctx.stash.get<Snapshot | undefined>(options.snapshotStashKey ?? SNAPSHOT)
  const preservation = preservationViolations(timeline, prior, profiles)
  const allBlocked = [...blocked, ...preservation]
  // The snapshot is replaced even on rejection so retries compare against the state just observed.
  ctx.stash.set(options.snapshotStashKey ?? SNAPSHOT, snapshotOf(timeline))
  if (options.action !== 'mutate')
    return {
      blocked: allBlocked,
      result: { repaired: [], unrepaired: allBlocked, advisories },
    }
  const repaired = repairViolations(
    timeline,
    allBlocked,
    options.allowMetadataFallbackRepair === true ? profiles : undefined
  )
  const applied = await applyRepairs(ctx, repaired.repaired, timeline, profiles)
  const effectiveTimeline = [...repaired.timeline]
  for (const entry of applied.timeline) {
    const index = effectiveTimeline.findIndex((candidate) => idOf(candidate) === idOf(entry))
    if (index >= 0) effectiveTimeline[index] = entry
  }
  const synthetic = {
    timeline: applied.timeline.filter((entry) =>
      idOf(entry).startsWith('__ordering-guard-filler-')
    ),
    placement: applied.placement,
  }
  for (const entry of synthetic.timeline) {
    const firstId = synthetic.placement.get(idOf(entry))
    const firstIndex = effectiveTimeline.findIndex((candidate) => idOf(candidate) === firstId)
    effectiveTimeline.splice(firstIndex < 0 ? effectiveTimeline.length : firstIndex + 1, 0, entry)
  }
  // Reorder/metadata repairs are already applied to the REAL turn state by this point (applyRepairs
  // called the matching ctx.mutate* for each), so an adapter's own next history-assembly pass sees
  // the corrected order/payload without reading this stash entry at all. It is kept for observability
  // — a caller can inspect exactly what the guard did this iteration without re-deriving it.
  ctx.stash.set(EFFECTIVE_TIMELINE, effectiveTimeline)
  const postRepairBlocking = profiles.flatMap(
    (profile) => evaluateOrderingProfile(effectiveTimeline, profile).blocking
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
