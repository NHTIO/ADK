import type { SandboxHandle } from '../sandbox/manager'
import type { GuestLimits, SandboxPolicy } from '../sandbox/types'
import type { SpooledArtifactConstructor } from '@nhtio/adk/forge'
import type { ToolGateFn } from '@nhtio/adk/batteries/tools/_shared'
import type { SandboxFileSystem } from '../sandbox/contracts/file_system'
import type { PathTranslator } from '../sandbox/contracts/path_translator'
import type { Tool, Retrievable, RetrievableTrustTier } from '@nhtio/adk/common'
import type { GuestGlobal, GuestRuntimeLike } from '../sandbox/js/ses_contracts'
import type {
  SkillRef,
  SkillSource,
  SkillLoadChannel,
  SkillScriptParam,
  SkillScriptSpec,
} from './contracts'
import type {
  DispatchContext,
  TurnContext,
  TurnPipelineMiddlewareFn,
  DispatchPipelineMiddlewareFn,
} from '@nhtio/adk/types'

/** Live, source-owned definition resolved when a catalog entry is loaded. */
export interface SkillDescriptor {
  /** Must match the discovered ref; descriptors cannot rename a catalog entry. */
  readonly id: string
  /** Display name paired with the routing description. */
  readonly name: string
  /** Resident routing text; the body remains unloaded until explicitly requested. */
  readonly description: string
  /** Version checked against discovery to prevent loading stale or mismatched data. */
  readonly version: string
  /** Per-skill override of the manager's body projection channel. */
  readonly channel?: SkillLoadChannel
  /** Trust envelope applied when the body is projected into context. */
  readonly trustTier?: RetrievableTrustTier
  /** First-party live tools to gate, rewrap, and register on load. */
  readonly tools?: readonly Tool[]
  /** Advisory default artifact kind; an explicit registry binding takes precedence. */
  readonly artifactKind?: string
  /** Tier-3 scripts; their declared paths are materialized and their argv is battery-built. */
  readonly scripts?: readonly SkillScriptSpec[]
  /** Tier-2 source tools executed through the configured guest runtime. */
  readonly isolatedTools?: readonly SkillIsolatedTool[]
  /** agentskills.io license passthrough surfaced for audit. */
  readonly license?: string
  /** Client-specific agentskills.io properties carried without interpretation. */
  readonly metadata?: Readonly<Record<string, string>>
  /** Free-form compatibility note surfaced to consumers, never enforced by the battery. */
  readonly compatibility?: string
}

/** A source instance or lazy/default export resolver used during manager construction. */
export type SkillSourceResolver =
  | SkillSource
  | (() => SkillSource | { default: SkillSource } | Promise<SkillSource | { default: SkillSource }>)

/** Skill-scoped materialization service used by tier-3 scripts. */
export interface SkillWorkspace {
  /**
   * Write files and return the authoritative absolute materialized root. Callers must use the
   * returned root rather than reconstructing `${root}/${id}`: ids are external data, two sources
   * may offer the same id, and an implementation may add a version or random path segment (and
   * MUST do so on id collision).
   */
  materialize(
    skill: SkillRef,
    files: AsyncIterable<{ path: string; bytes: ReadableStream<Uint8Array> }>,
    o?: { signal?: AbortSignal }
  ): Promise<string>
  /**
   * Remove one materialization, identified by its returned root rather than by SkillRef. A
   * prepare-then-swap refresh can have two live materializations of the same skill at once, and
   * a workspace using randomized paths cannot distinguish them from the ref and could delete the
   * wrong one.
   */
  dispose(root: string): Promise<void>
  /** Filesystem view used by the sandbox policy and script runner. */
  readonly fileSystem: SandboxFileSystem
  /** Workspace base used to resolve materializations; individual returned roots remain authoritative. */
  readonly root: string
}

/** Tier-3 execution controls, workspace, policy, and output/time ceilings. */
export interface SkillScriptConfig {
  /** Child-process handle used to execute scripts under the derived policy. */
  handle: SandboxHandle
  /** Materializes bundled files and disposes roots when the skill leaves the loaded set. */
  workspace: SkillWorkspace
  /** Baseline policy narrowed to the skill's declared capabilities. */
  policy: SandboxPolicy
  /** Maps source paths into the sandbox namespace. */
  translator: PathTranslator
  /** Allowlisted interpreter argv prefixes keyed by {@link SkillScriptSpec.interpreter}. */
  interpreters: Readonly<Record<string, readonly string[]>>
  /** Host files interpreters may read in addition to the materialized skill root. */
  interpreterReadPaths: readonly string[]
  /** Hard upper bound for model-requested script timeouts. */
  maxTimeoutSeconds: number
  /** Default timeout used when the model omits one. */
  defaultTimeoutSeconds: number
  /** Output ceiling preventing unbounded child-process results. */
  maxOutputBytes: number
  /** Declares whether the interpreter cannot inherit host environment variables. */
  hostEnvIsolated: boolean
  /**
   * Whether a nonzero child exit code is a tool failure. Default (or omitted) `true`: a script
   * that exits nonzero throws {@link E_SKILL_SCRIPT_FAILED}, so a host can detect a broken or
   * rejected script programmatically rather than parsing the exit code out of the acknowledgement
   * string. Set `false` to keep the plain acknowledgement behaviour — any completed run, whatever
   * its exit code, returns the success string — for skills whose scripts use exit codes as
   * ordinary signalling rather than pass/fail. Output is spooled either way; on the failure path
   * the retrievable id is carried in the error.
   */
  failOnNonzeroExit?: boolean
}

/** Tier-2 tool whose source is evaluated inside the configured guest runtime. */
export interface SkillIsolatedTool {
  /** Model-visible tool name. */
  readonly name: string
  /** Model-visible operation description. */
  readonly description: string
  /** Declared JSON arguments validated before source evaluation. */
  readonly params?: readonly SkillScriptParam[]
  /** A complete async arrow expression: `async (args) => { ... }`. */
  readonly source: string
}

/** Tier-2 guest capabilities and termination/timeout controls. */
export interface SkillIsolationConfig {
  /** Capability implementations made available to isolated skill code. */
  globals?: Readonly<Record<string, GuestGlobal>>
  /** Modules exposed to the guest runtime. */
  modules?: Readonly<Record<string, unknown>>
  /** Guest resource limits layered onto the runtime defaults. */
  limits?: Partial<GuestLimits>
  /** Structural safety seam: without it, in-process forging requires unsafe opt-in. */
  resolveGuest?: (o: {
    globals: Readonly<Record<string, GuestGlobal>>
    modules: Readonly<Record<string, unknown>>
    limits: GuestLimits
    signal?: AbortSignal
  }) => GuestRuntimeLike | Promise<GuestRuntimeLike>
  /** Maximum evaluation timeout the model may request. */
  maxTimeoutSeconds: number
  /** Timeout applied when a call omits one. */
  defaultTimeoutSeconds: number
}

/** Inputs that determine discovery, projection, and the explicit containment exceptions. */
export interface SkillManagerConfig {
  /** Ordered sources; earlier candidates win id collisions. */
  sources: ReadonlyArray<SkillSourceResolver>
  /** Required gate for lifecycle and skill-tool execution. */
  gate: ToolGateFn
  /** Fallback body projection channel when a descriptor does not choose one. */
  defaultChannel?: SkillLoadChannel
  /** Named artifact constructors resolved eagerly at manager creation. */
  artifactKinds?: Readonly<Record<string, SpooledKindResolver>>
  /** Explicit skill/tool artifact bindings, taking precedence over descriptor advice. */
  artifactBindings?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Enables tier-3 script tools and their skill-scoped workspace. */
  scripts?: SkillScriptConfig
  /** Enables tier-2 isolated tools. */
  isolation?: SkillIsolationConfig
  /** Refreshes the catalog at turn input without swapping loaded versions. */
  autoRefresh?: boolean
  /** Explicitly named containment controls; each opt-in loses a corresponding safety boundary. */
  unsafe?: {
    /** Permit tier-2 code in the default in-process guest, whose kill is a no-op. */
    isolatedToolsInProcess?: true
    /** Replace the derived narrow script policy with caller-supplied permissive policy. */
    scriptsPermissivePolicy?: SandboxPolicy
    /** Skip the mandatory gate around skill-supplied tools. */
    ungatedSkillTools?: true
  }
}

/** The four pipeline hooks needed to hydrate, reconcile, observe, and strip skill state. */
export interface SkillMiddlewareSet {
  /** Hydrates initialized skills onto a fresh turn context. */
  turnInput: TurnPipelineMiddlewareFn
  /** Strips projected skill state at the head of turn-output, before any downstream middleware. */
  turnOutput: TurnPipelineMiddlewareFn
  /** Reconciles skill-owned tools before dispatch execution. */
  dispatchInput: DispatchPipelineMiddlewareFn
  /** Observes changes after dispatch execution; it is not the commit point. */
  dispatchOutput: DispatchPipelineMiddlewareFn
}

/** A winning catalog candidate or a losing candidate retained for provenance. */
export interface CatalogEntry {
  /** Discovery metadata consumed by list_skills and routing. */
  readonly ref: SkillRef
  /** Whether this catalog candidate is manager-initialized, as consumed by list_skills. */
  readonly loaded: boolean
  /** The winning candidate that shadows this losing entry, when applicable. */
  readonly shadowedBy?: SkillRef
  /** Whether discovery found a newer version than the initialized record. */
  readonly updateAvailable?: boolean
}

/** The per-context projection of one initialized skill. */
export interface ProjectedSkill {
  /** Skill identity visible in this context's registry. */
  readonly id: string
  /** The projected retrievable body. */
  readonly retrievable?: Retrievable
  /** Tools projected for this turn. */
  readonly tools: readonly Tool[]
}

/** Immediate lifecycle outcome, including the objects registered in this dispatch. */
export interface LoadResult {
  /** Identifier of the skill initialized by the operation. */
  readonly id: string
  /** Channel used to project its body. */
  readonly channel: SkillLoadChannel
  /** Tools registered as part of the load. */
  readonly tools: readonly Tool[]
  /** Body retrievable added to the context. */
  readonly retrievable?: Retrievable
}

/** Result of catalog refresh, including versions that now differ from loaded state. */
export interface RefreshResult {
  /** Skill ids rediscovered or refreshed. */
  readonly ids: readonly string[]
  /** Entries whose source version differs from loaded state. */
  readonly updateAvailable: readonly string[]
}

/** An artifact constructor or lazy/default-export resolver for a named skill result kind. */
export type SpooledKindResolver =
  | SpooledArtifactConstructor
  | (() =>
      | SpooledArtifactConstructor
      | { default: SpooledArtifactConstructor }
      | Promise<SpooledArtifactConstructor | { default: SpooledArtifactConstructor }>)

/** Stateful skill lifecycle; construct one manager per conversation or session. */
export interface SkillManager {
  /** Synchronous resolved catalog, including losing candidates and update flags. */
  catalog(): readonly CatalogEntry[]
  /** Initialized manager state, independent of any turn context. */
  loaded(): readonly string[]
  /** Skills actually projected into this context and callable in this turn. */
  projected(ctx: DispatchContext | TurnContext): readonly ProjectedSkill[]
  /** Catalog-only rediscovery; never swaps an initialized version. */
  refresh(id?: string): Promise<RefreshResult>
  /** Explicitly re-reads and swaps the loaded version, then projects it into this context. */
  refreshAndProject(ctx: DispatchContext | TurnContext, id?: string): Promise<RefreshResult>
  /** Initializes and immediately projects a skill's body and tools for this dispatch. */
  load(id: string, ctx: DispatchContext): Promise<LoadResult>
  /** Removes a skill from initialized state and unregisters its projected tools. */
  unload(id: string, ctx: DispatchContext): Promise<void>
  /** Disposes skill workspaces and drops all projections, including when middleware is skipped. */
  dispose(): Promise<void>
  /** Explicitly enabled containment controls, derived from the manager configuration. */
  readonly unsafe: readonly string[]
  /** Middleware set with stable shape; functionality is derived from manager configuration. */
  readonly middleware: SkillMiddlewareSet
}

export type { SkillRef, SkillSource }
