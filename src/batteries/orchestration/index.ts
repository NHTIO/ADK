/**
 * The orchestration battery — plan lifecycle, execution, and the model-facing tool forge.
 *
 * @module @nhtio/adk/batteries/orchestration
 *
 * @remarks
 * This is the battery's BARREL and its single entry point: the assembly gate where the
 * work-package pieces (validation, approval, the executor, templates, rendering, the raw
 * views, the outline reader and the tool forge) are wired together. It is the one place a
 * precondition can be enforced for every operation, which is why the encoder requirement and
 * evaluator loading live here rather than scattered across the modules that happen to need them.
 *
 * ### Why `createOrchestration` is async
 *
 * Construction is the last moment a deployment can fail LOUDLY and EARLY. Four things are
 * resolved here, before any plan is created, frozen or approved:
 *
 * 1. **The encoder is required.** `@nhtio/encoder` is declared an OPTIONAL PEER of the whole
 *    package — peer metadata is package-wide, not subpath-scoped, so making it required would
 *    force it on every consumer including the many who never import orchestration. The
 *    requirement is enforced where it CAN be: at construction, by eagerly
 *    `await import('@nhtio/encoder')` and throwing {@link E_ORCH_ENCODER_REQUIRED} (naming the
 *    package and its install command) if it is absent. Failing here means no plan is ever created,
 *    frozen or approved in a deployment missing the encoder — the property that actually matters.
 *    It is genuinely required because the digest comes from a lossless canonical encoding, and
 *    digests are load-bearing in every lifecycle transition, approval binding and `claimRun` —
 *    even an in-memory store needs them.
 * 2. **Encodables are registered once.** `registerOrchestrationEncodables()` is called here,
 *    once, because `registerClass` is a global registry and decoding an unregistered class throws.
 * 3. **Every configured evaluator cell is loaded.** `await load()` runs on each cell supplied at
 *    construction, so a missing optional peer surfaces HERE rather than part-way through a freeze.
 *    A cell supplied per-run is loaded at that point, with the same named error.
 * 4. **Every registered template is validated.** `validateTemplate` runs on each template and a
 *    blocking issue throws, so a misconfigured deployment fails at boot with a named error rather
 *    than at first instantiation months later.
 *
 * ### Dependency precedence
 *
 * Resolved HERE and stated once so it cannot drift: **per-run wins field by field over
 * construction**; anything absent from both is a named error if the plan needs it. `evaluators`
 * MERGE BY CELL `id` — a per-run cell replaces the configured one with the same id, others
 * survive — because a run legitimately swaps one cell while keeping the rest. Everything else
 * replaces wholesale.
 *
 * ### Environment neutrality
 *
 * The barrel stays environment-neutral: there is no `node:*` anywhere in its module graph. The
 * Lua cell (`./cells/lua`) imports `node:worker_threads` and is therefore NOT re-exported here —
 * it is reachable only via its own deep subpath. The structured and jexl cells, the types, the
 * exceptions, the store contract and the in-memory store, the conformance suite, and the
 * raw/render/outline functions are all re-exported.
 *
 * ### How the deep subpaths are named
 *
 * Every module carrying an `@module` tag becomes one published entry, and the entry key is its
 * FULL path from `src/` — `batteries/orchestration/forge`, not `forge`. The build derives the map
 * by scanning for those tags (`getEntries` in `bin/utils`), and the emitted declaration sits at
 * the matching path, so `dist/batteries/orchestration/types.d.ts` and `dist/types.d.ts` are
 * different files reached by different specifiers.
 *
 * Stated because the leaf basenames repeat and that looks alarming: this battery ships `forge`
 * and `types`, and so do the root package and several other batteries — 25 modules end in
 * `/types` today, four in `/forge`. None of them collide, because nothing is keyed on the
 * basename. A module tagged here can never overwrite `@nhtio/adk/forge`.
 */

import { renderPlan } from './render'
import { planOutline } from './outline'
import { approvePlan } from './approval'
import { executePlan } from './executor'
import { freezePlan } from './validation'
import { rawPlan, rawOps, rawDiff } from './raw'
import { forgeOrchestrationTools } from './forge'
import { registerOrchestrationEncodables } from './encoding'
import { validateTemplate, instantiateTemplate } from './templates'
import { isObject, isError, isInstanceOf } from '../../lib/utils/guards'
import { E_ORCH_ENCODER_REQUIRED, E_ORCH_CELL_UNAVAILABLE } from './exceptions'
import type {
  CreateOrchestration,
  FreezeInputs,
  InvocableTools,
  Orchestration,
  PlanTemplate,
  PredicateEvaluator,
  RunDeps,
  RunOptions,
} from './types'

// ── re-exports: the public deep-import surface ─────────────────────────────

export { InMemoryPlanStore } from './in_memory'
export { runPlanStoreConformance } from './conformance'
export { createStructuredCell } from './cells/structured'
export type { JexlCellOptions, JexlTransform } from './cells/jexl'
export { createJexlCell } from './cells/jexl'

export { renderPlan } from './render'
export type { RenderPlanOptions } from './render'
export { rawPlan, rawOps, rawDiff } from './raw'
export { planOutline, planRead } from './outline'

export { NodeRef, ParamRef, registerOrchestrationEncodables, planDigest } from './encoding'
export { computeAuthoritySet } from './approval'
export { validateTemplate, instantiateTemplate } from './templates'
export { forgeOrchestrationTools } from './forge'
export type { ForgeOrchestrationRuntime, ForgeOrchestrationOptions } from './forge'
export { effectiveToolMethods } from './artifact_methods'
export {
  isPlanNode,
  isPlanEdge,
  nodeById,
  outgoing,
  incoming,
  entryNodes,
  reachableFrom,
  findCycle,
  routesBetween,
  immediateDominator,
  handleAppliesTo,
  readPath,
  isValidNodeId,
  isValidEdgeId,
} from './plan'
export { foldRun } from './runs'
export { foldOps, branchKey } from './ops'
export {
  joinPromptParts,
  stripInstructionTags,
  wrapInstruction,
  decodeOutputSchema,
  validateReasonerOutput,
} from './reason'
export {
  isPredicateLeaf,
  isAllPredicate,
  isAnyPredicate,
  isNotPredicate,
  isStructuredPredicate,
  parseStructuredPredicate,
  loadOnce,
} from './predicates'
export type {
  PredicateOp,
  PredicateLeaf,
  AllPredicate,
  AnyPredicate,
  NotPredicate,
  StructuredPredicate,
  ParsePredicateResult,
} from './predicates'
export { createDispatchReasoner } from './dispatch_reasoner'
export { E_ORCH_ENCODER_REQUIRED, E_ORCH_CELL_UNAVAILABLE } from './exceptions'

export type {
  PlanStore,
  CreateResult,
  AppendResult,
  TransitionRequest,
  TransitionResult,
  ClaimRunResult,
} from './store'
export type { PlanLock, PlanLockFactory } from './locks'

// The full type surface of the battery, re-exported once so a consumer needs only this barrel.
// `NodeRef`/`ParamRef`/`branchKey`/`foldRun`/`effectiveToolMethods` are re-exported above as the
// real values (from the modules that implement them) and appear here as types only where the
// `types.ts` declarations carry them; the value re-exports win for runtime use.
export type {
  // lifecycle & identity
  PlanState,
  PlanId,
  NodeId,
  // value domain
  EncodableValue,
  ArgValue,
  BranchId,
  RouteSegment,
  NodeOutput,
  OutputItem,
  OutputTable,
  ArtifactTable,
  SpooledArtifactLike,
  MediaLike,
  // node definitions
  PlanNodeKind,
  EdgeHandle,
  PlanEdge,
  DeclaredField,
  EntryNodeDefinition,
  CallNodeDefinition,
  ReasonNodeDefinition,
  PromptPart,
  TransformNodeDefinition,
  BranchNodeDefinition,
  SelectNodeDefinition,
  JoinNodeDefinition,
  PlanNode,
  // reading surface
  PlanOutline,
  PhaseEntry,
  PlanSlice,
  // run events
  NodeOutcome,
  FrameRef,
  RunEvent,
  PendingFrame,
  JoinState,
  RunProjection,
  // injected seams
  CallInvokerFn,
  ToolResult,
  ArtifactMethodDescriptor,
  ArtifactClassLike,
  ReasonerFn,
  PredicateEvaluator,
  PredicateContext,
  PredicateVerdict,
  AuthorityClaim,
  AuthorityVerb,
  // ops & bounds
  PlanOp,
  PlanBounds,
  // templates
  PlanTemplate,
  TemplateArgValue,
  TemplateNode,
  TemplateDefinitionOf,
  InstantiateResult,
  // views
  RawPlanView,
  PlanSummary,
  PlanIssue,
  PlanDiff,
  ApprovalRecord,
  InterruptionCause,
  // provenance
  PlanProvenance,
  ClonedFrom,
  InstantiatedFrom,
  // assembly
  RunDeps,
  RunOptions,
  ExecutePlanFn,
  FreezeInputs,
  InvocableTools,
  Orchestration,
  CreateOrchestration,
} from './types'

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * The install command for the optional `@nhtio/encoder` peer, surfaced in the
 * {@link E_ORCH_ENCODER_REQUIRED} message so the failure names the fix.
 */
const ENCODER_INSTALL = 'npm install @nhtio/encoder'

/**
 * Eagerly resolve the `@nhtio/encoder` optional peer and throw a named, fatal error if it is
 * absent. The encoder is required by orchestration — digests are load-bearing in every lifecycle
 * transition — but it stays an optional peer of the package as a whole, so the requirement is
 * enforced at construction rather than in `package.json`.
 *
 * @internal
 */
const requireEncoder = async (): Promise<void> => {
  try {
    await import('@nhtio/encoder')
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    throw new E_ORCH_ENCODER_REQUIRED([
      `orchestration requires the @nhtio/encoder optional peer, which could not be loaded. ` +
        `Install it with: ${ENCODER_INSTALL}. Underlying error: ${detail}`,
    ])
  }
}

/**
 * Load a single evaluator cell, surfacing a missing optional peer as
 * {@link E_ORCH_CELL_UNAVAILABLE}. A cell's own `load()` already maps an import failure to that
 * error; this wrapper additionally guards a cell whose `load` is missing or throws a non-named
 * error, so construction fails with a named error regardless of which path the failure took.
 *
 * @internal
 */
const loadCell = async (cell: PredicateEvaluator): Promise<void> => {
  const detail =
    `orchestration cell '${cell.id}' is unavailable: its optional peer could not be loaded. ` +
    `Install it with: npm install ${cell.id}.`
  try {
    await cell.load()
  } catch (err) {
    // A cell's own load() already throws E_ORCH_CELL_UNAVAILABLE; rethrow that verbatim.
    if (isInstanceOf(err, 'E_ORCH_CELL_UNAVAILABLE', E_ORCH_CELL_UNAVAILABLE)) throw err
    // Anything else becomes the named error so construction still fails loudly and by name.
    const reason = isError(err) ? err.message : String(err)
    throw new E_ORCH_CELL_UNAVAILABLE([`${detail} Underlying error: ${reason}`])
  }
}

/**
 * Merge evaluator cells by `id`: a per-run cell replaces the configured one with the same id,
 * others survive. A run legitimately swaps one cell while keeping the rest, so the merge is
 * cell-by-cell rather than wholesale.
 *
 * @internal
 */
const mergeEvaluators = (
  configured: readonly PredicateEvaluator[],
  perRun: readonly PredicateEvaluator[] | undefined
): PredicateEvaluator[] => {
  if (!perRun || perRun.length === 0) return [...configured]
  if (configured.length === 0) return [...perRun]
  const byId = new Map<string, PredicateEvaluator>()
  for (const cell of configured) byId.set(cell.id, cell)
  for (const cell of perRun) byId.set(cell.id, cell) // per-run wins by id
  return [...byId.values()]
}

/**
 * Resolve freeze inputs field-by-field against the construction defaults, merging `evaluators`
 * by cell id and replacing `invocable` wholesale. Returns the fully-resolved
 * {@link FreezeInputs} that `validation.ts`'s internal `freezePlan` expects.
 *
 * @internal
 */
const resolveFreezeInputs = (
  defaults: { invocable: InvocableTools; evaluators: PredicateEvaluator[] },
  override: Partial<FreezeInputs> | undefined
): FreezeInputs => ({
  invocable: override?.invocable ?? defaults.invocable,
  evaluators: mergeEvaluators(defaults.evaluators, override?.evaluators),
})

/**
 * Resolve per-run options against the construction `deps`, applying the same field-by-field
 * precedence: per-run wins, `evaluators` merge by cell id, everything else replaces wholesale.
 * The result is the `RunOptions` passed to the executor's internal `executePlan`.
 *
 * @internal
 */
const resolveRunOptions = (deps: Partial<RunDeps>, options: RunOptions): RunOptions => ({
  ...options,
  invokeCall: options.invokeCall ?? deps.invokeCall,
  reason: options.reason ?? deps.reason,
  evaluators: mergeEvaluators(deps.evaluators ?? [], options.evaluators),
  locks: options.locks ?? deps.locks,
})

// ── the assembly gate ──────────────────────────────────────────────────────

/**
 * THE battery's single entry point. Everything public is reached through the
 * {@link Orchestration} object it returns, so it is the one place a precondition can be enforced
 * for every operation.
 *
 * Construction is async because it eagerly resolves the `@nhtio/encoder` optional peer (throwing
 * {@link E_ORCH_ENCODER_REQUIRED} if absent), registers the orchestration encodables once, loads
 * every configured evaluator cell (so a missing optional peer surfaces here rather than at
 * freeze), and validates every registered template (so a misconfigured deployment fails at boot
 * with a named error rather than at first instantiation).
 *
 * **You do not need to call `registerOrchestrationEncodables()` yourself if you construct through
 * this function** — it runs here, before any plan can exist, so `decode()` can rebuild `NodeRef`
 * and `ParamRef` from that moment on. Call it directly only when you reach the deep subpaths
 * WITHOUT constructing an `Orchestration`: decoding a persisted plan in a worker that never builds
 * one, for instance. It is idempotent, so calling it anyway is harmless.
 *
 * See the module doc for the full rationale and the dependency-precedence rules.
 *
 * @param config - The store, tier-C allowlist, optional run-dependency defaults, and optional
 *   consumer-defined plan templates.
 * @returns The assembled {@link Orchestration} surface.
 * @throws {E_ORCH_ENCODER_REQUIRED} if `@nhtio/encoder` is not installed.
 * @throws {E_ORCH_CELL_UNAVAILABLE} if a configured evaluator cell's optional peer is missing.
 * @throws {Error} if a registered template has a blocking validation issue.
 */
export const createOrchestration: CreateOrchestration = async (config) => {
  if (!isObject(config)) {
    throw new TypeError('createOrchestration: config must be an object')
  }
  const { store, invocable, deps, templates } = config

  // 1. The encoder is required by orchestration. Resolve it eagerly and throw a named, fatal
  //    error naming the package and its install command if the optional peer is absent.
  await requireEncoder()
  // 2. Register the IR's encoder classes once. `registerClass` is a global registry, and
  //    decoding an unregistered class throws, so this must run before any decode.
  registerOrchestrationEncodables()

  // 3. Load every configured evaluator cell, so a missing optional peer surfaces at construction
  //    rather than part-way through a freeze. A per-run cell is loaded at the same point with the
  //    same named error.
  const configuredEvaluators = deps?.evaluators ?? []
  for (const cell of configuredEvaluators) {
    await loadCell(cell)
  }

  // 4. Validate every registered template. A blocking issue throws, so a misconfigured
  //    deployment fails at boot with a named error rather than at first instantiation.
  const registeredTemplates: PlanTemplate[] = []
  if (templates) {
    for (const tpl of templates) {
      const issues = validateTemplate(tpl, invocable)
      const blocking = issues.find((i) => i.severity === 'blocking')
      if (blocking) {
        const where = blocking.nodeId ?? blocking.edgeId ?? tpl.id
        throw new Error(
          `createOrchestration: template ${JSON.stringify(tpl.id)} is invalid (${where}): ` +
            `${blocking.code} — ${blocking.message}`
        )
      }
      registeredTemplates.push(tpl)
    }
  }

  // Snapshot the construction defaults for run/override resolution. `evaluators` is captured by
  // reference; mergeEvaluators composes against it on every call.
  const constructionDeps: Partial<RunDeps> = deps ?? {}
  const freezeDefaults = {
    invocable,
    evaluators: configuredEvaluators,
  }

  /** A stable actor identity for ops minted by the forge on behalf of this orchestration. */
  const actorId = `orchestration`

  const orchestration: Orchestration = {
    store,

    async freezePlan(planId, inputs) {
      const resolved = resolveFreezeInputs(freezeDefaults, inputs)
      return freezePlan(store, planId, resolved)
    },

    async approvePlan(planId, record) {
      return approvePlan(store, planId, record)
    },

    async executePlan(planId, options) {
      const resolved = resolveRunOptions(constructionDeps, options)
      return executePlan(store, planId, resolved)
    },

    async instantiate(templateId, args) {
      const tpl = registeredTemplates.find((t) => t.id === templateId)
      if (!tpl) {
        return {
          ok: false,
          reason: 'unknown_template',
          detail: `No template registered with id ${JSON.stringify(templateId)}.`,
        }
      }
      return instantiateTemplate(store, tpl, args, actorId)
    },

    templates() {
      return registeredTemplates.map((tpl) => ({
        id: tpl.id,
        summary: tpl.summary,
        params: tpl.params,
      }))
    },

    render: renderPlan,

    raw: {
      plan: rawPlan,
      ops: rawOps,
      diff: rawDiff,
      outline: planOutline,
    },

    tools(tier) {
      return forgeOrchestrationTools(
        {
          store,
          invocable,
          evaluators: configuredEvaluators,
          templates: registeredTemplates,
          actorId,
        },
        { tier }
      )
    },
  }

  return orchestration
}
