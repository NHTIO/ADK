import type { OpenGateFn } from '../../index'
import type { NextFn } from '@nhtio/middleware'
import type { WorkspaceFile } from '../../lib/patch'

/** A synchronous declaration-only capability probe. */
export interface DevCapabilityProbe {
  /** Whether a format capability is declared for an extension. */
  hasFormat(extension?: string): boolean
  /** Whether a lint capability is declared for an extension. */
  hasLint(extension?: string): boolean
  /** Whether a check capability is declared for an extension. */
  hasCheck(extension?: string): boolean
}

/** Diagnostic severity, ordered from most to least serious. */
export type Severity = 'error' | 'warning' | 'info'
/** A diagnostic returned by an engine before runtime provenance is added. */
export interface RawDiagnostic {
  /** Workspace-relative file path; null identifies a workspace-level diagnostic with no single file. */
  path: string | null
  /** Diagnostic severity; only `error` makes a plan unsuccessful. */
  severity: Severity
  /** Human-readable finding text; it remains useful even when invalid coordinates are removed. */
  message: string
  /** Optional engine rule identifier. */
  rule?: string
  /** Optional one-based start line; invalid values are removed during normalization. */
  line?: number
  /** Optional one-based start column; requires a valid line. */
  column?: number
  /** Optional one-based range end line. */
  endLine?: number
  /** Optional one-based range end column. */
  endColumn?: number
}
/** A diagnostic returned by the pipeline. */
export interface Diagnostic extends RawDiagnostic {
  /** Engine id stamped by dispatch; null identifies diagnostics produced by the runtime. */
  engineId: string | null
  /** True when the normalized file path is absent from the post-step workspace; always false for null paths. */
  outOfScope: boolean
}
/** The common result of every engine capability. */
export interface WorkspaceDelta {
  /** Path-to-text entries describing genuinely changed workspace files. */
  changed?: Map<string, string>
  /** Optional inserted-line count; omitted when line diffing is unavailable. */
  added?: Map<string, WorkspaceFile>
  /** Paths removed from the workspace by this delta. */
  deleted?: Set<string>
  /** Source-to-destination moves preserving atomic rename semantics. */
  renamed?: Map<string, string>
  /** Engine findings before the registry adds provenance. */
  diagnostics?: RawDiagnostic[]
}
/** A summary row for one final workspace change. */
export interface FileChangeSummary {
  /** Workspace-relative file path; for a rename, this is the destination path. */
  path: string
  /** Final-state change classification relative to the acquisition workspace. */
  kind: 'modified' | 'added' | 'deleted' | 'renamed'
  /** Lines inserted; absent when the optional diff peer is unavailable. */
  added?: number
  /** Lines deleted; absent when the optional diff peer is unavailable. */
  removed?: number
  /** Rename source path; present if and only if kind is 'renamed'. */
  from?: string
}
/** The composite result of a development-tools execution. */
export interface DevResult {
  /** Accumulated normalized diagnostics in production order. */
  diagnostics: Diagnostic[]
  /** Final-state change summaries compared with acquisition. */
  changes: FileChangeSummary[]
  /** Read-lines output keyed by label. */
  reads: Record<string, string>
  /** Paths actually persisted, in write execution order. */
  written: string[]
  /** Paths that were in the workspace but were dropped by a failed re-read; they remain on disk, are excluded from changes, and surface in the result. */
  unreadable: string[]
  /** False exactly when an error-severity diagnostic exists. */
  ok: boolean
  /** Whether optional line-diff counts are available. */
  lineCountsAvailable: boolean
}

/** A formatter capability declaration. */
export interface FormatCapability {
  /** Extensions participating in this selection pass. */
  extensions: readonly string[]
  /** Selects disk-mutating execution through the restricted access façade. */
  inPlace?: boolean
  /** Glob permission used for selection and in-place authorization. */
  scope?: readonly string[]
  /** Filesystem operations granted to an in-place capability; duplicates are ignored. */
  needs?: readonly ('delete' | 'rename' | 'mkdir')[]
  /** Allows output when the invocation has no input paths. */
  generates?: boolean
  /** Formats the supplied paths and returns a workspace delta; it must not mutate the map directly. */
  format(request: FormatRequest): Promise<WorkspaceDelta>
}
/** A linter capability declaration. */
export interface LintCapability {
  /** Extensions participating in this selection pass. */
  extensions: readonly string[]
  /** Whether this linter may receive `fix: true`; generating linters must be fixable. */
  fixable: boolean
  /** Selects disk-mutating execution through the restricted access façade. */
  inPlace?: boolean
  /** Glob permission used for selection and in-place authorization. */
  scope?: readonly string[]
  /** Filesystem operations granted to an in-place capability; duplicates are ignored. */
  needs?: readonly ('delete' | 'rename' | 'mkdir')[]
  /** Allows output when the invocation has no input paths. */
  generates?: boolean
  /** Runs lint and returns diagnostics and any permitted fix delta. */
  lint(request: LintRequest): Promise<WorkspaceDelta>
}
/** A checker capability declaration. */
export interface CheckCapability {
  /** Extensions participating in this selection pass. */
  extensions: readonly string[]
  /** Checks the whole workspace and returns diagnostics; checks do not receive mutation access. */
  check(request: CheckRequest): Promise<WorkspaceDelta>
}
/** A self-declaring development engine. */
export interface DevEngine {
  /** Unique stable identifier used in diagnostics and candidate identity. */
  readonly id: string
  /** Formatter declarations in declaration order. */
  readonly formats?: readonly FormatCapability[]
  /** Linter declarations in declaration order. */
  readonly lints?: readonly LintCapability[]
  /** Checker declarations relevant to the workspace. */
  readonly checks?: readonly CheckCapability[]
}
/** Request passed to a formatter. */
export interface FormatRequest {
  /** Current mutable workspace file map. */
  files: ReadonlyMap<string, WorkspaceFile>
  /** Resolved existing workspace paths this invocation must handle; selection is frozen for the step. */
  paths: readonly string[]
  /** Normalized authored path patterns, or null when the step supplied no selector. */
  selector: readonly string[] | null
  /** Absolute host workspace root used as the subprocess working directory. */
  root: string
  /** Scoped disk façade supplied only to in-place capabilities. */
  access?: DevFileAccess
  /** Optional cancellation signal. */
  signal?: AbortSignal
}
/** Request passed to a linter. */
export interface LintRequest extends FormatRequest {
  /** Concrete permission requested for this invocation; false is forced for non-fixable linters. */
  fix: boolean
}
/** Request passed to a checker. */
export interface CheckRequest {
  /** Current mutable workspace file map. */
  files: ReadonlyMap<string, WorkspaceFile>
  /** Absolute host workspace root used as the subprocess working directory. */
  root: string
  /** Optional cancellation signal. */
  signal?: AbortSignal
}
/** Narrow filesystem façade granted to in-place capabilities. */
export interface DevFileAccess {
  /** Reads an authorized workspace-relative file through the façade. */
  read(path: string): Promise<string>
  /** Writes an existing authorized file or creates an absent, glob-authorized file. */
  write(path: string, text: string): Promise<void>
  /** Deletes an authorized file; availability is controlled by the declared `needs` set. */
  delete(path: string): Promise<void>
  /** Moves an authorized source to an absent, authorized destination. */
  rename(from: string, to: string): Promise<void>
  /** Creates an authorized directory and parents when `mkdir` was declared. */
  mkdir(path: string): Promise<void>
  /** Probes whether an authorized create target exists; stat failures return false. */
  exists(path: string): Promise<boolean>
  /** Concrete allowlist enforced for this invocation, after selector narrowing and dirty-path withholding. */
  readonly scope: readonly string[]
}
declare const devWorkspaceTokenBrand: unique symbol
/**
 * Opaque provenance token for one workspace value. Tokens are runtime-minted and unique per
 * execution and persistence point, so a short-circuit cannot restore a stale or foreign workspace.
 */
export interface DevWorkspaceToken {
  /**
   * Brand proving this token was minted by the runtime. Middleware cannot construct a valid token;
   * it must copy the token unchanged when short-circuiting within the same execution epoch.
   */
  readonly [devWorkspaceTokenBrand]: true
}
/** Mutable workspace state passed to step middleware. */
export interface DevWorkspace {
  /** Current mutable workspace file map. */
  files: Map<string, WorkspaceFile>
  /** Paths that were in the workspace but were dropped by a failed re-read; they remain on disk, are excluded from changes, and surface in the result. */
  unreadable: Set<string>
  /** Runtime-minted opaque identity unique per execution and persistence point; middleware must copy it unchanged or stale short-circuits are refused. */
  readonly token: DevWorkspaceToken
  /** Accumulated normalized diagnostics in production order. */
  diagnostics: Diagnostic[]
  /** Destination-to-original acquisition path identity map, retained across writes for final rename reporting. */
  renames: Map<string, string>
  /** Workspace path to its current on-disk path; acquisition seeds identity and renames re-key it so later writes use the live disk source. */
  persistedPaths: Map<string, string>
  /** Workspace path to on-disk path awaiting deletion; retained when a persisted file is removed from memory. */
  pendingDeletions: Map<string, string>
  /** Paths vacated and then newly created during this execution; these summarize as additions, not modifications. */
  recreated: Set<string>
}
/** Gate verdict; omission or approval permits the step. */
export type DevGateVerdict = { approved: true } | { approved: false; note?: string }
/** Context supplied to a development-tools gate. */
export interface DevGateContext {
  /** Optional cancellation signal for gate decisions. */
  abortSignal?: AbortSignal
  /** Optional suspension function; an omitted one is synthesized as a rejecting function. */
  waitFor?: OpenGateFn
}
/** Description of the step presented to a gate. */
export interface DevGateCall {
  /** Name of the step being approved. */
  step: string
  /** Validated arguments exactly as authored by the caller. */
  args: unknown
  /** Resolved existing paths the step will touch. */
  targets?: readonly string[]
  /** Glob envelope under which the step may create files. */
  mayCreate?: readonly string[]
  /** Capability declarations that will actually participate in the step. */
  engines?: readonly {
    engineId: string
    extensions: readonly string[]
    inPlace: boolean
    scope?: readonly string[]
  }[]
}
/** Gate callback used by the pipeline. */
export type DevGateFn = (
  ctx: DevGateContext,
  call: DevGateCall
) => DevGateVerdict | void | Promise<DevGateVerdict | void>
/** A candidate exposed to selection middleware. */
export interface DevCandidate {
  /** Stable engine identity used to attribute findings and selection decisions. */
  engineId: string
  /** Original declaration-array index, retained across capability omission so identity stays stable. */
  capabilityIndex: number
  /** Extensions participating in this selection pass. */
  extensions: readonly string[]
  /** Whether the selected capability requires the in-place façade. */
  inPlace: boolean
}
/** Selection middleware context. */
export interface DevSelectionContext {
  /** Capability kind being arbitrated. */
  kind: 'format' | 'lint' | 'check'
  /** Current extension group, or null for generator and check passes. */
  group: string | null
  /** Pass-local resolved paths and relevant extensions. */
  request: { paths: readonly string[]; extensions: readonly string[] }
  /** Candidates middleware may narrow or reorder, but never widen. */
  candidates: DevCandidate[]
}
/** Development plan step. */
export interface DevStep {
  /** The current authored step. */
  step: string
  /** Validated step arguments, preserved separately from normalized selection data. */
  args: Record<string, unknown>
  /** Optional read-lines result key; accepted and ignored by other steps. */
  label?: string
}
/** Development plan. */
export interface DevPlan {
  /** Ordered operations comprising the plan. */
  steps: DevStep[]
}
/** Operation-shaped plan input. */
export type DevOp = Omit<DevStep, never>
/** Workspace resource limits. */
export interface WorkspaceBounds {
  /** Maximum admitted workspace file count. */
  maxFiles: number
  /** Maximum bytes admitted for one workspace file. */
  maxBytesPerFile: number
  /** Maximum total admitted workspace bytes. */
  maxTotalBytes: number
}
/** Execution options. */
export interface RunOptions {
  /** Optional cancellation signal. */
  signal?: AbortSignal
  /** Optional execution gate context. */
  gateContext?: DevGateContext
}
/** Step middleware context. */
export interface DevStepContext {
  /** Plan being executed. */
  readonly plan: DevPlan
  /** Zero-based current step index. */
  readonly stepIndex: number
  /** Current authored step. */
  readonly step: DevStep
  /** Live workspace; middleware may replace it only with a matching token. */
  workspace: DevWorkspace
  /** Per-execution storage shared by step middleware. */
  readonly stash: Map<string, unknown>
  /** Optional cancellation signal passed to capability work. */
  readonly signal?: AbortSignal
  /** Replace the current workspace, preserving its opaque provenance token. */
  shortCircuit(ws: DevWorkspace): never
  /** Resolved engines in deployment order. */
  readonly engines: DevEngineRegistry
}
/** Step middleware callback. */
export type DevStepMiddlewareFn = (ctx: DevStepContext, next: NextFn) => void | Promise<void>
/** Selection middleware callback. */
export type DevSelectionMiddlewareFn = (
  ctx: DevSelectionContext,
  next: NextFn
) => void | Promise<void>
/** Chainable development plan builder. */
export interface DevChain extends PromiseLike<DevResult> {
  /** Append a line-reading step; label is lifted to the operation metadata. */
  readLines(args: { path: string; start: number; end?: number; label?: string }): DevChain
  /** Append deterministic find-and-replace edits to the plan. */
  edit(args: { path: string; edits: readonly { find: string; replace: string }[] }): DevChain
  /** Append a structured patch step. */
  applyPatch(args: { patch: string }): DevChain
  /** Append the persistence step, optionally restricted to normalized paths. */
  write(args?: { paths?: readonly string[] }): DevChain
  /** Append a formatter step. */
  format(args?: { paths?: readonly string[] }): DevChain
  /** Append a linter step, optionally granting fix permission. */
  lint(args?: { paths?: readonly string[]; fix?: boolean }): DevChain
  /** Append a whole-workspace checker step. */
  check(): DevChain
  /** Execute this immutable chain, overriding its open-time options when supplied. */
  run(options?: RunOptions): Promise<DevResult>
  /** Return the serializable operations currently held by this chain. */
  toOps(): DevOp[]
}
/** Development pipeline callable and its front ends. */
export interface DevPipeline {
  /** Starts an immutable chain for the acquired paths. */
  (paths: readonly string[], options?: RunOptions): DevChain
  /** Executes operations immediately over the acquired paths. */
  ops(paths: readonly string[], ops: DevOp[], options?: RunOptions): Promise<DevResult>
  /** Validates operations without executing them. */
  compile(ops: DevOp[]): DevPlan
  /** Declaration-only registry used for capability selection. */
  readonly capabilities: DevEngineRegistry
  /** Resolved engines in deployment order. */
  readonly engines: readonly DevEngine[]
}

/** Internal registry contract. */
export interface DevEngineRegistry extends DevCapabilityProbe {
  readonly engines: readonly DevEngine[]
  plan(request: DevPlanRequest): Promise<DevPlanResult>
  dispatch(invocation: DevInvocation, ctx: DevDispatchContext): Promise<StampedDelta>
}
/** Internal plan request. */
export interface DevPlanRequest {
  /** Capability kind being planned. */
  kind: 'format' | 'lint' | 'check'
  /** Resolved existing workspace paths this invocation must handle; selection is frozen for the step. */
  paths: readonly string[]
  /** Extensions participating in this selection pass. */
  extensions: readonly string[]
  /** Normalized authored path patterns, or null when the step supplied no selector. */
  selector: readonly string[] | null
  /** Concrete lint fix permission; non-fixable capabilities receive false. */
  fix: boolean
}
/** Internal planned invocation. */
export interface DevInvocation {
  /** Stable engine identity used to attribute findings and selection decisions. */
  engineId: string
  /** Original declaration-array index, retained across capability omission so identity stays stable. */
  capabilityIndex: number
  /** Capability kind being planned. */
  kind: 'format' | 'lint' | 'check'
  /** Extension groups won by this invocation; empty for checks and generators. */
  groups: readonly string[]
  /** Resolved existing workspace paths this invocation must handle; selection is frozen for the step. */
  paths: readonly string[]
  /** Normalized authored path patterns, or null when the step supplied no selector. */
  selector: readonly string[] | null
  /** Concrete lint fix permission; non-fixable capabilities receive false. */
  fix: boolean
  /** Whether the selected capability requires the in-place façade. */
  inPlace: boolean
  /** Declared glob permission; required and non-empty for in-place capabilities, otherwise used for selection. */
  scope: readonly string[] | null
  /** Optional filesystem operations this in-place capability is granted; duplicates are harmless and unknown values are rejected. */
  needs: readonly ('delete' | 'rename' | 'mkdir')[]
  /** Whether the capability may produce output when invoked with no input paths. */
  generates: boolean
  /** Whether this linter may receive `fix: true`; generating linters must be fixable. */
  fixable: boolean
}
/** Internal plan outcome. */
export interface DevPlanResult {
  invocations: readonly DevInvocation[]
  skipped: readonly {
    group: string | null
    reason: 'no-capability' | 'suppressed-by-selection'
    extensions: readonly string[]
  }[]
  scopeExcluded: readonly { engineId: string; capabilityIndex: number; count: number }[]
}
/** Internal dispatch context. */
export interface DevDispatchContext {
  /** Current mutable workspace file map. */
  files: ReadonlyMap<string, WorkspaceFile>
  /** Absolute host workspace root used as the subprocess working directory. */
  root: string
  /** Optional cancellation signal. */
  signal?: AbortSignal
  /** Creates the live, scoped façade for an in-place invocation. */
  makeAccess(invocation: DevInvocation): DevFileAccess
}
/** Internal diagnostic stamped with the dispatching engine id. */
interface EngineStampedDiagnostic extends RawDiagnostic {
  /** Non-null id of the engine that produced this diagnostic. */
  engineId: string
}
/** Internal stamped delta. */
export interface StampedDelta extends Omit<WorkspaceDelta, 'diagnostics'> {
  diagnostics: EngineStampedDiagnostic[]
}
/** Internal step outcome. */
export interface DevStepOutcome {
  /** Delta produced by the step. */
  delta: WorkspaceDelta
  /** Paths recreated by operation history, which cannot be inferred from the final delta. */
  recreated?: ReadonlySet<string>
}
/** Internal execution bookkeeping. */
export interface ExecutionState {
  /** Private snapshot of files admitted at acquisition, used for final change summaries. */
  acquisitionBaseline: Map<string, WorkspaceFile>
  /** Private snapshot of the last persisted state, used to decide what writes are needed. */
  persistedBaseline: Map<string, WorkspaceFile>
  /** Private attribution of execution-created paths for collision diagnostics. */
  addedBy: Map<string, string>
}
