/**
 * TRAILING ASSISTANT — the 17th scenario. No profile exists for it yet; this is the PROPOSAL.
 *
 * Unlike every other scenario in this audit, this rule was not derived from vendor documentation.
 * It was found in real CCRA review traffic, which is why its step-1 prediction names a specific
 * outcome (`empty`) instead of hedging with `rejected-or-empty`.
 *
 * THE OBSERVATION (LLM load-balancer logs, CCRA traffic, 45-day window)
 *
 * A 200 OK carrying no generation at all:
 *
 *     {"choices":[{"index":0,"message":{"role":"assistant","content":null},
 *       "finish_reason":"stop"}],
 *      "usage":{"prompt_tokens":27553,"completion_tokens":2,"total_tokens":27555}}
 *
 * 27,553 tokens in, 2 out, `finish_reason: "stop"`. The harness then re-sends a BYTE-IDENTICAL
 * request (same `requestSize`, 3–6x in a row, ~1.2s apart) and gets the same empty response — a
 * livelock that burns the full prompt per iteration while looking like success to any status-code
 * check.
 *
 * THE MECHANISM — two distinct CCRA nudges, both producing the same terminal shape:
 *
 *   1. `prose-echo-thought` — the seat wrote prose without calling a tool, so the harness appends
 *      a `user` nudge and RE-APPENDS THE PROSE as a trailing assistant thought.
 *   2. `pathological-pattern-stop-thought` — the seat repeated near-identical tool calls, so the
 *      harness appends a `user` notice and re-appends THE SAME TEXT as a trailing assistant
 *      thought. Verbatim duplication: the assistant turn contains nothing the model was not just
 *      told.
 *
 * Both leave the request ending `user → assistant`, asking the model to continue past its own turn.
 *
 * THE EVIDENCE — CCRA traffic, 200 OKs, empty = responseSize<=330, healthy = >=600:
 *
 *     base rate of empty generation           577/60,776  =  0.95%
 *     P(empty | prose-echo-thought)            78/932     =  8.37%   →  8.8x
 *     P(empty | pathological-pattern-stop)    139/5,442   =  2.55%   →  2.7x
 *
 * And on trailing role alone (Nova, same model, same window): 14/14 of empty generations ended on
 * an assistant message, against 1/14 of healthy ones. Ten further Nova empties sampled from CCRA
 * traffic were 10/10 `… → user → assistant`.
 *
 * WHY THIS MATTERS FOR THE AUDIT
 *
 * This is a FALSE NEGATIVE — the mirror of the adjacency false positive. No registered rule flags
 * a trailing assistant message, while `openai_shape_baseline` blocks `tool→message`, which the same
 * production 200s show vendors accepting ~295 times over.
 *
 * HONESTY NOTE: this is correlational. The enrichment is strong and consistent across two
 * independent nudge mechanisms and several models (Nova 188, claude-opus-5 108, gpt-5.6-luna 51,
 * deepseek-v3.2 22), but proving CAUSATION under our own hand is exactly what this scenario is
 * for. Note also that empty-generation requests carry 3–26 `tool→message` transitions each and so
 * do healthy ones: adjacency does NOT discriminate here, trailing-role does. This scenario does not
 * rescue the adjacency rule — it displaces it.
 */
import { type OrderingScenario } from './types'
import { PROSE_ECHO, trailingEchoRemovedTurn, trailingEchoTurn } from './corpus'

export const trailingAssistantScenario: OrderingScenario = {
  id: 'trailing_assistant_terminal',
  profile: '(none — proposed)',
  // No rule ids: nothing in the registry covers this shape. The empty array is the assertion.
  ruleIds: [],
  ruleType: 'none',
  claim:
    'PROPOSED: history must not END on an assistant message with no following tool result. ' +
    'Predicted FALSE NEGATIVE — guard passes, wire generates nothing.',
  prompt: 'Review the changed hunks in this merge request and report any correctness defects.',
  violating: {
    // The real CCRA shape: tool call, user nudge, assistant echo of that nudge, nothing after.
    state: trailingEchoTurn(PROSE_ECHO),
    // The guard is expected to PASS — that is the defect being demonstrated, not a passing test.
    guard: { blocking: 0 },
    wire: 'empty',
  },
  compliant: {
    // One-feature delta: the echoed assistant turn is gone; the turn ends on the tool result.
    state: trailingEchoRemovedTurn(),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}
