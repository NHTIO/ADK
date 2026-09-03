/**
 * REQUIRED METADATA — a vendor field that must be present on a ToolCall payload.
 *
 * Corpus shape: a real CCRA review turn — the seat is asked to review and calls `get_file_diff`.
 * Identical turn state in both legs; the ONLY delta is a payload key. That makes these the purest
 * one-feature deltas in the audit — the wire sees the same conversation, differing solely by one
 * metadata field.
 *
 * Three scenarios, and the comparison between them is the point:
 *
 *  - `thought_signature_required`  (gemini-3)   BLOCKING
 *  - `thought_signature_advisory`  (gemini-2-5) ADVISORY
 *      Same field, same vendor, same `applyTo` — differing only in `severity`. Whichever way the
 *      wire rules, ONE of this pair is mis-specified. Testing both is how we find out which.
 *
 *      MEASURED AT THE UPSTREAM BOUNDARY (LB -> generativelanguage.googleapis.com, 45d): the
 *      documented sentinel does NOT discriminate outcome. It is present in 786/949 rejected
 *      requests AND 2401/8350 accepted ones. So the compliant leg below is NOT known to be the
 *      thing that makes a request succeed — it is only known to satisfy THIS GUARD. The wire
 *      prediction is therefore `unknown` rather than `accepted`: an honest cell records what the
 *      vendor does instead of asserting a fix we have no evidence for.
 *  - `harmony_commentary_channel`  (gpt-oss)    BLOCKING, and UNREPAIRABLE: it declares no
 *      `fallbackPayloadValue`, so mutate-mode repair skips it at helpers.ts's
 *      `fallbackPayloadValue !== undefined` guard and it lands in `unrepaired`. That is an
 *      undocumented sibling of the gemini-3 defect in issue #15 — every gpt-oss tool dispatch
 *      nacks in mutate mode, and nobody has logged it.
 */
import { CCRA_TOOLS, REVIEW_PROMPT } from './corpus'
import { msg, state, tc, type OrderingScenario } from './types'

const PROMPT = REVIEW_PROMPT

/** Google's documented portable sentinel for replaying non-Gemini-originated tool history. */
const GEMINI_SENTINEL = 'skip_thought_signature_validator'

export const thoughtSignatureRequiredScenario: OrderingScenario = {
  id: 'thought_signature_required',
  profile: 'thought_signature_required',
  ruleIds: ['thought-signature-required'],
  ruleType: 'requiredMetadata',
  claim: 'Gemini 3 hard-requires payload.thoughtSignature on the first ToolCall in a group.',
  prompt: PROMPT,
  violating: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    // STILL BLOCKING. The live audit CONFIRMED this one: Gemini rejects an unsigned historical
    // functionCall with a 400 naming the field and position, and the compliant leg passes. It is
    // the only rule of the 17 that earned its blocking severity, so it keeps it while the rest
    // defaulted to advisory.
    guard: { blocking: 1 },
    wire: 'rejected-or-empty',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [
        tc('c1', 2, {
          tool: CCRA_TOOLS.getFileDiff,
          args: { path: 'src/retry.ts' },
          payload: { thoughtSignature: GEMINI_SENTINEL },
        }),
      ]
    ),
    guard: { blocking: 0 },
    // Satisfies the guard; NOT known to satisfy the vendor (see the sentinel note above).
    wire: 'unknown',
  },
}

export const thoughtSignatureAdvisoryScenario: OrderingScenario = {
  id: 'thought_signature_advisory',
  profile: 'thought_signature_advisory',
  ruleIds: ['thought-signature-advisory'],
  ruleType: 'requiredMetadata',
  claim: 'Gemini 2.5: thoughtSignature is RECOMMENDED, not enforced — absence must not block.',
  prompt: PROMPT,
  // INVERTED: for an advisory the "violating" shape is predicted to dispatch fine. What is under
  // audit here is that the guard reports it WITHOUT blocking.
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
          payload: { thoughtSignature: GEMINI_SENTINEL },
        }),
      ]
    ),
    guard: { blocking: 0, advisories: 0 },
    wire: 'accepted',
  },
}

export const harmonyCommentaryChannelScenario: OrderingScenario = {
  id: 'harmony_commentary_channel',
  profile: 'harmony_commentary_channel',
  ruleIds: ['harmony-commentary-channel'],
  ruleType: 'requiredMetadata',
  claim: 'GPT-OSS requires EVERY ToolCall to carry the Harmony commentary-channel tag.',
  prompt: PROMPT,
  violating: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [tc('c1', 2, { tool: CCRA_TOOLS.getFileDiff, args: { path: 'src/retry.ts' } })]
    ),
    guard: { blocking: 0, advisories: 1 },
    wire: 'rejected-or-empty',
  },
  compliant: {
    state: state(
      [msg('m1', 'user', 1, PROMPT)],
      [],
      [
        tc('c1', 2, {
          tool: CCRA_TOOLS.getFileDiff,
          args: { path: 'src/retry.ts' },
          payload: { channel: 'commentary' },
        }),
      ]
    ),
    guard: { blocking: 0 },
    wire: 'accepted',
  },
}
