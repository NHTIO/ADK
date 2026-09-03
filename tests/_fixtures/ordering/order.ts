/**
 * ORDER — a relative-order requirement between two primitive KINDS.
 *
 * Corpus shape: identical primitives, different `createdAt` stamps. The delta between legs is purely
 * temporal, which makes these the cleanest scenarios in the audit — no content changes at all, only
 * which primitive sorts first.
 *
 * The content is a real CCRA investigation step: the seat reasons about where the risk is, then
 * reads the diff. Both rules concern whether that reasoning/preamble may follow the tool call
 * instead of preceding it.
 *
 * `order` is one of only three rule types `repairViolations` can currently repair (by reorder), so
 * these two also become the reference cases when step 3 gets wired.
 */
import { CCRA_TOOLS, REVIEW_PROMPT } from './corpus'
import { msg, state, tc, thk, type OrderingScenario } from './types'

const REASONING = 'The retry-after parser changed; check the overflow path first.'

export const thinkingBeforeToolUseScenario: OrderingScenario = {
  id: 'thinking_before_tool_use',
  profile: 'thinking_before_tool_use',
  ruleIds: ['thinking-before-tool-use'],
  ruleType: 'order',
  claim: 'Anthropic manual-thinking: the latest group must place thought BEFORE tool use.',
  prompt: REVIEW_PROMPT,
  // Thought stamped AFTER the call.
  violating: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT)],
      [thk('t1', 3, REASONING)],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  // One-feature delta: same thought, same text, stamped before the call.
  compliant: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT)],
      [thk('t1', 2, REASONING)],
      [tc('c1', 3, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}

export const converseTextBeforeToolUseScenario: OrderingScenario = {
  id: 'converse_text_before_tool_use',
  profile: 'converse_text_before_tool_use',
  ruleIds: ['converse-text-before-tool-use'],
  ruleType: 'order',
  claim: 'Bedrock Converse requires text blocks before toolUse blocks within one assistant turn.',
  prompt: REVIEW_PROMPT,
  // Assistant preamble stamped AFTER the call it introduces.
  violating: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT), msg('m2', 'assistant', 3, REASONING)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, REVIEW_PROMPT), msg('m2', 'assistant', 2, REASONING)],
      [],
      [tc('c1', 3, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}
