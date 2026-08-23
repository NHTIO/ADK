/**
 * The deliberately empty ordering baseline for xAI Grok.
 *
 * Grok documents no role-order limitation. That is a real vendor claim, not permission
 * to confuse missing validation with permissiveness. Source: xAI documentation; date
 * checked: this plan's research pass.
 */
import type { OrderingProfile } from '../types'

export const permissive: OrderingProfile = {
  name: 'permissive',
  description:
    "xAI Grok documents no role-order limitation at all; source checked during this plan's research pass.",
  permissive: true,
  rules: [],
}
