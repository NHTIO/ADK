/**
 * Shared vocabulary for the ordering-guard audit. Pure types + primitive builders,
 * ENVIRONMENT-NEUTRAL (no `vitest`, no `node:*`) so an offline unit spec and a live wire spec
 * both import it.
 *
 * WHY THIS EXISTS
 *
 * Each ordering profile in `batteries/validation` encodes a vendor claim ("Llama 3 permits one
 * tool call per turn", "a Message may not immediately follow a ToolCall") derived from vendor
 * DOCUMENTATION, never from observed traffic. Issue #15 reports that several reject turn state
 * that dispatches fine — i.e. the rule, not the history, is wrong.
 *
 * A rule earns its place only if BOTH legs hold, ONE DISPATCH EACH:
 *
 *   STEP 1 (`violating`)  the shape the rule forbids genuinely fails on the wire — an HTTP error,
 *                         OR a 200 carrying no generation. If the provider accepts it happily the
 *                         rule is unjustified, and THAT is the finding: a failing step 1 is a
 *                         publishable result, not a broken test.
 *   STEP 2 (`compliant`)  the shape the rule demands actually dispatches. A rule you cannot
 *                         satisfy is as broken as one you need not.
 *
 * Step 3 (repair) is deliberately NOT encoded yet — 7 of 16 profiles have no repair path today
 * and the design is still open. Steps 1 and 2 get wired and proven first.
 *
 * Each scenario lives in its OWN module, because a rule's corpus has to be shaped by the thing it
 * tests: an alternation violation is a message sequence, a metadata violation is a payload, a
 * preservation violation is a delta against a prior snapshot. Forcing them through one shared
 * corpus would mean the corpus stops expressing what each rule is actually about.
 *
 * Within a scenario, `compliant` differs from `violating` by EXACTLY the property the rule names
 * — same ids, same content, same tool — so a wire disagreement has exactly one candidate cause.
 */
import { DateTime } from 'luxon'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'

// ─── Primitive builders ───────────────────────────────────────────────────────

/** Seconds-since-epoch → DateTime. Ordering is decided by `createdAt`, so every builder is explicit. */
export const at = (second: number): DateTime => DateTime.fromMillis(second * 1000)

/** A conversation message. */
export const msg = (
  id: string,
  role: 'user' | 'assistant',
  second: number,
  content?: string
): Message =>
  new Message({
    id,
    role,
    content: content ?? `message ${id}`,
    createdAt: at(second),
    updatedAt: at(second),
  })

/**
 * A reasoning thought. `payload` carries vendor metadata (signature, roleTag, channel).
 *
 * A present `payload` REQUIRES a present `replayCompatibility` — an ADK cross-field invariant: the
 * payload is vendor-opaque, so the ADK needs a tag saying which adapter may replay it. The builder
 * supplies a default tag rather than making every scenario repeat one.
 */
export const thk = (
  id: string,
  second: number,
  content?: string,
  payload?: Record<string, unknown>,
  replayCompatibility = 'ordering-audit-v1'
): Thought =>
  new Thought({
    id,
    content: content ?? `thought ${id}`,
    createdAt: at(second),
    updatedAt: at(second),
    ...(payload === undefined ? {} : { payload, replayCompatibility }),
  } as never)

/**
 * A completed tool call. Results live ON the call in this ADK — there is no tool-result Message.
 *
 * As with {@link thk}, a present `payload` requires a `replayCompatibility` tag; the builder
 * defaults it so scenarios stay about the rule under audit.
 */
export const tc = (
  id: string,
  second: number,
  opts?: {
    tool?: string
    args?: Record<string, unknown>
    result?: string
    payload?: Record<string, unknown>
    replayCompatibility?: string
  }
): ToolCall =>
  new ToolCall({
    id,
    tool: opts?.tool ?? 'read_file',
    args: opts?.args ?? { path: 'config.yml' },
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable(opts?.result ?? 'config.yml has 42 lines'),
    createdAt: at(second),
    updatedAt: at(second),
    completedAt: at(second),
    ...(opts?.payload === undefined
      ? {}
      : {
          payload: opts.payload,
          replayCompatibility: opts.replayCompatibility ?? 'ordering-audit-v1',
        }),
  } as never)

// ─── Turn state ───────────────────────────────────────────────────────────────

/** The three primitive sets a dispatch's turn state is assembled from. */
export interface OrderingTurnState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

/** Assemble a turn state; any omitted kind is empty. */
export const state = (
  messages: Message[] = [],
  thoughts: Thought[] = [],
  toolCalls: ToolCall[] = []
): OrderingTurnState => ({ messages, thoughts, toolCalls })

/**
 * One entry of a pre-seeded preservation baseline.
 *
 * Preservation rules compare the current timeline against a snapshot the guard stashed on the
 * PREVIOUS dispatch. Rather than burn a throwaway dispatch to create that history, a scenario
 * seeds the stash directly — the guard reads the prior snapshot from
 * `ORDERING_GUARD_SNAPSHOT_STASH_KEY` and cannot tell the difference. That keeps every scenario
 * at ONE dispatch per step, including the cross-dispatch invariants.
 */
export interface PriorSnapshotEntry {
  id: string
  kind: 'message' | 'thought' | 'toolCall'
  payload?: unknown
  at: number
}

// ─── Expectations ─────────────────────────────────────────────────────────────

/**
 * What the WIRE is predicted to do with a leg.
 *
 * `rejected` — an HTTP error naming the constraint.
 * `empty`    — HTTP 200 carrying no usable generation (`content: null`/`""`, no tool_calls,
 *              near-zero completion tokens). Observed in production on Nova: a success that
 *              generates nothing, burns the full prompt, and repeats verbatim. Scoring this as a
 *              pass would hide the very failure mode worth catching.
 * `accepted` — HTTP 200 with real content or a tool call.
 *
 * `unknown`  — the guard's verdict is known but the VENDOR's is not, and the traffic gives no
 *              basis to predict it. Used where a compliant shape satisfies the rule without any
 *              evidence that it is what makes the request succeed (see the Gemini sentinel note in
 *              `required_metadata.ts`). A cell that runs an `unknown` leg RECORDS the outcome
 *              rather than asserting one — the measurement is the point.
 *
 * `rejected-or-empty` is the honest prediction for most step-1 legs: a vendor may enforce a shape
 * rule with a 400 OR by silently generating nothing, and which one it picks is itself a result.
 */
export type WireOutcome = 'accepted' | 'empty' | 'rejected' | 'rejected-or-empty' | 'unknown'

/** What `runGuard` is predicted to say about a leg, offline. */
export interface GuardExpectation {
  /** Count of BLOCKING violations. */
  blocking: number
  /** Count of advisory findings; omitted means "not asserted". */
  advisories?: number
}

/** One step of a scenario: a single dispatch, plus whatever prior state it needs. */
export interface OrderingLeg {
  /** The turn state dispatched. */
  state: OrderingTurnState
  /** Offline guard prediction. */
  guard: GuardExpectation
  /** Predicted wire outcome. */
  wire: WireOutcome
  /** Pre-seeded preservation baseline; only preservation scenarios set this. */
  prior?: PriorSnapshotEntry[]
}

/**
 * Provider-side conditions a live cell MUST record alongside its verdict, because they change what
 * a result means.
 *
 * Anthropic traffic in the reference corpus is Claude Code, and 100% of it carries beta headers.
 * Two of them govern rules in this very audit:
 *
 *   `interleaved-thinking-2025-05-14`  (2,489 reqs) — thinking blocks may be INTERLEAVED with tool
 *       calls, so `thinking_before_tool_use`'s "thought must precede tool use" may be conditional
 *       on this header rather than absolute.
 *   `context-management-2025-06-27`    (2,468 reqs) — the SERVER may drop history, which is exactly
 *       the loss `full_history_preservation` treats as a client-side violation.
 *
 * A passing Anthropic cell is uninterpretable without knowing which of these were in force, so the
 * live spec captures them per cell instead of assuming a bare API.
 */
export interface ProviderConditions {
  /** `anthropic-beta` values sent upstream, split on comma. */
  anthropicBeta?: string[]
  /** Gemini `toolConfig.functionCallingConfig.mode`, when set. */
  toolCallingMode?: 'ANY' | 'AUTO' | 'NONE'
  /** Free-form note about anything else that could change interpretation. */
  note?: string
}

/** Why a scenario cannot be settled empirically right now. */
export interface OrderingSkip {
  /**
   * `requires-custom-renderer` — the cell is testable in principle, but only once the consumer-side
   * renderer the rule presupposes is installed (see `granite_renderer.ts`). NOT an impossibility:
   * message assembly is an injectable helper on every LLM battery, so a field the default renderer
   * ignores becomes wire-visible under one that reads it.
   */
  reason: 'no-credential' | 'no-model' | 'provider-invisible' | 'requires-custom-renderer'
  detail: string
}

/** One profile's audit: exactly two dispatches — the shape it forbids, the shape it demands. */
export interface OrderingScenario {
  /** Scenario id, matching the profile registry name where possible. */
  id: string
  /** Registry name from `ORDERING_PROFILES`, or a parameterized token like `full_history_preservation:toolCall`. */
  profile: string
  /** Rule ids the violating leg must produce. */
  ruleIds: string[]
  /** The rule type under audit. */
  ruleType:
    | 'order'
    | 'requiredMetadata'
    | 'alternation'
    | 'adjacency'
    | 'preservation'
    | 'roleRemap'
    | 'staleContentAdvisory'
    | 'none'
  /** The vendor claim this scenario audits, in one line. */
  claim: string
  /** The natural-language task the corpus is built around, sent as the live prompt. */
  prompt: string
  /** STEP 1 — the shape the rule forbids. */
  violating: OrderingLeg
  /** STEP 2 — the same shape, minimally corrected. */
  compliant: OrderingLeg
  /** Present when the wire leg cannot run. */
  skip?: OrderingSkip
}
