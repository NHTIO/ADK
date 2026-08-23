import { isObject } from '@nhtio/adk/guards'
import type { Message, Thought, ToolCall } from '@nhtio/adk/common'
import type {
  BlockingOrderingViolation,
  OrderingAdvisoryViolation,
  OrderingProfile,
  OrderingRule,
  OrderingRepair,
  OrderingTimelineEntry,
} from './types'

const getDotPath = (value: unknown, path: string): unknown => {
  let current = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Writes `value` at `path` inside `target`, creating any missing intermediate objects.
 * The write-side counterpart to {@link getDotPath} — a fallback repair must populate the exact
 * same nested location the evaluator reads, or the post-repair re-evaluation never clears.
 *
 * @remarks
 * Every intermediate object the path walks through is SHALLOW-CLONED before being written into,
 * even when it already exists — never mutated in place. A caller that only shallow-copies its own
 * top-level `target` (e.g. `{ ...snapshot.payload }`) still shares every NESTED object with the
 * original by reference; writing through those without cloning would corrupt the original
 * primitive's payload as a side effect of "repairing" an unrelated copy.
 */
export const setDotPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.')
  let current = target
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const existing = current[segment]
    current[segment] = isObject(existing) ? { ...existing } : {}
    current = current[segment] as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}

const idOf = (entry: OrderingTimelineEntry): string => {
  const value = entry.value as { id?: unknown }
  return typeof value.id === 'string' ? value.id : `${entry.kind}:${entry.seq}`
}

const blocking = (
  rule: Exclude<OrderingRule, { type: 'staleContentAdvisory' }>,
  profile: OrderingProfile,
  entries: OrderingTimelineEntry[],
  detail: string
): BlockingOrderingViolation => ({
  ruleId: rule.id,
  ruleType: rule.type,
  severity: 'blocking',
  profileName: profile.name,
  primitiveIds: entries.map(idOf),
  detail,
})

const advisory = (
  rule: Extract<OrderingRule, { type: 'staleContentAdvisory' }>,
  profile: OrderingProfile,
  entries: OrderingTimelineEntry[],
  detail: string
): OrderingAdvisoryViolation => ({
  ruleId: rule.id,
  ruleType: rule.type,
  severity: 'advisory',
  profileName: profile.name,
  primitiveIds: entries.map(idOf),
  detail,
})

const metadataAdvisory = (
  rule: Extract<OrderingRule, { type: 'requiredMetadata' }>,
  profile: OrderingProfile,
  entry: OrderingTimelineEntry,
  detail: string
): OrderingAdvisoryViolation => ({
  ruleId: rule.id,
  ruleType: rule.type,
  severity: 'advisory',
  profileName: profile.name,
  primitiveIds: [idOf(entry)],
  detail,
})

const entriesForKind = (timeline: OrderingTimelineEntry[], kind: OrderingTimelineEntry['kind']) =>
  timeline.filter((entry) => entry.kind === kind)

const roleGroups = (timeline: OrderingTimelineEntry[]): OrderingTimelineEntry[][] => {
  const roles = timeline.map((entry, index) => {
    if (entry.kind === 'message') return entry.role
    let prior = index - 1
    while (prior >= 0 && timeline[prior].kind !== 'message') prior--
    let following = index + 1
    while (following < timeline.length && timeline[following].kind !== 'message') following++
    // A primitive run between a user prompt and the following assistant message is
    // the assistant turn being assembled; this keeps the canonical thinking/tool run
    // together even when adapters timestamp its blocks before the assistant envelope.
    if (
      prior >= 0 &&
      following < timeline.length &&
      timeline[prior].role === 'user' &&
      timeline[following].role === 'assistant'
    )
      return 'assistant'
    if (prior < 0 && following >= timeline.length) return undefined
    if (prior < 0) return timeline[following].role
    return timeline[prior].role
  })
  const groups: OrderingTimelineEntry[][] = []
  let current: OrderingTimelineEntry[] = []
  let role: OrderingTimelineEntry['role']
  timeline.forEach((entry, index) => {
    if (current.length > 0 && roles[index] !== role) {
      groups.push(current)
      current = []
    }
    role = roles[index]
    current.push(entry)
  })
  if (current.length > 0) groups.push(current)
  return groups
}

const requiredEntries = (
  timeline: OrderingTimelineEntry[],
  rule: Extract<OrderingRule, { type: 'requiredMetadata' }>
) => {
  const candidates = entriesForKind(timeline, rule.kind).filter((entry) => {
    if (rule.gatedByReplayCompatibility === undefined) return true
    const compatibility = (entry.value as { replayCompatibility?: string }).replayCompatibility
    return rule.gatedByReplayCompatibility.includes(compatibility ?? '')
  })
  if (rule.applyTo === 'every') return candidates
  return roleGroups(timeline).flatMap((group) => {
    const first = group.find((entry) => entry.kind === rule.kind)
    return first !== undefined && candidates.includes(first) ? [first] : []
  })
}

/**
 * Builds the adapter-compatible, deterministically ordered primitive timeline.
 *
 * @param messages - Messages to place first in the insertion-order tie-break domain.
 * @param thoughts - Thoughts to place after messages in the tie-break domain.
 * @param toolCalls - Tool calls to place after thoughts in the tie-break domain.
 * @returns A new timeline sorted by creation time and then insertion sequence.
 * @remarks The fixed collection order mirrors existing adapters, making equal-millisecond behavior
 * predictable instead of introducing a guard-only wire ordering.
 */
export const buildOrderingTimeline = (
  messages: Iterable<Message>,
  thoughts: Iterable<Thought>,
  toolCalls: Iterable<ToolCall>
): OrderingTimelineEntry[] => {
  const entries: OrderingTimelineEntry[] = []
  let seq = 0
  for (const value of messages)
    entries.push({
      kind: 'message',
      at: value.createdAt.toMillis(),
      seq: seq++,
      role: value.role,
      value,
    })
  for (const value of thoughts)
    entries.push({
      kind: 'thought',
      at: value.createdAt.toMillis(),
      seq: seq++,
      role: undefined,
      value,
    })
  for (const value of toolCalls)
    entries.push({
      kind: 'toolCall',
      at: value.createdAt.toMillis(),
      seq: seq++,
      role: undefined,
      value,
    })
  return entries.sort((a, b) => a.at - b.at || a.seq - b.seq)
}

/**
 * Evaluates all stateless ordering rules in a profile.
 *
 * @param timeline - Stable primitive timeline to inspect.
 * @param profile - Declarative rules and reporting identity.
 * @returns Blocking violations and non-blocking advisory findings.
 * @remarks Preservation is intentionally skipped: its previous snapshot belongs in middleware,
 * where the long-lived dispatch context exists; keeping this evaluator pure prevents hidden state.
 */
export const evaluateOrderingProfile = (
  timeline: OrderingTimelineEntry[],
  profile: OrderingProfile
): {
  blocking: BlockingOrderingViolation[]
  advisories: OrderingAdvisoryViolation[]
} => {
  const result: {
    blocking: BlockingOrderingViolation[]
    advisories: OrderingAdvisoryViolation[]
  } = { blocking: [], advisories: [] }
  for (const rule of profile.rules) {
    if (rule.type === 'preservation') continue
    if (rule.type === 'order') {
      const groups = rule.scope === 'entire-turn' ? [timeline] : roleGroups(timeline)
      const selected = rule.onlyLatestGroup ? groups.slice(-1) : groups
      for (const group of selected) {
        const before = group.filter((entry) => entry.kind === rule.before)
        const after = group.filter((entry) => entry.kind === rule.after)
        if (
          before.length > 0 &&
          after.length > 0 &&
          group.indexOf(before[before.length - 1]) > group.indexOf(after[0])
        ) {
          result.blocking.push(
            blocking(
              rule,
              profile,
              [...before, ...after],
              `${rule.before} must precede ${rule.after} in its ordering group.`
            )
          )
        }
      }
    } else if (rule.type === 'requiredMetadata') {
      for (const entry of requiredEntries(timeline, rule)) {
        if (
          getDotPath((entry.value as { payload?: unknown }).payload, rule.requiredPayloadKey) ===
          undefined
        ) {
          const detail = `Payload is missing required field ${rule.requiredPayloadKey}.`
          if (rule.severity === 'advisory') {
            result.advisories.push(metadataAdvisory(rule, profile, entry, detail))
          } else {
            result.blocking.push(blocking(rule, profile, [entry], detail))
          }
        }
      }
    } else if (rule.type === 'alternation') {
      const messages = timeline.filter(
        (entry) => entry.kind === 'message' && entry.role !== undefined
      )
      for (let index = 1; index < messages.length; index++) {
        if (messages[index].role === messages[index - 1].role) {
          result.blocking.push(
            blocking(
              rule,
              profile,
              messages.slice(index - 1, index + 1),
              `Message roles must alternate; both entries are ${messages[index].role}.`
            )
          )
        }
      }
      if (rule.maxPerGroup !== undefined) {
        for (const group of roleGroups(timeline)) {
          const calls = group.filter((entry) => entry.kind === 'toolCall')
          if (calls.length > rule.maxPerGroup) {
            result.blocking.push(
              blocking(
                rule,
                profile,
                calls,
                `At most ${rule.maxPerGroup} tool call(s) are allowed in one role group.`
              )
            )
          }
        }
      }
    } else if (rule.type === 'adjacency') {
      const firstEntries = entriesForKind(timeline, rule.first)
      for (const first of firstEntries) {
        const firstIndex = timeline.indexOf(first)
        const next = timeline[firstIndex + 1]
        // The final entry has no successor, so there is no primitive that can violate adjacency.
        if (next !== undefined && rule.disallowBetween.includes(next.kind)) {
          result.blocking.push(
            blocking(
              rule,
              profile,
              [first, next],
              `A ${next.kind} may not immediately follow this ${rule.first}.`
            )
          )
        }
      }
    } else if (rule.type === 'roleRemap') {
      for (const entry of entriesForKind(timeline, rule.kind)) {
        if (
          getDotPath((entry.value as { payload?: unknown }).payload, rule.expectedRoleTag) !==
          rule.variant
        ) {
          result.blocking.push(
            blocking(
              rule,
              profile,
              [entry],
              `Expected role-remap tag ${rule.expectedRoleTag} to equal ${rule.variant}.`
            )
          )
        }
      }
    } else if (rule.type === 'staleContentAdvisory') {
      const latestUser = timeline
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.kind === 'message' && entry.role === 'user')
        .at(-1)
      if (latestUser) {
        const stale = timeline.filter(
          (entry, index) => entry.kind === rule.kind && index < latestUser.index
        )
        if (stale.length > 0)
          result.advisories.push(
            advisory(
              rule,
              profile,
              stale,
              `${rule.kind} content predates the latest user turn and is recommended for removal.`
            )
          )
      }
    }
  }
  return result
}

/**
 * Combines profiles without mutating their rule arrays.
 *
 * @param profiles - Profiles whose rules should be composed in supplied order.
 * @returns A profile containing every input rule, with a deterministic synthesized name.
 * @remarks Union composition is intentionally mechanical so independently sourced vendor rules
 * remain visible and are not silently deduplicated by coincidental ids.
 */
export const unionOfRules = (profiles: OrderingProfile[]): OrderingProfile => ({
  name: `union(${profiles.map((profile) => profile.name).join('+')})`,
  description: `Union of ${profiles.map((profile) => profile.name).join(', ')}.`,
  permissive: profiles.every((profile) => profile.permissive === true),
  rules: profiles.flatMap((profile) => [...profile.rules]),
})

/**
 * Describes safe repairs for blocking violations without changing caller-owned data.
 *
 * @param timeline - Timeline used to locate implicated primitives; it is never mutated.
 * @param violations - Blocking findings to classify; they are never mutated.
 * @param profiles - Optional profiles used only by explicitly enabled metadata fallback repair.
 * @returns Repairs for reorder/filler strategies and all remaining violations.
 * @remarks Metadata fallback is deliberately unreachable when profiles are omitted.
 */
export const repairViolations = (
  timeline: OrderingTimelineEntry[],
  violations: BlockingOrderingViolation[],
  profiles?: OrderingProfile[]
): {
  repaired: OrderingRepair[]
  unrepaired: BlockingOrderingViolation[]
  timeline: OrderingTimelineEntry[]
} => {
  const copy = timeline.map((entry) => ({ ...entry }))
  const repaired: OrderingRepair[] = []
  const unrepaired: BlockingOrderingViolation[] = []
  for (const violation of violations) {
    if (violation.ruleType === 'order' && violation.primitiveIds.length >= 2) {
      const implicated = copy.filter((entry) => violation.primitiveIds.includes(idOf(entry)))
      const match = /^(\w+) must precede (\w+)/.exec(violation.detail)
      const target = implicated.find((entry) => entry.kind === match?.[1])
      const blocker = implicated.find((entry) => entry.kind === match?.[2])
      if (target !== undefined && blocker !== undefined && target !== blocker) {
        // The rule's directional relationship identifies the item to move. The returned copy is
        // pre-ordered and must not be re-sorted by callers, or the repair would be undone.
        copy.splice(copy.indexOf(target), 1)
        copy.splice(copy.indexOf(blocker), 0, target)
        repaired.push({
          violation,
          strategy: 'reorder',
          detail: `Move ${idOf(target)} immediately before ${idOf(blocker)} in the pre-ordered timeline.`,
          targetId: idOf(target),
          blockerId: idOf(blocker),
        })
        continue
      }
    }
    if (violation.ruleType === 'requiredMetadata' && profiles !== undefined) {
      const rule = profiles
        .find((profile) => profile.name === violation.profileName)
        ?.rules.find((candidate) => candidate.id === violation.ruleId)
      if (rule?.type === 'requiredMetadata' && rule.fallbackPayloadValue !== undefined) {
        repaired.push({
          violation,
          strategy: 'fill-required-metadata',
          detail: `Fill ${violation.primitiveIds[0]} payload.${rule.requiredPayloadKey} with a configured fallback value.`,
        })
        continue
      }
    }
    if (violation.ruleType === 'alternation' && violation.primitiveIds.length >= 2) {
      repaired.push({
        violation,
        strategy: 'insert-alternation-filler',
        detail: `Insert synthetic user_continue_message-${violation.primitiveIds[1]} between ${violation.primitiveIds[0]} and ${violation.primitiveIds[1]}; the middleware must materialize the filler.`,
      })
      continue
    }
    unrepaired.push(violation)
  }
  return {
    repaired,
    unrepaired,
    timeline: copy,
  }
}
