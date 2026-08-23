/**
 * Qwen 3 may drop reasoning predating the latest non-tool-call user turn, but must retain
 * recent reasoning unchanged. The dedicated invariant expresses that boundary directly.
 * Source: Qwen 3 template documentation; date checked: this plan's research pass.
 */
import type { OrderingProfile } from '../types'

export const reasoningPrunedAfterLatestTurn: OrderingProfile = {
  name: 'reasoning-pruned-after-latest-turn',
  description:
    "Reasoning older than the latest non-tool-call user turn may be dropped; reasoning at or after that boundary must remain present and unchanged, as checked during this plan's research pass.",
  rules: [
    {
      type: 'preservation',
      id: 'reasoning-pruned-after-latest-turn',
      kind: 'thought',
      invariant: 'pruned-after-latest-turn',
    },
  ],
}
