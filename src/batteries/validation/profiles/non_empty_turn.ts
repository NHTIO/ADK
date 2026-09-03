/**
 * A turn must carry something the provider can act on.
 *
 * @remarks
 * MEASURED against two vendors, which reject the same underlying defect in two different ways —
 * one loudly, one silently:
 *
 *  - Mistral: HTTP 400, "Assistant message must have either content or tool_calls, but not none."
 *  - Gemini: a request whose FINAL `model` turn carries only a `thought: true` part comes back
 *    `finishReason: MALFORMED_RESPONSE` with no content — measured 4 of 4, against STOP-with-text
 *    when the identical history ends on the user turn instead.
 *
 * A thought alone does not satisfy the rule; that is precisely the shape Gemini refuses. The two
 * variants differ only in scope, so the factory takes it: Gemini's constraint is terminal-position
 * specific, Mistral's applies to any assistant turn in the history.
 */
import type { OrderingProfile } from '../types'

/**
 * @param onlyTerminal - Check only the final turn (Gemini) rather than every one (Mistral).
 * @param role - Which role's turns are constrained.
 */
export const nonEmptyTurn = (
  onlyTerminal: boolean = false,
  role: 'assistant' | 'user' = 'assistant'
): OrderingProfile => ({
  name: onlyTerminal ? 'non-empty-terminal-turn' : 'non-empty-turn',
  description:
    `Every ${onlyTerminal ? 'terminal ' : ''}${role} turn must carry content or an adjacent tool ` +
    'call; a turn carrying neither is rejected, sometimes silently.',
  rules: [
    {
      type: 'nonEmptyTurn',
      id: onlyTerminal ? 'non-empty-terminal-turn' : 'non-empty-turn',
      role,
      onlyTerminal,
    },
  ],
})
