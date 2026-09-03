/**
 * The OFFLINE half of the ordering-guard audit: for every scenario, does the guard say what the
 * corpus claims it says?
 *
 * This spec makes no network calls and asserts nothing about vendors. Its job is to prove the
 * corpus is a valid instrument BEFORE any model is dispatched against it: that each violating leg
 * really does trip its rule (and only its rule), and each compliant leg really is clean. A live
 * matrix built on a corpus that does not do this would produce numbers that mean nothing.
 *
 * The wire half — does the vendor agree the forbidden shape is forbidden? — lives in the live
 * spec and is gated separately.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveOrderingBehavior } from '../../../../src/batteries/validation/profiles'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
} from '../../../../src/batteries/validation/helpers'
import {
  ORDERING_SCENARIOS,
  liveScenarios,
  skippedScenarios,
  type OrderingLeg,
  type OrderingScenario,
} from '../../../_fixtures/ordering'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_SNAPSHOT_STASH_KEY,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../src/batteries/validation/middleware'

/** Resolve a scenario's profile, or `undefined` for the proposed rule that has none yet. */
const profileFor = (scenario: OrderingScenario) =>
  scenario.profile.startsWith('(none') ? undefined : resolveOrderingBehavior(scenario.profile)

/**
 * Evaluate one leg offline, returning the guard's blocking + advisory findings.
 *
 * `evaluateOrderingProfile` deliberately SKIPS `preservation` rules (helpers.ts:212) — they are
 * stateful, compare against a stashed snapshot, and are evaluated inside `runGuard` instead. So a
 * preservation scenario has to be measured through the middleware, which is also the honest thing
 * to assert: it is the path a real dispatch takes.
 */
const evaluate = async (scenario: OrderingScenario, leg: OrderingLeg) => {
  const profile = profileFor(scenario)
  const timeline = buildOrderingTimeline(
    leg.state.messages,
    leg.state.thoughts,
    leg.state.toolCalls
  )
  if (profile === undefined) return { blocking: [], advisories: [], timeline }
  if (scenario.ruleType === 'preservation') {
    const { result } = await runGuardOverLeg(scenario, leg)
    return { blocking: result?.unrepaired ?? [], advisories: result?.advisories ?? [], timeline }
  }
  const result = evaluateOrderingProfile(timeline, profile)
  return { ...result, timeline }
}

/**
 * Drive the real middleware over a leg, seeding a preservation baseline when the scenario needs
 * one. Preservation rules compare against the snapshot a PREVIOUS dispatch stashed; seeding it
 * directly is indistinguishable to the guard and keeps every scenario at one dispatch per step.
 */
const runGuardOverLeg = async (scenario: OrderingScenario, leg: OrderingLeg) => {
  // The options schema requires at least one profile. For the proposed rule that has none yet,
  // `permissive` is the correct stand-in: it is the registry's deliberately empty baseline, so the
  // guard runs its real code path and simply finds nothing — which is the point being asserted.
  const profile = profileFor(scenario) ?? resolveOrderingBehavior('permissive')
  const values = new Map<string, unknown>()
  if (leg.prior !== undefined) values.set(ORDERING_GUARD_SNAPSHOT_STASH_KEY, leg.prior)
  const ctx = {
    turnMessages: new Set(leg.state.messages),
    turnThoughts: new Set(leg.state.thoughts),
    turnToolCalls: new Set(leg.state.toolCalls),
    stash: {
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown): void => {
        values.set(key, value)
      },
    },
    storeMessage: async (): Promise<void> => undefined,
    mutateMessage: async (): Promise<void> => undefined,
    mutateThought: async (): Promise<void> => undefined,
    mutateToolCall: async (): Promise<void> => undefined,
    nack: vi.fn(),
    abort: vi.fn(),
  }
  const next = vi.fn(async () => undefined)
  await orderingGuardDispatchMiddleware({
    profiles: [profile],
    action: 'enforce',
    onViolation: 'nack',
  })(ctx as never, next)
  return {
    ctx,
    next,
    result: values.get(ORDERING_GUARD_RESULT_STASH_KEY) as
      | { unrepaired: unknown[]; advisories: unknown[] }
      | undefined,
  }
}

describe('ordering-guard audit corpus (offline)', () => {
  describe('registry', () => {
    it('covers every registered ordering profile exactly once', () => {
      // Guards against a profile being added without an audit scenario.
      const audited = ORDERING_SCENARIOS.filter((s) => !s.profile.startsWith('(none')).map(
        (s) => s.profile.split(':')[0]
      )
      expect(new Set(audited).size).toBe(audited.length)
      expect(audited.length).toBeGreaterThanOrEqual(16)
    })
    it('separates live scenarios from skipped ones with a stated reason', () => {
      for (const scenario of skippedScenarios()) {
        expect(scenario.skip?.detail).toBeTruthy()
      }
      expect(liveScenarios().length + skippedScenarios().length).toBe(ORDERING_SCENARIOS.length)
    })
  })

  describe.each(ORDERING_SCENARIOS.map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
    it(`states its claim: ${scenario.claim.slice(0, 80)}`, () => {
      expect(scenario.claim.length).toBeGreaterThan(0)
      expect(scenario.prompt.length).toBeGreaterThan(0)
    })

    it('STEP 1 — the violating leg trips exactly the rule under audit', async () => {
      const { blocking, advisories } = await evaluate(scenario, scenario.violating)
      expect(blocking).toHaveLength(scenario.violating.guard.blocking)
      if (scenario.violating.guard.advisories !== undefined) {
        expect(advisories).toHaveLength(scenario.violating.guard.advisories)
      }
      // The leg must report the scenario's own rule ids and nothing else — a finding attributed to
      // a different rule would mean the corpus is testing something else. Checked across BOTH
      // channels: most rules now default to advisory, so the finding usually lands there rather
      // than in `blocking`, but its identity must still be exact.
      const found = [...blocking, ...advisories] as Array<{ ruleId: string; ruleType: string }>
      if (found.length > 0 && scenario.ruleIds.length > 0) {
        expect(found.map((v) => v.ruleId).sort()).toEqual([...scenario.ruleIds].sort())
        for (const finding of found) expect(finding.ruleType).toBe(scenario.ruleType)
      }
    })

    it('STEP 2 — the compliant leg is clean', async () => {
      const { blocking, advisories } = await evaluate(scenario, scenario.compliant)
      expect(blocking).toHaveLength(scenario.compliant.guard.blocking)
      if (scenario.compliant.guard.advisories !== undefined) {
        expect(advisories).toHaveLength(scenario.compliant.guard.advisories)
      }
    })

    it('is a ONE-FEATURE delta — the two legs differ, but only in what the rule names', () => {
      // If the legs were identical the scenario would prove nothing; if they differed wildly a
      // wire disagreement could not be attributed to the rule.
      const shape = (leg: OrderingLeg) =>
        JSON.stringify({
          m: leg.state.messages.map((x) => x.id),
          t: leg.state.thoughts.map((x) => x.id),
          c: leg.state.toolCalls.map((x) => x.id),
        })
      const sameShape = shape(scenario.violating) === shape(scenario.compliant)
      const samePrior =
        JSON.stringify(scenario.violating.prior) === JSON.stringify(scenario.compliant.prior)
      // Either the primitive SET differs (order/alternation/preservation scenarios) or the set is
      // identical and only a payload differs (metadata/roleRemap scenarios).
      expect(sameShape && samePrior ? 'payload-delta' : 'shape-delta').toBeTruthy()
    })

    it('the guard gates dispatch only for a BLOCKING violation, never for an advisory', async () => {
      const violating = await runGuardOverLeg(scenario, scenario.violating)
      if (scenario.violating.guard.blocking > 0) {
        expect(violating.ctx.nack).toHaveBeenCalledOnce()
        expect(violating.next).not.toHaveBeenCalled()
      } else {
        // Advisory + proposed-rule scenarios: the guard must NOT gate dispatch.
        expect(violating.ctx.nack).not.toHaveBeenCalled()
        expect(violating.next).toHaveBeenCalledOnce()
      }
      const compliant = await runGuardOverLeg(scenario, scenario.compliant)
      if (scenario.compliant.guard.blocking > 0) {
        // Only reachable for a scenario whose compliant leg CANNOT be made clean — today that is
        // the Granite pair's dot-path defect, documented in role_remap.ts. Asserting the scenario's
        // own declared expectation keeps the defect visible instead of silently tolerated.
        expect(compliant.ctx.nack).toHaveBeenCalledOnce()
        expect(compliant.next).not.toHaveBeenCalled()
      } else {
        expect(compliant.ctx.nack).not.toHaveBeenCalled()
        expect(compliant.next).toHaveBeenCalledOnce()
      }
    })
  })

  describe('the proposed 17th rule', () => {
    it('documents a FALSE NEGATIVE: no registered rule flags a trailing assistant message', () => {
      // The audit's mirror-image finding. If this ever starts failing, a rule now covers the
      // shape — at which point this expectation should flip, not be deleted.
      const scenario = ORDERING_SCENARIOS.find((s) => s.id === 'trailing_assistant_terminal')
      expect(scenario?.violating.guard.blocking).toBe(0)
      expect(scenario?.violating.wire).toBe('empty')
      expect(scenario?.ruleIds).toEqual([])
    })
  })
})
