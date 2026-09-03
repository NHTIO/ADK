/**
 * ADVISORY — vendor hygiene recommendations that must NEVER gate dispatch.
 *
 * Corpus shape: inverted relative to every other scenario. The "violating" leg carries the shape
 * the vendor discourages, and its prediction is that BOTH the guard and the wire accept it. What
 * is under audit is the non-blocking-ness itself: an advisory that blocks is as much a defect as
 * a blocking rule that does not.
 *
 * Worth stating plainly: this scenario passing is what CORRECT looks like. It is the counterweight
 * to the blocking scenarios — evidence that the battery's severity distinction is real and not
 * just declared.
 */
import { REVIEW_PROMPT } from './corpus'
import { msg, state, thk, type OrderingScenario } from './types'

const PROMPT = REVIEW_PROMPT
const FOLLOWUP = 'Also check the backoff helper for the same overflow.'

export const staleThinkingAdvisoryScenario: OrderingScenario = {
  id: 'stale_thinking_advisory',
  profile: 'stale_thinking_advisory',
  ruleIds: ['stale-thinking-gemma4'],
  ruleType: 'staleContentAdvisory',
  claim: 'Gemma 4 RECOMMENDS dropping stale thinking; it must never gate dispatch.',
  prompt: FOLLOWUP,
  // t1 predates the latest user turn (m2 @4) — advisory-stale, but must still dispatch.
  violating: {
    state: state([msg('m1', 'user', 1, PROMPT), msg('m2', 'user', 4, FOLLOWUP)], [thk('t1', 2)]),
    guard: { blocking: 0, advisories: 1 },
    wire: 'accepted',
  },
  // One-feature delta: the stale thought is replaced by a current one.
  //
  // CORPUS DEFECT, kept deliberately with its finding. `thk('t2', 5)` is stamped AFTER the latest
  // user turn (m2 @4), so a createdAt-ordered timeline ends on the thought — and on Gemini that
  // renders as a terminal `model` turn carrying only a `thought: true` part. Measured on
  // gemma-4-26b-a4b-it: that shape returns `finishReason: MALFORMED_RESPONSE` with no content,
  // 4 out of 4, while the same history ending on the user turn returns STOP with text.
  //
  // So the cell's `compliant-fails` verdict is NOT about stale thinking — it is a SECOND, real
  // vendor constraint the corpus stumbled into: a Gemini request must not end on a thought-only
  // model turn. That deserves its own scenario rather than being buried here, and the timestamps
  // must NOT be quietly reordered to make this cell pass — doing so would discard the finding.
  compliant: {
    state: state([msg('m1', 'user', 1, PROMPT), msg('m2', 'user', 4, FOLLOWUP)], [thk('t2', 5)]),
    guard: { blocking: 0, advisories: 0 },
    // Was 'accepted'. Measured: the assembled shape ends on a thought-only model turn, which this
    // vendor refuses deterministically. Recording rather than asserting a success we do not see.
    wire: 'unknown',
  },
}
