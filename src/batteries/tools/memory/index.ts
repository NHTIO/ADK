/**
 * Pre-constructed CRUD tools for model-visible ADK memory management.
 *
 * @module @nhtio/adk/batteries/tools/memory
 *
 * @remarks
 * Pre-constructed CRUD tools that expose the ADK's {@link @nhtio/adk!Memory} surface to the model.
 * Each tool delegates to the corresponding callback on the active {@link @nhtio/adk!DispatchContext}
 * (`fetchMemories`, `storeMemory`, `mutateMemory`, `deleteMemory`) — the persistence layer is
 * whatever the consumer wired into the runner.
 *
 * Memory entries carry agent-internal `confidence` / `importance` scores and are rendered
 * through the LLM battery's recall-tier envelope. Letting the model author and curate its own
 * memories is the canonical use case for these tools; deployers who do not want the model to
 * mutate memory should simply not register the relevant tools.
 *
 * Output is JSON for every tool so consumers can parse the result without re-tokenising — the
 * artifact constructor is set to {@link @nhtio/adk!SpooledJsonArtifact}.
 *
 * Tools:
 * - {@link listMemoriesTool} — read-only list of every memory currently held by the context.
 * - {@link storeMemoryTool} — create a new memory (auto-generates `id` / `createdAt` /
 *   `updatedAt` unless explicit values are supplied).
 * - {@link updateMemoryTool} — replace an existing memory by `id`. Bumps `updatedAt`.
 * - {@link deleteMemoryTool} — remove a memory by `id`.
 */

import { DateTime } from 'luxon'
import { v6 as uuidv6 } from 'uuid'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { Memory, SpooledJsonArtifact, Tool } from '@nhtio/adk/common'

const serialiseMemory = (m: Memory): Record<string, unknown> => ({
  id: m.id,
  content: m.content.toString(),
  confidence: m.confidence,
  importance: m.importance,
  createdAt: m.createdAt.toISO(),
  updatedAt: m.updatedAt.toISO(),
})

/**
 * List every memory currently held by the active execution context.
 *
 * @remarks
 * Delegates to `ctx.fetchMemories()`. Returns a JSON-encoded array of memory records (id,
 * content, confidence, importance, createdAt, updatedAt). The model can use the `id` values
 * to drive subsequent `update_memory` / `delete_memory` calls.
 */
export const listMemoriesTool = new Tool({
  name: 'list_memories',
  description:
    'List every memory currently held by the agent. Returns a JSON array of memory records with id, content, confidence, importance, createdAt, and updatedAt.',
  inputSchema: validator.object({}),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (_args, ctx) => {
    try {
      const memories = await ctx.fetchMemories()
      return JSON.stringify(memories.map(serialiseMemory), null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Create a new {@link @nhtio/adk!Memory} record and persist it via the context's `storeMemory` callback.
 *
 * @remarks
 * When `id` is omitted, a UUID v6 is generated. When `createdAt` / `updatedAt` are omitted,
 * the current time is used. The model authors `content`, `confidence`, and `importance`
 * directly. The resulting record is added to `ctx.turnMemories` and flushed to the consumer's
 * persistence layer.
 */
export const storeMemoryTool = new Tool({
  name: 'store_memory',
  description:
    'Store a new memory record. Provide the content, your confidence (0–1) that the memory is accurate, and the importance (0–1) of the memory for future recall. id and timestamps are auto-generated if omitted.',
  inputSchema: validator.object({
    content: validator.string().required().description('The memory content as a plain string.'),
    confidence: validator
      .number()
      .min(0)
      .max(1)
      .required()
      .description('Confidence in [0, 1] that this memory is accurate.'),
    importance: validator
      .number()
      .min(0)
      .max(1)
      .required()
      .description('Importance in [0, 1] — how much weight the memory should carry on recall.'),
    id: validator
      .string()
      .optional()
      .description('Optional stable id. Auto-generated when absent.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { content, confidence, importance, id } = args as {
      content: string
      confidence: number
      importance: number
      id?: string
    }
    try {
      const now = DateTime.now()
      const memory = new Memory({
        id: id ?? uuidv6(),
        content,
        confidence,
        importance,
        createdAt: now,
        updatedAt: now,
      })
      await ctx.storeMemory(memory)
      return JSON.stringify({ ok: true, memory: serialiseMemory(memory) }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Replace an existing {@link @nhtio/adk!Memory} by `id`.
 *
 * @remarks
 * The model supplies `id` plus any subset of `content` / `confidence` / `importance`; fields
 * left undefined retain their prior values. `updatedAt` is always bumped to the current time;
 * `createdAt` is preserved. Returns an error when no memory with the supplied `id` is found.
 */
export const updateMemoryTool = new Tool({
  name: 'update_memory',
  description:
    'Update an existing memory by id. Supply any subset of content / confidence / importance — omitted fields retain their prior values. updatedAt is always refreshed.',
  inputSchema: validator.object({
    id: validator.string().required().description('Id of the memory to update.'),
    content: validator.string().optional().description('Replacement content.'),
    confidence: validator
      .number()
      .min(0)
      .max(1)
      .optional()
      .description('Replacement confidence in [0, 1].'),
    importance: validator
      .number()
      .min(0)
      .max(1)
      .optional()
      .description('Replacement importance in [0, 1].'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { id, content, confidence, importance } = args as {
      id: string
      content?: string
      confidence?: number
      importance?: number
    }
    try {
      const memories = await ctx.fetchMemories()
      const existing = memories.find((m) => m.id === id)
      if (!existing) {
        return `Error: No memory found with id "${id}".`
      }
      const updated = new Memory({
        id: existing.id,
        content: content ?? existing.content,
        confidence: confidence ?? existing.confidence,
        importance: importance ?? existing.importance,
        createdAt: existing.createdAt,
        updatedAt: DateTime.now(),
      })
      await ctx.mutateMemory(updated)
      return JSON.stringify({ ok: true, memory: serialiseMemory(updated) }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Remove an existing {@link @nhtio/adk!Memory} by `id`.
 *
 * @remarks
 * Delegates to `ctx.deleteMemory(id)`. Returns `{ ok: true, id }` on success regardless of
 * whether a memory was actually present — `deleteMemory` is idempotent at the ADK level.
 */
export const deleteMemoryTool = new Tool({
  name: 'delete_memory',
  description: 'Delete a memory by id.',
  inputSchema: validator.object({
    id: validator.string().required().description('Id of the memory to delete.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { id } = args as { id: string }
    try {
      await ctx.deleteMemory(id)
      return JSON.stringify({ ok: true, id }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Convenience tuple of every memory CRUD tool. Spread into a {@link @nhtio/adk!ToolRegistry} to register
 * the entire category at once: `registry.register(...memoryTools)`.
 */
export const memoryTools = [
  listMemoriesTool,
  storeMemoryTool,
  updateMemoryTool,
  deleteMemoryTool,
] as const
