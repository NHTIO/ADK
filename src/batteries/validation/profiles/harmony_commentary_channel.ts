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
      // Advisory by default like the rest of the catalog (OrderRule.severity): the live audit
      // measured gpt-oss ACCEPTING a ToolCall with no channel tag, so blocking would reject a
      // dispatch the model serves.
      severity: 'advisory',
      // Defect #4 from issue #15: this rule declared NO fallbackPayloadValue, so mutate-mode
      // repair skipped it at helpers.ts's `fallbackPayloadValue !== undefined` guard and every
      // gpt-oss tool dispatch landed in `unrepaired`. `'commentary'` is Harmony's own channel name
      // for a function call, so a consumer opting into `blocking` now gets a repairable rule
      // rather than an unrepairable one.
      fallbackPayloadValue: 'commentary',
    },
  ],
}
