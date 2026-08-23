/**
 * The Llama 3 one-tool-call cap, now enforced through AlternationRule.maxPerGroup.
 * Parallel tool calls are not a harmless formatting choice for this family. Source: Meta
 * Llama tool-calling documentation; date checked: this plan's research pass.
 */
import type { OrderingProfile } from '../types'

export const singleToolCallPerTurn: OrderingProfile = {
  name: 'single-tool-call-per-turn',
  description:
    "Llama 3 permits at most one ToolCall per same-role group; maxPerGroup enforces that cap, as checked during this plan's research pass.",
  rules: [
    {
      type: 'alternation',
      id: 'single-tool-call-per-turn',
      roles: ['user', 'assistant'],
      mode: 'strict',
      maxPerGroup: 1,
    },
  ],
}
