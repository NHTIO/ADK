/** Strict user/assistant alternation required by Nova, DeepSeek, Gemma, and Llama. Source: vendor model documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const strictAlternation: OrderingProfile = {
  name: 'strict-alternation',
  description:
    "User and assistant turns must alternate strictly; source checked during this plan's research pass.",
  rules: [
    {
      type: 'alternation',
      id: 'strict-user-assistant-alternation',
      roles: ['user', 'assistant'],
      mode: 'strict',
    },
  ],
}
