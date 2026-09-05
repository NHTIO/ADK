/**
 * Tool-call identifiers must remain unique across a dispatch timeline.
 *
 * @remarks
 * MEASURED against grok-4.3 on Bedrock Mantle: this upstream resets its tool-call counter per
 * turn, returning identifiers such as `call_0` again on later turns. Well-behaved upstreams already
 * provide globally unique identifiers, so this is a no-op for them. The rule self-limits to actual
 * collisions and does not reject correctly numbered parallel calls in one response.
 *
 * The collision is blocking because an advisory finding cannot be repaired, while reusing an id
 * corrupts result correlation and can make a later dispatch reject the completed call.
 */
import type { OrderingProfile } from '../types'

export const toolCallIdUniqueness: OrderingProfile = {
  name: 'tool-call-id-uniqueness',
  description:
    'Tool-call identifiers must be unique across the dispatch timeline; this measured guard is a ' +
    'no-op for well-behaved upstreams and self-limits to actual collisions.',
  rules: [
    {
      type: 'identifierUniqueness',
      id: 'tool-call-id-uniqueness',
      kind: 'toolCall',
      severity: 'blocking',
      surface: 'dispatch',
    },
  ],
}
