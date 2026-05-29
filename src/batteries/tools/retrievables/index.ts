/**
 * Pre-constructed CRUD tools for model-visible retrievable and RAG-record management.
 *
 * @module @nhtio/adk/batteries/tools/retrievables
 *
 * @remarks
 * Pre-constructed CRUD tools that expose the ADK's {@link @nhtio/adk!Retrievable} surface to the
 * model. Each tool delegates to the corresponding callback on the active
 * {@link @nhtio/adk!DispatchContext} (`fetchRetrievables`, `storeRetrievable`, `mutateRetrievable`,
 * `deleteRetrievable`) — the persistence layer is whatever the consumer wired into the
 * runner.
 *
 * Retrievables are RAG records and carry an explicit `trustTier` that drives the LLM
 * battery's rendering envelope. Exposing these CRUD tools to the model is a deliberate
 * deployer decision; the trust tier the model declares when creating or updating a record
 * is honoured verbatim by the persistence layer. The deployer is responsible for choosing
 * whether to register all four tools, only the read-only `list_retrievables`, or any subset
 * thereof — that registration choice is exactly the trust boundary documented in the
 * Retrievable battery contract.
 *
 * Output is JSON for every tool so consumers can parse the result without re-tokenising —
 * the artifact constructor is set to {@link @nhtio/adk!SpooledJsonArtifact}.
 *
 * Tools:
 * - {@link listRetrievablesTool} — read-only list of every retrievable currently held by
 *   the context.
 * - {@link storeRetrievableTool} — create a new retrievable record (auto-generates `id` /
 *   `createdAt` / `updatedAt` unless explicit values are supplied).
 * - {@link updateRetrievableTool} — replace an existing retrievable by `id`. Bumps
 *   `updatedAt`.
 * - {@link deleteRetrievableTool} — remove a retrievable by `id`.
 */

import { DateTime } from 'luxon'
import { v6 as uuidv6 } from 'uuid'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { Retrievable, SpooledJsonArtifact, Tool } from '@nhtio/adk/common'

const TRUST_TIERS = ['first-party', 'third-party-public', 'third-party-private'] as const
type TrustTier = (typeof TRUST_TIERS)[number]

const serialiseRetrievable = (r: Retrievable): Record<string, unknown> => ({
  id: r.id,
  content: r.content.toString(),
  trustTier: r.trustTier,
  source: r.source,
  kind: r.kind,
  score: r.score,
  createdAt: r.createdAt.toISO(),
  updatedAt: r.updatedAt.toISO(),
})

/**
 * List every retrievable record currently held by the active execution context.
 *
 * @remarks
 * Delegates to `ctx.fetchRetrievables()`. Returns a JSON-encoded array of retrievable records
 * (id, content, trustTier, source, kind, score, createdAt, updatedAt).
 */
export const listRetrievablesTool = new Tool({
  name: 'list_retrievables',
  description:
    'List every retrievable record currently available to the agent. Returns a JSON array of records with id, content, trustTier, source, kind, score, createdAt, and updatedAt.',
  inputSchema: validator.object({}),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (_args, ctx) => {
    try {
      const retrievables = await ctx.fetchRetrievables()
      return JSON.stringify(retrievables.map(serialiseRetrievable), null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Create a new {@link @nhtio/adk!Retrievable} record and persist it via the context's `storeRetrievable`
 * callback.
 *
 * @remarks
 * When `id` is omitted, a UUID v6 is generated. When `createdAt` / `updatedAt` are omitted,
 * the current time is used. The model must declare `trustTier` explicitly — there is no
 * default; the choice is consciously the model's, exposed by the deployer's decision to
 * register this tool.
 */
export const storeRetrievableTool = new Tool({
  name: 'store_retrievable',
  description:
    "Store a new retrievable (RAG) record. The trustTier MUST be one of 'first-party' (deployer-vetted), 'third-party-public' (open-web), or 'third-party-private' (user uploads). id and timestamps are auto-generated if omitted.",
  inputSchema: validator.object({
    content: validator
      .string()
      .required()
      .description('The retrievable content as a plain string.'),
    trustTier: validator
      .string()
      .valid(...TRUST_TIERS)
      .required()
      .description(
        "Trust tier: 'first-party' for deployer-vetted material, 'third-party-public' for open-web or public APIs, 'third-party-private' for user uploads or partner APIs."
      ),
    source: validator
      .string()
      .optional()
      .description('Optional provenance string: URL, document path, KB id, etc.'),
    kind: validator
      .string()
      .optional()
      .description("Optional semantic label: 'policy', 'reference', 'web-page', 'pdf', etc."),
    score: validator
      .number()
      .min(0)
      .max(1)
      .optional()
      .description('Optional relevance / similarity score in [0, 1].'),
    id: validator
      .string()
      .optional()
      .description('Optional stable id. Auto-generated when absent.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { content, trustTier, source, kind, score, id } = args as {
      content: string
      trustTier: TrustTier
      source?: string
      kind?: string
      score?: number
      id?: string
    }
    try {
      const now = DateTime.now()
      const retrievable = new Retrievable({
        id: id ?? uuidv6(),
        content,
        trustTier,
        source,
        kind,
        score,
        createdAt: now,
        updatedAt: now,
      })
      await ctx.storeRetrievable(retrievable)
      return JSON.stringify({ ok: true, retrievable: serialiseRetrievable(retrievable) }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Replace an existing {@link @nhtio/adk!Retrievable} by `id`.
 *
 * @remarks
 * The model supplies `id` plus any subset of `content` / `trustTier` / `source` / `kind` /
 * `score`; omitted fields retain their prior values. `updatedAt` is always bumped;
 * `createdAt` is preserved. Returns an error when no retrievable with the supplied `id` is
 * found.
 */
export const updateRetrievableTool = new Tool({
  name: 'update_retrievable',
  description:
    'Update an existing retrievable by id. Supply any subset of content / trustTier / source / kind / score — omitted fields retain their prior values. updatedAt is always refreshed.',
  inputSchema: validator.object({
    id: validator.string().required().description('Id of the retrievable to update.'),
    content: validator.string().optional().description('Replacement content.'),
    trustTier: validator
      .string()
      .valid(...TRUST_TIERS)
      .optional()
      .description('Replacement trust tier.'),
    source: validator.string().optional().description('Replacement provenance string.'),
    kind: validator.string().optional().description('Replacement semantic label.'),
    score: validator.number().min(0).max(1).optional().description('Replacement score in [0, 1].'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { id, content, trustTier, source, kind, score } = args as {
      id: string
      content?: string
      trustTier?: TrustTier
      source?: string
      kind?: string
      score?: number
    }
    try {
      const retrievables = await ctx.fetchRetrievables()
      const existing = retrievables.find((r) => r.id === id)
      if (!existing) {
        return `Error: No retrievable found with id "${id}".`
      }
      const updated = new Retrievable({
        id: existing.id,
        content: content ?? existing.content,
        trustTier: trustTier ?? existing.trustTier,
        source: source ?? existing.source,
        kind: kind ?? existing.kind,
        score: score ?? existing.score,
        createdAt: existing.createdAt,
        updatedAt: DateTime.now(),
      })
      await ctx.mutateRetrievable(updated)
      return JSON.stringify({ ok: true, retrievable: serialiseRetrievable(updated) }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Remove an existing {@link @nhtio/adk!Retrievable} by `id`.
 *
 * @remarks
 * Delegates to `ctx.deleteRetrievable(id)`. Returns `{ ok: true, id }` on success regardless
 * of whether a retrievable was actually present — `deleteRetrievable` is idempotent at the
 * ADK level.
 */
export const deleteRetrievableTool = new Tool({
  name: 'delete_retrievable',
  description: 'Delete a retrievable by id.',
  inputSchema: validator.object({
    id: validator.string().required().description('Id of the retrievable to delete.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { id } = args as { id: string }
    try {
      await ctx.deleteRetrievable(id)
      return JSON.stringify({ ok: true, id }, null, 2)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Convenience tuple of every retrievable CRUD tool. Spread into a {@link @nhtio/adk!ToolRegistry} to
 * register the entire category at once.
 */
export const retrievableTools = [
  listRetrievablesTool,
  storeRetrievableTool,
  updateRetrievableTool,
  deleteRetrievableTool,
] as const
