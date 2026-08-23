/** GPT-OSS requires every function tool call to use Harmony's commentary channel. Source: OpenAI Harmony format documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const harmonyCommentaryChannel: OrderingProfile = {
  name: 'harmony-commentary-channel',
  description:
    "Every ToolCall must carry the commentary-channel tag; source checked during this plan's research pass.",
  rules: [
    {
      type: 'requiredMetadata',
      id: 'harmony-commentary-channel',
      kind: 'toolCall',
      applyTo: 'every',
      requiredPayloadKey: 'channel',
    },
  ],
}
