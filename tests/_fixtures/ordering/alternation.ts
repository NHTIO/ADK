/**
 * ALTERNATION — strict user↔assistant cycling, and the Llama 3 one-call-per-group cap.
 *
 * Two rules share a type but forbid different things, so they get different corpora.
 *
 * `strict_alternation` is about MESSAGE SEQUENCE. Its violating leg is drawn straight from real
 * CCRA traffic, where consecutive `user` turns are routine: the harness injects notices (a
 * pathological-pattern notice, a job-clock reminder, batching guidance) alongside the seat's own
 * task, and they land as separate user messages. Observed transition counts on real requests
 * included `user→user: 62` in a single conversation.
 *
 * `single_tool_call_per_turn` is about TOOL COUNT within one group — parallel calls, which the CCRA
 * seats issue routinely when investigating several files at once.
 */
import { msg, state, tc, type OrderingScenario } from './types'
import { CCRA_TOOLS, PATHOLOGICAL_NOTICE, REVIEW_PROMPT } from './corpus'

export const strictAlternationScenario: OrderingScenario = {
  id: 'strict_alternation',
  profile: 'strict_alternation',
  ruleIds: ['strict-user-assistant-alternation'],
  ruleType: 'alternation',
  claim: 'Nova/DeepSeek/Gemma/Llama require strict user↔assistant alternation.',
  prompt: REVIEW_PROMPT,
  // Two consecutive user turns: the review task, then an injected harness notice.
  violating: {
    state: state([msg('m1', 'user', 1, REVIEW_PROMPT), msg('m2', 'user', 2, PATHOLOGICAL_NOTICE)]),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: the same two contents merged into one user turn — the fix a consumer
  // would actually apply, since the notice has to reach the model somehow.
  compliant: {
    state: state([msg('m1', 'user', 1, `${REVIEW_PROMPT}\n\n${PATHOLOGICAL_NOTICE}`)]),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}

export const singleToolCallPerTurnScenario: OrderingScenario = {
  id: 'single_tool_call_per_turn',
  profile: 'single_tool_call_per_turn',
  ruleIds: ['single-tool-call-per-turn'],
  ruleType: 'alternation',
  claim: 'Llama 3 permits at most ONE ToolCall per same-role group (no parallel calls).',
  prompt: REVIEW_PROMPT,
  // Two parallel reads in one group — the shape a review seat produces when checking two files.
  violating: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT)],
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
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: the parallel second call is dropped.
  compliant: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.readFile, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}
