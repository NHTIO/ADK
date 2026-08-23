/**
 * Gemini 2.5's thought signature is recommended, not enforced. RequiredMetadataRule has
 * severity: advisory, so missing metadata is reported without blocking dispatch. Source:
 * Google Gemini documentation; date checked:
 * this plan's research pass.
 */
import type { OrderingProfile } from '../types'

export const thoughtSignatureAdvisory: OrderingProfile = {
  name: 'thought-signature-advisory',
  description:
    "Gemini 2.5 should carry thoughtSignature on the first ToolCall; severity advisory reports absence without blocking dispatch, as checked during this plan's research pass.",
  rules: [
    {
      type: 'requiredMetadata',
      id: 'thought-signature-advisory',
      kind: 'toolCall',
      applyTo: 'first-in-group',
      requiredPayloadKey: 'thoughtSignature',
      severity: 'advisory',
    },
  ],
}
