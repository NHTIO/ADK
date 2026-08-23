/** Granite 3.x renders tool calls and results under distinct wire roles. Source: IBM Granite documentation; date checked: this plan's research pass. */
import type { OrderingProfile } from '../types'

export const roleRemapSplitToolRoles: OrderingProfile = {
  name: 'role-remap-split-tool-roles',
  description:
    "Granite 3.x requires an explicit wire-role tag for split tool-call and tool-response roles; source checked during this plan's research pass.",
  rules: [
    {
      type: 'roleRemap',
      id: 'granite-3-x-split-tool-roles',
      kind: 'toolCall',
      variant: 'granite-3.x',
      expectedRoleTag: 'payload.roleTag',
    },
  ],
}
