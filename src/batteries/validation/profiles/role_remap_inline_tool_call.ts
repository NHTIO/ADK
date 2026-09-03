/**
 * Granite 4.x keeps calls inline in assistant and remaps tool responses. Source: IBM Granite
 * documentation; date checked: this plan's research pass.
 *
 * PARAMETERIZED for the same reason as {@link roleRemapSplitToolRoles}: the tag lives on a
 * consumer-supplied payload field that nothing in the ADK writes or reads, so the caller must say
 * which field carries it and what value to require. See that profile for the full rationale.
 */
import type { OrderingProfile } from '../types'

/**
 * @param payloadField - Dot-path resolved INSIDE `ToolCall.payload` (so `'roleTag'` reads
 *   `payload.roleTag`). Must not re-state the `payload` prefix.
 * @param variant - The tag value this profile requires.
 * @param severity - `advisory` (default) reports a mismatch without gating dispatch; `blocking`
 *   rejects it.
 */
export const roleRemapInlineToolCall = (
  payloadField: string = 'roleTag',
  variant: string = 'granite-4.x',
  severity: 'blocking' | 'advisory' = 'advisory'
): OrderingProfile => ({
  name: 'role-remap-inline-tool-call',
  description:
    `Granite 4.x requires the inline-call wire-role tag and remapped response representation; ` +
    `this profile reads ToolCall payload.${payloadField} and requires ${variant} (${severity}).`,
  rules: [
    {
      type: 'roleRemap',
      id: 'granite-4-x-inline-tool-call',
      kind: 'toolCall',
      variant,
      expectedRoleTag: payloadField,
      severity,
    },
  ],
})
