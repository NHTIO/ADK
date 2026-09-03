/**
 * ROLE REMAP — a provider-specific wire-role tag on a ToolCall payload.
 *
 * Corpus shape: identical turn state, differing only by `payload.roleTag`.
 *
 * DEFECT FOUND AND FIXED BY THIS SCENARIO
 *
 * Before the fix, both Granite profiles could not dispatch a tool call under ANY configuration:
 *
 *  1. `expectedRoleTag` was declared as `'payload.roleTag'`, but helpers.ts resolves the path
 *     INSIDE the payload (`getDotPath(entry.value.payload, rule.expectedRoleTag)`), so it read
 *     `payload.payload.roleTag`. A normally-shaped `{ roleTag: 'granite-4.x' }` could never match;
 *     only a doubly-nested `{ payload: { roleTag } }` could. Compare `requiredMetadata`, which
 *     declares BARE keys (`'thoughtSignature'`, `'channel'`) against the same resolver.
 *  2. The rule was unconditionally BLOCKING, and `roleRemap` has no repair strategy — so both
 *     `enforce` and `mutate` nacked.
 *  3. `payload.roleTag` is a CONSUMER-SUPPLIED annotation. It appears nowhere in `src/` except the
 *     two profiles that name it: nothing in the ADK writes it, no adapter reads it, and no
 *     documentation explains how to populate it.
 *
 * Together: every `granite-3-x` / `granite-4-x` dispatch carrying a ToolCall nacked, permanently,
 * with no configuration that could clear it.
 *
 * THE FIX (this pass): the path now reads `roleTag`, and the rule defaults to `severity: 'advisory'`
 * so a missing tag is REPORTED without gating dispatch. A consumer who does populate the tag may opt
 * into `severity: 'blocking'` to have the guard enforce their own convention.
 *
 * MEASURED against real Granite 4 (`ibm/granite-4-h-small`, WatsonX). Both conventions are
 * ACCEPTED and answered correctly:
 *
 *   4.x inlined  `<|tool_call|>get_file_diff<|/tool_call|>42 lines`  -> stop, "contains 42 lines"
 *   3.x split    assistant `<tool_call>…</tool_call>` + tool result -> stop, "contains 42 lines"
 *
 * So the model does not enforce a distinction between them. Read the cell verdicts carefully: BOTH
 * legs of an ADVISORY scenario predict `accepted`, so `satisfies()` is true either way and the
 * disposition reads `justified` for a reason that has nothing to do with the vendor rejecting
 * anything. For an advisory that is the CORRECT outcome — the rule's whole claim is that it must
 * not gate dispatch — but it is not evidence that the tag is required. The honest summary is: the
 * rule is non-blocking as designed, and Granite 4 accepts either rendering.
 *
 * NOTE ALSO the family mismatch. Only Granite 4 is provisioned, so the `granite-3-x` cell tests
 * whether a 4-SERIES model rejects 3.x-shaped history — not whether Granite 3 requires it. That
 * question stays open until a Granite 3 model exists somewhere reachable.
 *
 * WIRE TESTABILITY. The tag is invisible under the DEFAULT renderer — which collapses a ToolCall to
 * `{ role: 'tool', content: <result> }` and never reads `payload` — so both legs would render to
 * identical bytes and the cell would measure nothing. But message assembly is an INJECTABLE helper
 * on every LLM battery (`buildTransformersJsMessages`, and the Chat-Completions / Anthropic /
 * Ollama / LiteRT equivalents). With the roleTag-aware renderer in `./granite_renderer`, the two
 * conventions render to DIFFERENT bytes:
 *
 *   granite-3.x  → assistant `<tool_call>…</tool_call>` + a separate `tool_response` turn
 *   granite-4.x  → one inlined assistant turn, `<|tool_call|>…<|/tool_call|>` + result
 *
 * so the model sees different input and step 1 is genuinely testable. The wire leg's precondition is
 * therefore A RENDERER, not a credential — `granite_renderer.ts` supplies it, and doubles as the
 * reference implementation of what any `roleRemap` consumer must provide.
 *
 * WHAT THE RULE POLICES, read together with that renderer: not a vendor wire constraint, but the
 * CONSISTENCY of two things the consumer owns — the tag they stamp and the renderer they install.
 * It catches history assembled for 3.x being dispatched through a 4.x renderer, or vice versa.
 */
import { CCRA_TOOLS, REVIEW_PROMPT } from './corpus'
import { msg, state, tc, type OrderingScenario } from './types'

const PROMPT = REVIEW_PROMPT

const GRANITE_SKIP = {
  reason: 'requires-custom-renderer' as const,
  detail:
    'The wire leg needs the roleTag-aware renderer in ./granite_renderer installed as the ' +
    "battery's `buildTransformersJsMessages`. Under the DEFAULT renderer both legs render to " +
    'identical bytes and the cell measures nothing. With it, the 3.x and 4.x conventions render ' +
    'differently and step 1 is testable against onnx-community/granite-4.0-350m-ONNX-web — no ' +
    'credential required, since the model runs locally.',
}

export const roleRemapSplitToolRolesScenario: OrderingScenario = {
  id: 'role_remap_split_tool_roles',
  profile: 'role_remap_split_tool_roles',
  ruleIds: ['granite-3-x-split-tool-roles'],
  ruleType: 'roleRemap',
  claim: 'Granite 3.x requires an explicit wire-role tag for split tool-call/response roles.',
  prompt: PROMPT,
  violating: {
    // Post-fix: reported as an ADVISORY, and dispatch proceeds.
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 1 },
    wire: 'accepted',
  },
  compliant: {
    // The payload a caller would reasonably write — now actually satisfies the rule.
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [
        tc('c1', 2, {
          tool: CCRA_TOOLS.getFileDiff,
          args: { path: 'src/retry.ts' },
          payload: { roleTag: 'granite-3.x' },
        }),
      ]
    ),
    guard: { blocking: 0, advisories: 0 },
    wire: 'accepted',
  },
  skip: GRANITE_SKIP,
}

export const roleRemapInlineToolCallScenario: OrderingScenario = {
  id: 'role_remap_inline_tool_call',
  profile: 'role_remap_inline_tool_call',
  ruleIds: ['granite-4-x-inline-tool-call'],
  ruleType: 'roleRemap',
  claim: 'Granite 4.x keeps calls inline in assistant and remaps tool responses.',
  prompt: PROMPT,
  violating: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 1 },
    wire: 'accepted',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [
        tc('c1', 2, {
          tool: CCRA_TOOLS.getFileDiff,
          args: { path: 'src/retry.ts' },
          payload: { roleTag: 'granite-4.x' },
        }),
      ]
    ),
    guard: { blocking: 0, advisories: 0 },
    wire: 'accepted',
  },
  skip: GRANITE_SKIP,
}
