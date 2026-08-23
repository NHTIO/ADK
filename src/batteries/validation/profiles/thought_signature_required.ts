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
      fallbackPayloadValue: 'skip_thought_signature_validator',
      // Consumer convention (not ADK-reserved) identifying Gemini's sentinel replay shape.
      fallbackReplayCompatibility: 'gemini-thought-signature-sentinel-v1',
    },
  ],
}
