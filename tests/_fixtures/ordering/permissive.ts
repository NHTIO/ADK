/**
 * PERMISSIVE — the deliberately empty baseline, and the audit's CONTROL.
 *
 * Corpus shape: the violating leg deliberately stacks every other scenario's forbidden shape at
 * once — consecutive user turns, a message after a tool call, a trailing assistant, a late
 * thought. Under a profile that declares no rules, the guard must stay completely silent.
 *
 * This is the control in the strict sense: if this leg EVER reports a violation, the harness is
 * broken, not the model — and every other scenario's result in that run is suspect. It is also
 * the liveness check for a live cell, since it is the one leg guaranteed to be guard-clean.
 */
import { msg, state, tc, thk, type OrderingScenario } from './types'
import { CCRA_TOOLS, PATHOLOGICAL_NOTICE, REVIEW_PROMPT } from './corpus'

const PROMPT = REVIEW_PROMPT
const ANSWER = 'The overflow guard is missing when the header exceeds MAX_SAFE_INTEGER.'

export const permissiveScenario: OrderingScenario = {
  id: 'permissive',
  profile: 'permissive',
  ruleIds: [],
  ruleType: 'none',
  claim: 'xAI Grok documents NO role-order limitation — the empty baseline.',
  prompt: PROMPT,
  // Every forbidden shape in the audit, simultaneously.
  violating: {
    state: state(
      [
        msg('m1', 'user', 1, PROMPT),
        msg('m2', 'user', 2, PATHOLOGICAL_NOTICE),
        msg('m3', 'assistant', 4, ANSWER),
      ],
      [thk('t1', 5)],
      [tc('c1', 3, { tool: CCRA_TOOLS.artifactCat, args: { callId: 'call-1', start: 1, end: 60 } })]
    ),
    guard: { blocking: 0, advisories: 0 },
    wire: 'accepted',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 0 },
    wire: 'accepted',
  },
}
