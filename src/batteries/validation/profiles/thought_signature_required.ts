/**
 * Gemini 3 hard-requires thought_signature on the first function call. Source: Google Gemini
 * thought-signature documentation; date checked: this plan's research pass.
 *
 * @remarks
 * This rule only checks PRESENCE of `payload.thoughtSignature` — it has no way to verify the
 * signature is a genuine one produced by a real Gemini reasoning trace, and it doesn't need to:
 * Google documents two sentinel bypass values for exactly the case where a caller is replaying
 * tool-call history that did not originate from a Gemini call session (e.g. history translated
 * from an OpenAI-shaped conversation, or a model switch mid-conversation) — `'skip_thought_signature_validator'`
 * (works on both the Gemini API and Vertex AI) and `'context_engineering_is_the_way_to_go'`
 * (Gemini API only, NOT Vertex AI). Setting `ToolCall.payload.thoughtSignature` to either string
 * satisfies this rule and the real Gemini API's own validation — a caller assembling non-Gemini-
 * originated history for a Gemini 3+ target should populate one of these rather than fabricating
 * an opaque value or omitting the field. Google's own docs caution this should be a last resort,
 * not a default, since it can degrade output quality relative to a real signature.
 */
import type { OrderingProfile } from '../types'

export const thoughtSignatureRequired: OrderingProfile = {
  name: 'thought-signature-required',
  description:
    "The first ToolCall in its group must carry thoughtSignature. Mutate mode can explicitly repair missing values for non-Gemini-originated replay using Google's documented portable sentinel; the replay tag records the consumer adapter convention.",
  rules: [
    {
      type: 'requiredMetadata',
      id: 'thought-signature-required',
      kind: 'toolCall',
      applyTo: 'first-in-group',
      requiredPayloadKey: 'thoughtSignature',
      // THE ONE RULE THIS CATALOG HAS CONFIRMED. A live audit against each rule's own native API
      // found 16 of 17 blocking turn state their vendor accepts; this is the exception. Gemini
      // rejects an unsigned historical `functionCall` with a 400 naming the field and the position
      // ("Function call is missing a thought_signature in functionCall parts … position 2"), and
      // the same history with the sentinel returns 200. So it keeps `blocking` explicitly while the
      // rest of the catalog defaults to advisory — see OrderRule.severity.
      severity: 'blocking',
      fallbackPayloadValue: 'skip_thought_signature_validator',
      // Issue #15 defect 3: this fallback is GOOGLE'S OWN published sentinel for replaying
      // non-Gemini-originated history, not a fabricated provenance claim — so mutate mode may apply
      // it without the global `allowMetadataFallbackRepair`. Without this, `gemini-3` had no working
      // configuration at all: enforce nacked, mutate nacked, and the only setting that dispatched
      // was a flag documented as a last resort. Authorizes THIS rule only.
      fallbackRepairAuthorized: true,
      // Consumer convention (not ADK-reserved) identifying Gemini's sentinel replay shape.
      fallbackReplayCompatibility: 'gemini-thought-signature-sentinel-v1',
    },
  ],
}
