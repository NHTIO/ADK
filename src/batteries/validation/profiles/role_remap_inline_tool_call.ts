/** Granite 4.x keeps calls inline in assistant and remaps tool responses. Source: IBM Granite documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const roleRemapInlineToolCall: OrderingProfile = {
  name: 'role-remap-inline-tool-call',
  description:
    "Granite 4.x requires the inline-call wire-role tag and remapped response representation; source checked during this plan's research pass.",
  rules: [
    {
      type: 'roleRemap',
      id: 'granite-4-x-inline-tool-call',
      kind: 'toolCall',
      variant: 'granite-4.x',
      expectedRoleTag: 'payload.roleTag',
    },
  ],
}
