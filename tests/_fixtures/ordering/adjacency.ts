/**
 * ADJACENCY — "a Message may not immediately follow a ToolCall".
 *
 * Corpus shape, taken from real CCRA review turns: a seat is asked to review a diff, reasons, calls
 * a read-only tool, then states its conclusion. The violating leg is that ORDINARY completed tool
 * turn — the concluding assistant message is the entire violation. If it is genuinely forbidden, no
 * tool-using turn can ever conclude.
 *
 * That prediction is already in tension with observed traffic: across successful CCRA-era 200s,
 * `tool→assistant` appeared ~295 times and every one was accepted, on 15 of 21 distinct models. So
 * step 1 is expected to FAIL here — which is the finding, not a broken test.
 *
 * Both profiles carry a byte-identical rule differing only in id, so they share this corpus and
 * differ only in which id the violation must report. 27 of 38 family recipes carry one of them.
 */
import { msg, state, tc, thk, type OrderingScenario } from './types'
import { CCRA_TOOLS, REVIEW_PROMPT, healthyReviewTurn } from './corpus'

const FINDING = 'The overflow guard is missing when the header value exceeds MAX_SAFE_INTEGER.'

/** m1 user → t1 thought → c1 toolCall → m2 assistant conclusion. The trailing message violates. */
const violatingState = () =>
  state(
    [msg('m1', 'user', 1, REVIEW_PROMPT), msg('m2', 'assistant', 4, FINDING)],
    [thk('t1', 2, 'The retry-after parser changed; check the overflow path.')],
    [tc('c1', 3, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
  )

export const openaiShapeBaselineScenario: OrderingScenario = {
  id: 'openai_shape_baseline',
  profile: 'openai_shape_baseline',
  ruleIds: ['message-not-immediately-after-tool-call'],
  ruleType: 'adjacency',
  claim: 'A Message may not be immediately wedged after a ToolCall.',
  prompt: REVIEW_PROMPT,
  violating: {
    state: violatingState(),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: the concluding message is gone; the turn ends on the tool result.
  compliant: { state: healthyReviewTurn(), guard: { blocking: 0 }, wire: 'accepted' },
}

export const functionResponseAdjacencyScenario: OrderingScenario = {
  id: 'function_response_adjacency',
  profile: 'function_response_adjacency',
  ruleIds: ['message-not-immediately-after-function-call'],
  ruleType: 'adjacency',
  claim:
    'Gemini: a Message may not immediately follow a ToolCall before the call sequence continues.',
  prompt: REVIEW_PROMPT,
  violating: {
    state: violatingState(),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  compliant: { state: healthyReviewTurn(), guard: { blocking: 0 }, wire: 'accepted' },
}
