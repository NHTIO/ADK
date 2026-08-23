/** Bedrock Converse requires text blocks before toolUse blocks in one assistant message. Source: AWS Bedrock Converse tool-use documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const converseTextBeforeToolUse: OrderingProfile = {
  name: 'converse-text-before-tool-use',
  description:
    "Within one assistant turn, text must precede tool use; source checked during this plan's research pass.",
  rules: [
    {
      type: 'order',
      id: 'converse-text-before-tool-use',
      before: 'message',
      after: 'toolCall',
      scope: 'entire-turn',
    },
  ],
}
