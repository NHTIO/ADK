/**
 * Builds the opaque-payload continuity behavior. The field is supplied by the recipe because
 * vendors keep different things stable; pretending they share a field would be worse than
 * making the caller say which one. Source: vendor model documentation; date checked: this plan's research pass.
 */
import type { OrderingPrimitiveKind, OrderingProfile } from '../types'

export const payloadFieldPreservation = (
  payloadField: string,
  kind: OrderingPrimitiveKind = 'thought'
): OrderingProfile => ({
  name: `payload-field-preservation-${kind}-${payloadField.replaceAll('.', '-')}`,
  description: `${kind} payload field ${payloadField} must remain stable across dispatch iterations; source checked during this plan's research pass.`,
  rules: [
    {
      type: 'preservation',
      id: `payload-field-preservation-${kind}-${payloadField.replaceAll('.', '-')}`,
      kind,
      invariant: 'payload-field-stable',
      payloadField,
    },
  ],
})
