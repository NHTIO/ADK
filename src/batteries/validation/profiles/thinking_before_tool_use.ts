/** Anthropic manual-thinking mode requires thought before tool use in the latest group. Source: Anthropic extended-thinking documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const thinkingBeforeToolUse: OrderingProfile = {
  name: 'thinking-before-tool-use',
  description:
    "The latest same-role group must place thought before ToolCall; source checked during this plan's research pass.",
  rules: [
    {
      type: 'order',
      id: 'thinking-before-tool-use',
      before: 'thought',
      after: 'toolCall',
      scope: 'adjacent-same-role-group',
      onlyLatestGroup: true,
    },
  ],
}
