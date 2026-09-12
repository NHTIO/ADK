/** Imported skill-tool wrapping and name preflight. */
import { isError } from '@nhtio/adk/guards'
import { resolveSkillToolOutput } from './output'
import { runToolGate } from '@nhtio/adk/batteries/tools/_shared'
import {
  effectiveToolMethods,
  SpooledArtifact,
  SpooledMarkdownArtifact,
  Tool,
} from '@nhtio/adk/common'
import {
  E_SKILL_MANIFEST_INVALID,
  E_SKILL_NOT_LOADED,
  E_SKILL_TOOL_COLLISION,
  E_SKILL_TOOL_DUPLICATE,
  E_SKILL_TOOL_FAILED,
} from './exceptions'
import type { SkillRecord } from './manager'
import type { SkillOutputKind, SkillTrustTier } from './output'
import type { SpooledArtifactConstructor } from '@nhtio/adk/common'
import type { ToolGateFn } from '@nhtio/adk/batteries/tools/_shared'

/**
 * Rebuild every imported tool; the original tool is never mutated.
 *
 * Error containment intentionally follows Tool.executor() on both sides. Error throws have the
 * four-level downstream/failed/downstream/original chain; non-Error throws have three levels and
 * an unrecoverable payload because the inner executor attaches no cause. This wrapper does not
 * race an in-process handler against ctx.abortSignal: a handler that never settles hangs the turn;
 * skills needing cancellation should ship a script.
 */
export const rewrapSkillTool = (o: {
  /** The third-party tool exactly as the descriptor supplied it. */
  original: Tool
  /** Identity of the owning skill; becomes `meta.skill` / `meta.skillVersion`. */
  skill: { readonly id: string; readonly version: string; readonly trustTier?: SkillTrustTier }
  /** The loaded record. The wrapper closes over it for the liveness check (retired + refcount). */
  record: SkillRecord
  /** Undefined only when `unsafe.ungatedSkillTools` is set. */
  gate: ToolGateFn | undefined
  /** Resolves this tool's artifact kind. */
  resolveArtifact: (skillId: string, toolName: string) => SpooledArtifactConstructor
  /** Descriptor-declared output kind for this tool; enforced against the runtime shape when set. */
  declaredOutput?: SkillOutputKind
}): Tool => {
  const { original, skill, record, gate, resolveArtifact, declaredOutput } = o
  return new Tool({
    name: original.name,
    description: original.description,
    inputSchema: original.inputSchema,
    artifactConstructor: () => resolveArtifact(skill.id, original.name),
    meta: { ...original.meta.all(), skill: skill.id, skillVersion: skill.version },
    trusted: false,
    handler: async (args, ctx) => {
      if (!record.tryEnter()) throw new E_SKILL_NOT_LOADED([skill.id])
      let raw: unknown
      try {
        await runToolGate(gate, ctx, original.name, args)
        try {
          raw = await original.executor(ctx)(args)
        } catch (err) {
          throw new E_SKILL_TOOL_FAILED([original.name, skill.id], {
            cause: isError(err) ? err : undefined,
          })
        }
      } finally {
        record.exit()
      }

      // Output resolution runs after the executor (and its refcount exit): a legal string,
      // Uint8Array, Media or Media[] passes through; a framework-agnostic bytes/retrievable
      // descriptor is constructed into the real primitive host-side; a prebuilt SpooledArtifact
      // and every other shape fail E_SKILL_TOOL_BAD_RESPONSE. Validation sits OUTSIDE the executor
      // try/catch so an illegal return shape is not masked as E_SKILL_TOOL_FAILED.
      return resolveSkillToolOutput({
        raw,
        ctx,
        toolName: original.name,
        trustTier: skill.trustTier,
        declared: declaredOutput,
      })
    },
  })
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/**
 * Check imported and generated names before reservations or registration. Artifact readers are
 * derived from core's live method registries, including the mandatory raw and markdown kinds.
 */
export const assertSkillToolNames = (o: {
  candidates: readonly string[]
  reserved: ReadonlySet<string>
  registryNames: readonly string[]
  registryOwners: ReadonlyMap<string, string | undefined>
  skillId: string
  artifactKinds: readonly unknown[]
}): void => {
  const seen = new Set<string>()
  const readers = new Set<string>()
  for (const ctor of [SpooledArtifact, SpooledMarkdownArtifact, ...o.artifactKinds]) {
    for (const method of effectiveToolMethods(ctor)) readers.add(method.name)
  }
  for (const name of o.candidates) {
    if (!TOOL_NAME.test(name)) throw new E_SKILL_MANIFEST_INVALID([`tool name "${name}"`])
    if (seen.has(name)) throw new E_SKILL_TOOL_DUPLICATE([name])
    seen.add(name)
    if (o.reserved.has(name)) throw new E_SKILL_TOOL_COLLISION([name])
    if (readers.has(name)) throw new E_SKILL_TOOL_COLLISION([name])
    const index = o.registryNames.indexOf(name)
    if (index >= 0 && o.registryOwners.get(name) !== o.skillId) {
      throw new E_SKILL_TOOL_COLLISION([name])
    }
  }
}
