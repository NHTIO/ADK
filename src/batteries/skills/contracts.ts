/** Structural contracts for skill sources. No ADK classes are required at this boundary. */

/**
 * Discovery result. Carries the ROUTING METADATA — `name` and `description` — because that is
 * what `list_skills` shows the model and what it chooses on; requiring `descriptor()` to obtain
 * it would mean loading every skill's module just to list the catalog.
 */
export interface DiscoveredSkill {
  /** Stable source-assigned identity used for catalog routing and load operations. */
  id: string
  /** Source version used to detect an available update without loading the descriptor. */
  version: string
  /** agentskills.io passthrough, surfaced pre-load. Optional: a source may not have them. */
  license?: string
  /** Client-specific agentskills.io properties surfaced before load for provenance and audit. */
  metadata?: Readonly<Record<string, string>>
  /** Free-form compatibility note; surfaced but deliberately not parsed or enforced. */
  compatibility?: string
  /** Human-facing name used in routing metadata. */
  name: string
  /** Routing text shown to the model without loading the skill body. */
  description: string
}

/** A discovered skill plus manager-assigned provenance. This is what the battery passes around. */
export type SkillRef = DiscoveredSkill & { readonly sourceId: string }

/** Controls whether a loaded body is represented by a handle or rendered inline per dispatch. */
export type SkillLoadChannel = 'handle' | 'inline'

/** A model-selectable script bundled with a skill and invoked with declared arguments only. */
export interface SkillScriptSpec {
  /** Enum member exposed to the model when selecting this script. */
  readonly name: string
  /** Source-relative bundled path; it must also be returned by {@link SkillSource.list}. */
  readonly path: string
  /** Instructions shown alongside the script choice. */
  readonly description: string
  /** Interpreter key resolved through the deployment's interpreter allowlist. */
  readonly interpreter: string
  /** Declared parameters, passed only in declaration order after the script path. */
  readonly params?: readonly SkillScriptParam[]
}

/** One validated value in the fixed argv contract presented to a script. */
export interface SkillScriptParam {
  /** Argument name used in validation and argv construction. */
  readonly name: string
  /** Argument guidance shown to the model. */
  readonly description: string
  /** Validation/rendering kind; enum values are constrained separately. */
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  /** Allowed values, required when {@link SkillScriptParam.type} is `enum`. */
  readonly values?: readonly string[]
  /** Whether omission is rejected before the child process is started. */
  readonly required?: boolean
  /** Rendered as `--flag value` when set, otherwise positionally in declaration order. */
  readonly flag?: string
}

/** Runtime-neutral source seam for discovery, metadata, body bytes, and bundled files. */
export interface SkillSource {
  /** Stable provenance label; the manager rejects duplicate source ids at configuration time. */
  readonly id: string
  /** Asynchronously yields discovery metadata; protocol conformance is checked by the suite, not the duck-guard. */
  discover(o?: { signal?: AbortSignal }): AsyncIterable<DiscoveredSkill>
  /** Resolves the live descriptor and tools only when a manager operation loads the skill. */
  descriptor(ref: SkillRef, o?: { signal?: AbortSignal }): Promise<unknown>
  /**
   * Read a file from the skill. **An omitted `path` means the skill BODY** — the `SKILL.md`
   * equivalent — whatever the source calls it internally. Every channel needs the body.
   */
  read(
    ref: SkillRef,
    path?: string,
    o?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>>
  /** Returns source size and version for a body or bundled file without returning its bytes. */
  stat(ref: SkillRef, path?: string): Promise<{ size: number; version: string }>
  /**
   * Enumerate bundled files for materialization.
   * MUST include every path named by a `SkillScriptSpec`, and MUST NOT include the body.
   */
  list?(ref: SkillRef): Promise<readonly string[]>
}

/**
 * Duck-guard for the synchronous portion of a source contract. `discover()` returns an async
 * iterable and cannot be duck-checked beyond "is a function", so a value passing this guard may
 * still violate the protocol. `runSkillSourceConformance`, from
 * `@nhtio/adk/batteries/skills/conformance`, is the real protocol check.
 */
export const implementsSkillSource = (value: unknown): value is SkillSource => {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.discover === 'function' &&
    typeof candidate.descriptor === 'function' &&
    typeof candidate.read === 'function' &&
    typeof candidate.stat === 'function'
  )
}
