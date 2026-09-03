/**
 * Granite 3.x renders tool calls and results under distinct wire roles. Source: IBM Granite
 * documentation; date checked: this plan's research pass.
 *
 * PARAMETERIZED, for the same reason {@link payloadFieldPreservation} is: the tag lives on a
 * CONSUMER-SUPPLIED payload field. Nothing in the ADK writes or reads it — no adapter emits it, no
 * primitive carries it by default — so the profile cannot know what a given consumer called it, or
 * what value they stamp. Hardcoding `roleTag` pretended every consumer shares a convention this
 * codebase never defined, and combined with a blocking default that rejected every ToolCall for
 * both Granite families.
 *
 * The caller therefore says which field to read and which value to require, exactly as they do for
 * `payload_field_preservation:signature`. Defaults preserve the previously-documented shape
 * (`payload.roleTag === 'granite-3.x'`) so an existing recipe keeps its meaning.
 */
import type { OrderingProfile } from '../types'

/**
 * @param payloadField - Dot-path resolved INSIDE `ToolCall.payload` (so `'roleTag'` reads
 *   `payload.roleTag`). Must not re-state the `payload` prefix.
 * @param variant - The tag value this profile requires.
 * @param severity - `advisory` (default) reports a mismatch without gating dispatch; `blocking`
 *   rejects it. Advisory is the default because the annotation is consumer-supplied: a consumer who
 *   does not populate it must not be prevented from dispatching.
 */
export const roleRemapSplitToolRoles = (
  payloadField: string = 'roleTag',
  variant: string = 'granite-3.x',
  severity: 'blocking' | 'advisory' = 'advisory'
): OrderingProfile => ({
  name: 'role-remap-split-tool-roles',
  description:
    `Granite 3.x requires an explicit wire-role tag for split tool-call and tool-response roles; ` +
    `this profile reads ToolCall payload.${payloadField} and requires ${variant} (${severity}).`,
  rules: [
    {
      type: 'roleRemap',
      id: 'granite-3-x-split-tool-roles',
      kind: 'toolCall',
      variant,
      expectedRoleTag: payloadField,
      severity,
    },
  ],
})
