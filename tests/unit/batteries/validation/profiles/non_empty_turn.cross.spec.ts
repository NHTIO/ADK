/**
 * `non_empty_turn` — a turn must carry something the provider can act on.
 *
 * @remarks
 * Measured against two vendors that reject the same defect differently: Mistral returns a 400
 * naming it, Gemini returns `MALFORMED_RESPONSE` with no content and no error.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Message, Thought, Tokenizable } from '@nhtio/adk/common'
import { nonEmptyTurn } from '../../../../../src/batteries/validation/profiles/non_empty_turn'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
} from '../../../../../src/batteries/validation/helpers'
import type { OrderingProfile } from '../../../../../src/batteries/validation/types'

const at = (seconds: number) => DateTime.fromMillis(seconds * 1000)

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: string | Tokenizable,
  s: number
) => new Message({ id, role, content, createdAt: at(s), updatedAt: at(s) })

/** The profiles ship advisory, so drive a blocking variant to read findings off `.blocking`. */
const blocking = (profile: OrderingProfile): OrderingProfile => ({
  ...profile,
  rules: profile.rules.map((rule) => ({ ...rule, severity: 'blocking' as const })),
})

describe('non-empty-turn profile', () => {
  it('flags a whitespace-only assistant turn', () => {
    // `Message`'s own schema rejects '' but ACCEPTS whitespace, so this is the shape that reaches a
    // provider. The evaluator previously tested `typeof content === 'string'` — but content is a
    // Tokenizable, never a bare string, so that branch was dead and the check degraded to a null
    // test no Message could fail. This rule caught nothing at all.
    const timeline = buildOrderingTimeline([message('blank', 'assistant', '   ', 1)], [], [])
    const found = evaluateOrderingProfile(timeline, blocking(nonEmptyTurn())).blocking
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ ruleId: 'non-empty-turn', primitiveIds: ['blank'] })
  })

  it('accepts a turn carrying prose', () => {
    const timeline = buildOrderingTimeline([message('real', 'assistant', 'here you go', 1)], [], [])
    expect(evaluateOrderingProfile(timeline, blocking(nonEmptyTurn())).blocking).toHaveLength(0)
  })

  it('treats a dynamic Tokenizable as prose rather than guessing', () => {
    // A dynamic value holds a `(ctx) => string` that cannot be resolved without a context. Assuming
    // it renders empty would reject turns that are fine at assembly time, so it counts as content.
    const dynamic = message('dyn', 'assistant', new Tokenizable(() => 'resolved later'), 1)
    expect(
      evaluateOrderingProfile(buildOrderingTimeline([dynamic], [], []), blocking(nonEmptyTurn()))
        .blocking
    ).toHaveLength(0)
  })

  it('does not let a neighbouring thought satisfy an empty turn', () => {
    // Gemini's measured failure: a final `model` turn carrying only a `thought: true` part comes
    // back MALFORMED_RESPONSE 4 times out of 4. A thought is not content for this rule — only prose
    // or an adjacent TOOL CALL satisfies it, which is what makes this rule describe the shape
    // Gemini actually refuses rather than merely "the turn looks populated".
    const thought = new Thought({
      id: 'th',
      content: 'thinking',
      createdAt: at(1),
      updatedAt: at(1),
    })
    const timeline = buildOrderingTimeline([message('blank', 'assistant', ' ', 2)], [thought], [])
    const found = evaluateOrderingProfile(timeline, blocking(nonEmptyTurn(true))).blocking
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ primitiveIds: ['blank'] })
  })

  it('scopes to the terminal turn only when asked', () => {
    // Mistral's variant checks every assistant turn; Gemini's checks only the last.
    const messages = [
      message('blank', 'assistant', '  ', 1),
      message('later', 'user', 'a follow-up', 3),
    ]
    const timeline = buildOrderingTimeline(messages, [], [])
    expect(evaluateOrderingProfile(timeline, blocking(nonEmptyTurn())).blocking).toHaveLength(1)
    // The blank turn is no longer terminal, so the terminal-scoped variant is silent.
    expect(evaluateOrderingProfile(timeline, blocking(nonEmptyTurn(true))).blocking).toHaveLength(0)
  })
})
