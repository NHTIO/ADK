/**
 * Builds the no-history-loss behavior used for tool calls and thoughts. Source: Kimi,
 * Qwen, MiniMax, Codex, and DeepSeek documentation; date checked: this plan's research pass.
 */
import type { OrderingPrimitiveKind, OrderingProfile } from '../types'

export const fullHistoryPreservation = (kind: OrderingPrimitiveKind): OrderingProfile => ({
  name: `full-history-preservation-${kind}`,
  description: `Historical ${kind} count must not decrease across dispatch iterations; source checked during this plan's research pass.`,
  rules: [
    {
      type: 'preservation',
      id: `full-history-preservation-${kind}`,
      kind,
      invariant: 'count-non-decreasing',
    },
  ],
})
