/**
 * PRESERVATION — cross-dispatch continuity invariants.
 *
 * Corpus shape: these are the only rules that compare against HISTORY rather than the current
 * timeline, so each leg carries a `prior` snapshot alongside its state. The guard reads the prior
 * from `ORDERING_GUARD_SNAPSHOT_STASH_KEY` (middleware.ts:320) and cannot tell a seeded baseline
 * from one a previous dispatch wrote — so seeding keeps these at ONE dispatch per step, matching
 * every other scenario, instead of burning a throwaway dispatch to establish history.
 *
 * The delta between legs is what the SECOND dispatch does to the first's history: drop a call,
 * mutate a signature, prune recent reasoning. Content is a real CCRA review turn — history loss is
 * exactly what a long review run risks, since those requests reach 2.7MB and get shed under
 * context pressure (one real CCRA request died on `prompt is too long: 1000004 > 1000000`).
 */
import { CCRA_TOOLS, REVIEW_PROMPT } from './corpus'
import { msg, state, tc, thk, type OrderingScenario, type PriorSnapshotEntry } from './types'

const PROMPT = REVIEW_PROMPT
/** A follow-up review turn, as the panel issues when a seat is asked to widen its scope. */
const FOLLOWUP = 'Also check the backoff helper for the same overflow.'

// ── full_history_preservation:toolCall ───────────────────────────────────────
// Prior held two calls; this dispatch drops one.

const twoCallsPrior: PriorSnapshotEntry[] = [
  { id: 'm1', kind: 'message', at: 1000 },
  { id: 'c1', kind: 'toolCall', at: 2000 },
  { id: 'c2', kind: 'toolCall', at: 3000 },
]

export const fullHistoryPreservationScenario: OrderingScenario = {
  id: 'full_history_preservation',
  profile: 'full_history_preservation:toolCall',
  ruleIds: ['full-history-preservation-toolCall'],
  ruleType: 'preservation',
  claim: 'Kimi/Qwen/MiniMax/Codex/DeepSeek: historical ToolCall count must never decrease.',
  // Family selection: minimax-m2 (minimax.minimax-m2.5). deepseek-v3.2 was considered and DROPPED —
  // it resolves to `deepseek-v3-base`, which does NOT carry this rule (the deepseek families that do
  // are deepseek-thinking and deepseek-v4). Testing a rule against a family whose recipe never
  // declares it would measure something other than the rule.
  prompt: PROMPT,
  // c2 has been dropped relative to the prior snapshot.
  violating: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.readFile, args: { path: 'src/retry.ts' } })]
    ),
    prior: twoCallsPrior,
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: both calls retained.
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [
        tc('c1', 2, { tool: CCRA_TOOLS.readFile, args: { path: 'src/retry.ts' } }),
        tc('c2', 3, {
          tool: CCRA_TOOLS.readFile,
          args: { path: 'src/backoff.ts' },
          result: 'export const backoff = (n: number) => 2 ** n',
        }),
      ]
    ),
    prior: twoCallsPrior,
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}

// ── payload_field_preservation:signature ─────────────────────────────────────
// An opaque vendor signature must stay byte-stable. This is the one scenario with a KNOWN hard
// wire failure: Anthropic rejects a mutated/stale thinking signature with a 400 invalid-request,
// so its violating leg predicts `rejected` outright rather than `rejected-or-empty`.

const signaturePrior = (signature: string): PriorSnapshotEntry[] => [
  { id: 'm1', kind: 'message', at: 1000 },
  { id: 't1', kind: 'thought', at: 2000, payload: { signature } },
]

export const payloadFieldPreservationScenario: OrderingScenario = {
  id: 'payload_field_preservation',
  profile: 'payload_field_preservation:signature',
  ruleIds: ['payload-field-preservation-thought-signature'],
  ruleType: 'preservation',
  claim: 'Anthropic: a thought’s opaque signature must remain byte-stable across dispatches.',
  prompt: PROMPT,
  violating: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [thk('t1', 2, undefined, { signature: 'sig-MUTATED' })]
    ),
    prior: signaturePrior('sig-original'),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [thk('t1', 2, undefined, { signature: 'sig-original' })]
    ),
    prior: signaturePrior('sig-original'),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}

// ── reasoning_pruned_after_latest_turn ───────────────────────────────────────
// Asymmetric: reasoning OLDER than the latest user turn MAY be dropped; reasoning at/after it may
// not. Both legs prune exactly one thought — they differ only in WHICH, which is the whole rule.

const prunedPrior: PriorSnapshotEntry[] = [
  { id: 'm1', kind: 'message', at: 1000 },
  { id: 't1', kind: 'thought', at: 2000 },
  { id: 'm2', kind: 'message', at: 4000 },
  { id: 't2', kind: 'thought', at: 5000 },
]

export const reasoningPrunedAfterLatestTurnScenario: OrderingScenario = {
  id: 'reasoning_pruned_after_latest_turn',
  profile: 'reasoning_pruned_after_latest_turn',
  ruleIds: ['reasoning-pruned-after-latest-turn'],
  ruleType: 'preservation',
  claim:
    'Qwen 3 may drop reasoning OLDER than the latest user turn, but must retain recent reasoning unchanged.',
  prompt: FOLLOWUP,
  // Drops t2, which sits AFTER the latest user turn (m2 @4) — the forbidden half.
  violating: {
    state: state([msg('m1', 'user', 1, PROMPT), msg('m2', 'user', 4, FOLLOWUP)], [thk('t1', 2)]),
    prior: prunedPrior,
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: drops t1 (the OLD thought) instead — explicitly permitted.
  compliant: {
    state: state([msg('m1', 'user', 1, PROMPT), msg('m2', 'user', 4, FOLLOWUP)], [thk('t2', 5)]),
    prior: prunedPrior,
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}
