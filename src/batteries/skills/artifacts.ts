/** Skill artifact-kind resolution and binding registry. */
import { SpooledArtifact } from '@nhtio/adk/common'
import { isError, isObject } from '@nhtio/adk/guards'
import { E_INVALID_SKILLS_CONFIG, E_SKILL_ARTIFACT_UNAVAILABLE } from './exceptions'
import type { SpooledArtifactConstructor } from '@nhtio/adk/common'
import type { SkillDescriptor, SkillManagerConfig, SpooledKindResolver } from './types'

/** Resolved artifact kinds plus the consumer-owned skill/tool binding table. */
export interface SkillArtifactRegistry {
  /** Constructors keyed by the kind name accepted in bindings and descriptors. */
  readonly kinds: ReadonlyMap<string, SpooledArtifactConstructor>
  /** Explicit skill-to-tool-to-kind mappings; these override descriptor advice. */
  readonly bindings: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Selects the binding, then descriptor advice, then the raw built-in kind. */
  resolve(
    skillId: string,
    toolName: string,
    descriptor?: Pick<SkillDescriptor, 'artifactKind'>
  ): SpooledArtifactConstructor
}

const unwrap = (value: unknown): unknown => {
  if (isObject(value) && 'default' in value) return value.default
  return value
}

const resolveOne = async (resolver: SpooledKindResolver): Promise<SpooledArtifactConstructor> => {
  const value =
    typeof resolver === 'function' && !SpooledArtifact.isSpooledArtifactConstructor(resolver)
      ? await resolver()
      : resolver
  const result = unwrap(value)
  if (!SpooledArtifact.isSpooledArtifactConstructor(result)) {
    throw new E_INVALID_SKILLS_CONFIG([
      'artifact kind resolver did not return a SpooledArtifact constructor',
    ])
  }
  return result
}

/**
 * Resolve all optional artifact classes eagerly. The built-in raw kind is always available;
 * optional artifact batteries are intentionally not imported here.
 */
export const createSkillArtifactRegistry = async (
  config: Pick<SkillManagerConfig, 'artifactKinds' | 'artifactBindings'>
): Promise<SkillArtifactRegistry> => {
  const entries = Object.entries(config.artifactKinds ?? {})
  const resolved = new Map<string, SpooledArtifactConstructor>([
    ['SpooledArtifact', SpooledArtifact],
  ])
  await Promise.all(
    entries.map(async ([key, resolver], index) => {
      try {
        resolved.set(key, await resolveOne(resolver))
      } catch (error) {
        throw new E_INVALID_SKILLS_CONFIG([
          `artifactKinds[${index}] "${key}": ${isError(error) ? error.message : String(error)}`,
        ])
      }
    })
  )
  const bindings = config.artifactBindings ?? {}
  return {
    kinds: resolved,
    bindings,
    resolve(skillId, toolName, descriptor) {
      const kind = bindings[skillId]?.[toolName] ?? descriptor?.artifactKind ?? 'SpooledArtifact'
      const constructor = resolved.get(kind)
      if (!constructor) {
        throw new E_SKILL_ARTIFACT_UNAVAILABLE([
          `${kind}; registered keys: ${[...resolved.keys()].join(', ')}`,
        ])
      }
      return constructor
    },
  }
}

/**
 * bedrock_converse and gemini_generate_content do not honour artifactConstructor: they coerce
 * every tool result through `new Tokenizable(JSON.stringify(raw))`. Their imported-tool output is
 * therefore inlined and no artifact readers are forged. The other adapters spool tool results.
 */
