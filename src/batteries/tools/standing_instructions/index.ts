/**
 * Pre-constructed CRUD tools for model-visible standing instruction management.
 *
 * @module @nhtio/adk/batteries/tools/standing_instructions
 *
 * @remarks
 * Pre-constructed CRUD tools that expose the ADK's standing-instruction surface to the
 * model. Each tool delegates to the corresponding callback on the active
 * {@link @nhtio/adk!DispatchContext} (`standingInstructions` getter, `storeStandingInstruction`,
 * `deleteStandingInstruction`) — the persistence layer is whatever the consumer wired into
 * the runner.
 *
 * Standing instructions are stored as a {@link Set} of {@link @nhtio/adk!Tokenizable} values keyed by
 * identity, not by an `id` field — there is no separate "update by id" semantics. The tools
 * therefore expose only `list` / `add` / `remove`. To replace an existing instruction the
 * model should `remove` the old value and `add` the new one (the ADK's persistence layer
 * is free to interpret that pair as an update if appropriate).
 *
 * Output is JSON for every tool so consumers can parse the result without re-tokenising —
 * the artifact constructor is set to {@link @nhtio/adk!SpooledJsonArtifact}.
 *
 * Tools:
 * - {@link listStandingInstructionsTool} — read-only list of every standing instruction
 *   currently held by the context (after refreshing from the persistence layer).
 * - {@link addStandingInstructionTool} — add a new standing instruction.
 * - {@link removeStandingInstructionTool} — remove a standing instruction by its content
 *   (exact string match).
 */

import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { SpooledJsonArtifact, Tool } from '@nhtio/adk/common'

/**
 * List every standing instruction currently held by the active execution context.
 *
 * @remarks
 * Calls `ctx.refreshStandingInstructions()` to ensure the local Set is in sync with the
 * persistence layer, then serialises the resulting strings to a JSON array. The list is
 * stringly-keyed; the same content string serves as the identifier for subsequent removes.
 */
export const listStandingInstructionsTool = new Tool({
  name: 'list_standing_instructions',
  description:
    'List every standing instruction currently held by the agent. Returns a JSON array of strings. To replace an instruction, remove the old string and add a new one.',
  inputSchema: validator.object({}),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (_args, ctx) => {
    try {
      const refreshed = await ctx.refreshStandingInstructions()
      const items = refreshed.map((v) => (typeof v === 'string' ? v : v.toString()))
      return JSON.stringify(items, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Add a new standing instruction to the active execution context.
 *
 * @remarks
 * Delegates to `ctx.storeStandingInstruction(content)`. Standing instructions are stored as
 * a `Set` — adding the same content twice is a no-op at the local level, though the
 * consumer's persistence callback may interpret it differently.
 */
export const addStandingInstructionTool = new Tool({
  name: 'add_standing_instruction',
  description:
    'Add a new standing instruction. Returns the stored content. Adding an identical instruction that already exists is a no-op.',
  inputSchema: validator.object({
    content: validator
      .string()
      .required()
      .description('The standing-instruction content as a plain string.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { content } = args as { content: string }
    try {
      await ctx.storeStandingInstruction(content)
      return JSON.stringify({ ok: true, content }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Remove an existing standing instruction by its content string.
 *
 * @remarks
 * Delegates to `ctx.deleteStandingInstruction(content)`. Idempotent — succeeds even when
 * no matching instruction is currently present.
 */
export const removeStandingInstructionTool = new Tool({
  name: 'remove_standing_instruction',
  description:
    'Remove a standing instruction by its exact content string. Idempotent — succeeds even when no match is present.',
  inputSchema: validator.object({
    content: validator
      .string()
      .required()
      .description('The exact content string of the instruction to remove.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { content } = args as { content: string }
    try {
      await ctx.deleteStandingInstruction(content)
      return JSON.stringify({ ok: true, content }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Convenience tuple of every standing-instruction tool. Spread into a {@link @nhtio/adk!ToolRegistry}
 * to register the entire category at once.
 */
export const standingInstructionTools = [
  listStandingInstructionsTool,
  addStandingInstructionTool,
  removeStandingInstructionTool,
] as const
