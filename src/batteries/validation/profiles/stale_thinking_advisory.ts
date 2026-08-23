/**
 * Gemma 4 recommends dropping stale thinking, unless preserveThinking is requested.
 * This is deliberately an advisory, not preservation: sending old thought is discouraged,
 * not a missing invariant. Source: Google Gemma 4 model guidance; date checked: this plan's research pass.
 */
import type { OrderingProfile } from '../types'

export const staleThinkingAdvisory: OrderingProfile = {
  name: 'stale-thinking-advisory',
  description:
    "Historical thought before the latest non-tool-call user turn is advisory-stale; it never gates dispatch, per Gemma 4 guidance checked during this plan's research pass.",
  rules: [
    {
      type: 'staleContentAdvisory',
      id: 'stale-thinking-gemma4',
      kind: 'thought',
      scope: 'before-latest-user-turn',
      optOutOptionKey: 'preserveThinking',
    },
  ],
}
