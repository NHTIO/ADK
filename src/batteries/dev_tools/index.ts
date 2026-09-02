/**
 * Typed development-editing pipeline contracts and factory.
 *
 * @module @nhtio/adk/batteries/dev-tools
 */
import { DEV_ARG_SPECS } from './arg_specs'
import { validator } from '@nhtio/validation'
import { buildDevRegistry } from './registry'
import { narratingPath } from '../sandbox/tools'
import { createFsNode } from '../sandbox/node/fs_node'
import { runOnion } from '../../lib/middleware/run_onion'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { E_LLM_EXECUTION_GATE_NOT_SUPPORTED } from '../../exceptions'
import { extensionOf, globMatches, patternsOverlap, validatePattern } from './matcher'
import { applyUpdateHunks, isStructuredPatch, parseStructuredPatch } from '../../lib/patch'
import {
  classifySandboxPathRejection,
  createExistingSymlinkGuard,
  normalizeSandboxPath,
} from '../sandbox/paths'
import {
  E_DEV_BAD_ARG,
  E_DEV_ENGINE_REQUIRED,
  E_DEV_GATE_DECLINED,
  E_DEV_STEP_FAILED,
  E_DEV_STEP_UNAVAILABLE,
  E_DEV_UNKNOWN_STEP,
  E_INVALID_DEV_PIPELINE_CONFIG,
} from './exceptions'
import {
  acquireWorkspace,
  applyDelta,
  assembleChanges,
  canonicalizeDevRoot,
  derivePatchOutcome,
  makeDevFileAccess,
  rereadInPlace,
  resolveAcquisitionTargets,
  runtimeDiagnostic,
  snapshotInPlaceEnvelope,
  stampDiagnostics,
} from './runtime'
import type { SandboxHandle } from '../sandbox/manager'
import type { EngineResolver } from '../media/contracts'
import type { ParsedApplyPatch, ParsedHunk } from '../../lib/patch'
import type { MimeResolver } from '../sandbox/contracts/mime_resolver'
import type { SandboxFileSystem } from '../sandbox/contracts/file_system'
import type { PathTranslator } from '../sandbox/contracts/path_translator'
import type {
  DevChain,
  DevOp,
  DevPlan,
  DevResult,
  RunOptions,
  ExecutionState,
  DevGateContext,
  DevGateFn,
  RawDiagnostic,
} from './types'
import type {
  DevEngine,
  DevPipeline,
  DevSelectionMiddlewareFn,
  DevStepMiddlewareFn,
  DevStepContext,
  DevWorkspace,
  DevWorkspaceToken,
  WorkspaceBounds,
} from './types'

/** Configuration for {@link createDevPipeline}. */
interface DevPipelineConfig {
  /** Required sandbox handle supplying effective policy and epoch discipline. */
  handle: SandboxHandle
  /** Required filesystem adapter; optional mutation methods determine capability availability. */
  fileSystem: SandboxFileSystem
  /** Required translator; backend locators must be absolute host paths under root. */
  pathTranslator: PathTranslator
  /** Required gate called once for each executable step. */
  gate: DevGateFn
  /** Absolute host directory forming the workspace boundary. */
  root: string
  /** Engines or asynchronous engine resolvers, resolved at construction. */
  engines?: EngineResolver<DevEngine>[]
  /** Selection onion stages, used to narrow or reorder candidates. */
  selection?: DevSelectionMiddlewareFn[]
  /** Step onion stages surrounding each step implementation. */
  use?: DevStepMiddlewareFn[]
  /** Optional overrides for workspace resource limits. */
  bounds?: Partial<WorkspaceBounds>
  /** Optional MIME resolver used for acquisition and delta admission. */
  mimeResolver?: MimeResolver
}

const defaults: WorkspaceBounds = {
  maxFiles: 500,
  maxBytesPerFile: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
}

const configSchema = validator
  .object({
    handle: validator.any().optional(),
    fileSystem: validator.any().optional(),
    pathTranslator: validator.any().optional(),
    gate: validator.any().optional(),
    root: validator.any().optional(),
    engines: validator.any().optional(),
    selection: validator.any().optional(),
    use: validator.any().optional(),
    bounds: validator.any().optional(),
    mimeResolver: validator.any().optional(),
  })
  .unknown(false)

const resolveEngine = async (
  entry: EngineResolver<DevEngine>,
  index: number
): Promise<DevEngine> => {
  let value: unknown = entry
  if (typeof value === 'function') {
    try {
      value = await (value as () => unknown)()
    } catch (error) {
      throw new E_INVALID_DEV_PIPELINE_CONFIG([
        `engines[${index}] resolver failed: ${isError(error) ? error.message : String(error)}`,
      ])
    }
    if (isObject(value) && 'default' in value && !('id' in value))
      value = (value as { default: unknown }).default
  }
  if (value === null || typeof value !== 'object' || typeof (value as DevEngine).id !== 'string')
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `engines[${index}] does not implement the DevEngine contract`,
    ])
  return value as DevEngine
}

const validateArgs = (step: DevOp): DevOp => {
  const spec = DEV_ARG_SPECS[step.step]
  if (spec === undefined) throw new E_DEV_UNKNOWN_STEP([`unknown development step "${step.step}"`])
  if (
    step === null ||
    typeof step !== 'object' ||
    step.args === null ||
    typeof step.args !== 'object' ||
    Array.isArray(step.args)
  )
    throw new E_DEV_BAD_ARG([`step "${step.step}" args must be an object`])
  for (const key of Object.keys(step.args)) {
    if (!(key in spec))
      throw new E_DEV_BAD_ARG([`step "${step.step}" has unknown argument "${key}"`])
  }
  for (const [key, rule] of Object.entries(spec)) {
    const value = step.args[key]
    if (value === undefined) {
      if (rule.required) throw new E_DEV_BAD_ARG([`step "${step.step}" requires "${key}"`])
      continue
    }
    if (rule.type === 'array') {
      if (!Array.isArray(value) || (rule.nonEmpty && value.length === 0))
        throw new E_DEV_BAD_ARG([`step "${step.step}" argument "${key}" must be a non-empty array`])
      if (rule.element === 'string' && value.some((item) => typeof item !== 'string'))
        throw new E_DEV_BAD_ARG([`step "${step.step}" argument "${key}" must contain strings`])
      if (typeof rule.element === 'object') {
        for (const item of value) {
          if (item === null || typeof item !== 'object' || Array.isArray(item))
            throw new E_DEV_BAD_ARG([`step "${step.step}" argument "${key}" must contain objects`])
          const fields = rule.element.fields
          for (const field of Object.keys(item)) {
            if (!(field in fields))
              throw new E_DEV_BAD_ARG([
                `step "${step.step}" argument "${key}" has unknown field "${field}"`,
              ])
          }
          for (const [field, declaredRule] of Object.entries(fields)) {
            const fieldRule =
              typeof declaredRule === 'string' ? { type: declaredRule } : declaredRule
            const fieldValue = (item as Record<string, unknown>)[field]
            const invalidField =
              fieldValue === undefined ||
              !isDeclaredType(fieldValue, fieldRule.type) ||
              (fieldRule.nonEmpty && typeof fieldValue === 'string' && fieldValue.length === 0)
            if (invalidField)
              throw new E_DEV_BAD_ARG([
                `step "${step.step}" argument "${key}" field "${field}" has invalid type`,
              ])
          }
        }
      }
    } else if (
      !isDeclaredType(value, rule.type) ||
      (rule.nonEmpty && typeof value === 'string' && value.length === 0)
    ) {
      throw new E_DEV_BAD_ARG([`step "${step.step}" argument "${key}" has invalid type`])
    }
    const invalidLineNumber =
      step.step === 'read_lines' &&
      (key === 'start' || key === 'end') &&
      (!Number.isInteger(value) || (value as number) < 1)
    if (invalidLineNumber)
      throw new E_DEV_BAD_ARG([`step "${step.step}" argument "${key}" must be a positive integer`])
  }
  return {
    step: step.step,
    args: { ...step.args },
    ...(step.label === undefined ? {} : { label: step.label }),
  }
}

const hasMutation = (delta: {
  changed?: Map<unknown, unknown>
  added?: Map<unknown, unknown>
  deleted?: Set<unknown>
  renamed?: Map<unknown, unknown>
}): boolean =>
  Boolean(delta.changed?.size || delta.added?.size || delta.deleted?.size || delta.renamed?.size)

const isDeclaredType = (value: unknown, type: string): boolean => {
  if (type === 'object') return isObject(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  return false
}

const normalizeSelectors = (paths: readonly string[]): string[] => {
  const normalized: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string') throw new E_DEV_BAD_ARG(['step paths must be strings'])
    try {
      const value = normalizeSandboxPath(raw.trim())
      const normalizedSelector = value.includes('*') ? validatePattern(value) : value
      if (!normalized.includes(normalizedSelector)) normalized.push(normalizedSelector)
    } catch (error) {
      throw new E_DEV_BAD_ARG([
        `invalid step selector "${raw}": ${isError(error) ? error.message : String(error)}`,
      ])
    }
  }
  return normalized
}

const validateSelectors = (
  paths: readonly string[],
  files: ReadonlyMap<string, unknown>
): string[] => {
  const selected: string[] = []
  for (const value of paths) {
    if (value.includes('*')) {
      for (const path of files.keys())
        if (globMatches(value, path) && !selected.includes(path)) selected.push(path)
    } else if (files.has(value) && !selected.includes(value)) selected.push(value)
  }
  return selected
}

/** Construct a development-editing pipeline. */
export const createDevPipeline = async (config: DevPipelineConfig): Promise<DevPipeline> => {
  const { error: validationError } = configSchema.validate(config, { abortEarly: true })
  if (validationError) throw new E_INVALID_DEV_PIPELINE_CONFIG([validationError.message])
  if (config === null || !isObject(config))
    throw new E_INVALID_DEV_PIPELINE_CONFIG(['config must be an object'])
  if (
    typeof config.root !== 'string' ||
    !config.root ||
    config.root.includes('\0') ||
    !config.root.startsWith('/')
  )
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `root must be a non-empty absolute host path: ${String(config.root)}`,
    ])
  if (
    !config.handle ||
    !config.fileSystem ||
    !config.pathTranslator ||
    typeof config.gate !== 'function'
  )
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      'handle, fileSystem, pathTranslator, and gate are required',
    ])
  const bounds = { ...defaults, ...(config.bounds ?? {}) }
  for (const [name, value] of Object.entries(bounds))
    if (!Number.isInteger(value) || value < 1)
      throw new E_INVALID_DEV_PIPELINE_CONFIG([
        `${name} must be an integer >= 1; got ${String(value)}`,
      ])
  const root = canonicalizeDevRoot(config.root)
  let translatedRoot: string
  try {
    translatedRoot = config.pathTranslator.toBackendPath('') as string
  } catch (error) {
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `pathTranslator.toBackendPath('') failed for root "${config.root}": ${isError(error) ? error.message : String(error)}`,
    ])
  }
  if (typeof translatedRoot !== 'string' || canonicalizeDevRoot(translatedRoot) !== root)
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `pathTranslator.toBackendPath('') (${String(translatedRoot)}) must resolve to configured root (${config.root}); backend locators must be absolute host paths under root`,
    ])
  const resolved = await Promise.all((config.engines ?? []).map(resolveEngine))
  // Preserve declaration-array positions: registry candidate identities are (engineId, index).
  // An unavailable capability is a hole, rather than a compacted sibling array.
  const available = resolved.map((engine) => {
    const omitUnavailable = <T extends { needs?: readonly string[] }>(
      capabilities: readonly T[] | undefined
    ): T[] | undefined => {
      if (capabilities === undefined) return undefined
      const retained = [...capabilities]
      capabilities.forEach((capability, index) => {
        if (
          (capability.needs ?? []).some(
            (need) => typeof config.fileSystem[need as keyof SandboxFileSystem] !== 'function'
          )
        )
          delete retained[index]
      })
      return retained
    }
    return {
      ...engine,
      formats: omitUnavailable(engine.formats),
      lints: omitUnavailable(engine.lints),
    }
  })
  const registry = buildDevRegistry(available, config.selection ?? [])
  const compile = (ops: DevOp[]): DevPlan => {
    const steps = ops.map(validateArgs)
    for (const step of steps) {
      const kind = step.step as 'format' | 'lint' | 'check'
      if (!['format', 'lint', 'check'].includes(kind)) continue
      if (
        (kind === 'format' && !registry.hasFormat()) ||
        (kind === 'lint' && !registry.hasLint()) ||
        (kind === 'check' && !registry.hasCheck())
      )
        throw new E_DEV_ENGINE_REQUIRED([
          `no ${kind} capability is configured; register an engine before retrying`,
        ])
    }
    return { steps }
  }
  const execute = async (
    paths: readonly string[],
    plan: DevPlan,
    options?: RunOptions,
    granularPersistence = false
  ): Promise<DevResult> => {
    // Forged granular mutations have no workspace lifetime. Persist them through the
    // ordinary write machinery, while the step's approval remains the sole write gate.
    if (
      granularPersistence &&
      plan.steps.length === 1 &&
      ['edit', 'apply_patch', 'format', 'lint'].includes(plan.steps[0]!.step)
    ) {
      const step = plan.steps[0]!
      return execute(
        paths,
        {
          steps: [
            { ...step, args: { ...step.args, persists: true } },
            { step: 'write', args: {} },
          ],
        },
        options
      )
    }
    const gateContext: DevGateContext = {
      ...options?.gateContext,
      waitFor:
        options?.gateContext?.waitFor ??
        (() => Promise.reject(new E_LLM_EXECUTION_GATE_NOT_SUPPORTED())),
    }
    const acquisitionTargets = await resolveAcquisitionTargets({
      paths,
      fileSystem: config.fileSystem,
      pathTranslator: config.pathTranslator,
      signal: options?.signal,
    })
    const acquisitionGate = await config.gate(gateContext, {
      step: 'acquire',
      args: { paths },
      targets: acquisitionTargets,
    })
    if (acquisitionGate && !acquisitionGate.approved)
      throw new E_DEV_GATE_DECLINED([
        acquisitionGate.note ?? 'Approval was declined for acquisition.',
      ])
    let files = await acquireWorkspace({
      paths,
      targets: acquisitionTargets,
      fileSystem: config.fileSystem,
      pathTranslator: config.pathTranslator,
      bounds,
      mimeResolver: config.mimeResolver,
      signal: options?.signal,
    })
    const state: ExecutionState = {
      acquisitionBaseline: new Map(files),
      persistedBaseline: new Map(files),
      addedBy: new Map(),
    }
    let bookkeeping = {
      persistedPaths: new Map([...files.keys()].map((path) => [path, path])),
      pendingDeletions: new Map<string, string>(),
      recreated: new Set<string>(),
      renames: new Map<string, string>(),
      vacated: new Set<string>(),
      unreadable: new Set<string>(),
    }
    let diagnostics: DevResult['diagnostics'] = []
    const reads: Record<string, string> = {}
    const written: string[] = []
    const writeFailure = (reason: string) => {
      const error = new E_DEV_STEP_FAILED(['write', reason])
      Object.assign(error, { written: [...written] })
      return error
    }
    const stash = new Map<string, unknown>()
    const issuedTokens = new Set<DevWorkspaceToken>()
    const mintToken = (): DevWorkspaceToken => {
      const token = {} as DevWorkspaceToken
      issuedTokens.add(token)
      return token
    }
    let workspace: DevWorkspace = {
      files,
      unreadable: bookkeeping.unreadable,
      token: mintToken(),
      diagnostics,
      renames: bookkeeping.renames,
      persistedPaths: bookkeeping.persistedPaths,
      pendingDeletions: bookkeeping.pendingDeletions,
      recreated: bookkeeping.recreated,
    }
    const syncFromWorkspace = () => {
      files = workspace.files
      diagnostics = workspace.diagnostics
      bookkeeping = {
        ...bookkeeping,
        unreadable: workspace.unreadable,
        renames: workspace.renames,
        persistedPaths: workspace.persistedPaths,
        pendingDeletions: workspace.pendingDeletions,
        recreated: workspace.recreated,
      }
    }
    const syncToWorkspace = () => {
      workspace.files = files
      workspace.diagnostics = diagnostics
      workspace.unreadable = bookkeeping.unreadable
      workspace.renames = bookkeeping.renames
      workspace.persistedPaths = bookkeeping.persistedPaths
      workspace.pendingDeletions = bookkeeping.pendingDeletions
      workspace.recreated = bookkeeping.recreated
    }
    const mutationTarget = async (stepName: string, input: string, createParents = false) => {
      if (classifySandboxPathRejection(input) !== undefined)
        throw writeFailure(`path "${input}" is rejected`)
      let relative: string
      try {
        relative = normalizeSandboxPath(input)
      } catch (error) {
        throw writeFailure(
          `path "${input}" is rejected: ${isError(error) ? error.message : String(error)}`
        )
      }
      const translateMutationPath = async (path: string): Promise<string> => {
        try {
          return (await narratingPath(
            () => config.pathTranslator.toBackendPath(path),
            path
          )) as string
        } catch (error) {
          throw new E_DEV_STEP_FAILED([stepName, isError(error) ? error.message : String(error)], {
            cause: isError(error) ? error : undefined,
          })
        }
      }
      const backend = await translateMutationPath(relative)
      const policy = config.handle.effectivePolicy?.()
      if (policy === undefined)
        throw new E_DEV_STEP_FAILED([stepName, 'effective sandbox write policy is unavailable'])
      if (!createFsNode(policy).canWrite(backend))
        throw new E_DEV_STEP_FAILED([
          stepName,
          `path is refused by sandbox write policy: ${relative}`,
        ])
      const guard = createExistingSymlinkGuard(await translateMutationPath(''), config.fileSystem)
      if (createParents) {
        const parts = relative.split('/').slice(0, -1)
        for (let index = 1; index <= parts.length; index++) {
          const parent = parts.slice(0, index).join('/')
          const parentBackend = await translateMutationPath(parent)
          try {
            const stat = await config.fileSystem.stat(parentBackend)
            if (stat.kind !== 'dir') throw writeFailure(`parent "${parent}" is not a directory`)
          } catch (error) {
            if (isInstanceOf(error, 'E_DEV_STEP_FAILED', E_DEV_STEP_FAILED)) throw error
            if (!config.fileSystem.mkdir)
              throw writeFailure(
                `parent directory "${parent}" does not exist and filesystem cannot create it`
              )
            const parentPolicy = config.handle.effectivePolicy?.()
            if (parentPolicy === undefined)
              throw new E_DEV_STEP_FAILED([
                stepName,
                'effective sandbox write policy is unavailable',
              ])
            if (!createFsNode(parentPolicy).canWrite(parentBackend))
              throw new E_DEV_STEP_FAILED([
                stepName,
                `path is refused by sandbox write policy: ${parent}`,
              ])
            await guard(parent)
            try {
              await config.fileSystem.mkdir(parentBackend, { signal: options?.signal })
            } catch (mkdirError) {
              throw writeFailure(
                `mkdir "${parent}" failed: ${isError(mkdirError) ? mkdirError.message : String(mkdirError)}`
              )
            }
          }
        }
      }
      try {
        await guard(relative)
      } catch (error) {
        throw new E_DEV_STEP_FAILED([stepName, isError(error) ? error.message : String(error)])
      }
      return { relative, backend }
    }
    const executeStep = async (step: DevOp): Promise<void> => {
      if (step.step === 'read_lines') {
        const path = step.args.path as string
        const start = step.args.start as number
        const end = step.args.end as number | undefined
        const file = files.get(path)
        if (!file)
          throw new E_DEV_BAD_ARG([`read_lines path "${path}" is not in the current workspace`])
        const lines = file.text.split('\n')
        if (lines.at(-1) === '') lines.pop()
        if (start > lines.length)
          throw new E_DEV_BAD_ARG([
            `read_lines start ${start} is beyond the file's ${lines.length} lines`,
          ])
        if (end !== undefined && end < start)
          throw new E_DEV_BAD_ARG([
            `read_lines end ${end} is before start ${start}; use an ascending range`,
          ])
        const gate = await config.gate(gateContext, {
          step: 'read_lines',
          args: step.args,
          targets: [path],
        })
        if (gate && !gate.approved)
          throw new E_DEV_GATE_DECLINED([
            gate.note ?? 'Approval was declined for step "read_lines".',
          ])
        const label = step.label ?? path
        if (Object.hasOwn(reads, label))
          throw new E_DEV_BAD_ARG([`read_lines label "${label}" is duplicated`])
        reads[label] = lines.slice(start - 1, end === undefined ? lines.length : end).join('\n')
        return
      }
      if (step.step === 'edit') {
        const path = step.args.path as string
        const file = files.get(path)
        if (!file) throw new E_DEV_BAD_ARG([`edit path "${path}" is not in the current workspace`])
        const gate = await config.gate(gateContext, {
          step: 'edit',
          args: step.args,
          targets: [path],
        })
        if (gate && !gate.approved)
          throw new E_DEV_GATE_DECLINED([gate.note ?? 'Approval was declined for step "edit".'])
        let text = file.text
        try {
          for (const edit of step.args.edits as readonly { find: string; replace: string }[]) {
            const hunk: ParsedHunk = {
              oldLines: edit.find.replace(/\r\n/g, '\n').split('\n'),
              newLines: edit.replace.replace(/\r\n/g, '\n').split('\n'),
              added: 0,
              removed: 0,
            }
            text = applyUpdateHunks(text, [hunk])
          }
        } catch (error) {
          throw new E_DEV_STEP_FAILED(['edit', isError(error) ? error.message : String(error)])
        }
        if (text !== file.text)
          await applyDelta({
            delta: { changed: new Map([[path, text]]), diagnostics: [] },
            files,
            state,
            bounds,
            fileSystem: config.fileSystem,
            pathTranslator: config.pathTranslator,
            mimeResolver: config.mimeResolver,
            ...bookkeeping,
          })
        return
      }
      if (step.step === 'apply_patch') {
        const patch = step.args.patch as string
        if (!isStructuredPatch(patch))
          throw new E_DEV_BAD_ARG([
            'apply_patch requires a structured "*** Begin Patch" envelope; use edit for single-file changes',
          ])
        let parsed: ParsedApplyPatch
        try {
          parsed = parseStructuredPatch(patch)
        } catch (error) {
          throw new E_DEV_BAD_ARG([
            `apply_patch has an invalid structured envelope: ${isError(error) ? error.message : String(error)}`,
          ])
        }
        const targets = [
          ...new Set(
            parsed.operations.flatMap((operation) =>
              operation.type === 'update' && operation.movePath !== undefined
                ? [operation.path, operation.movePath]
                : [operation.path]
            )
          ),
        ].sort()
        const mayCreate = [
          ...new Set(
            parsed.operations.flatMap((operation) =>
              operation.type === 'add'
                ? [operation.path]
                : operation.type === 'update' && operation.movePath !== undefined
                  ? [operation.movePath]
                  : []
            )
          ),
        ].sort()
        const gate = await config.gate(gateContext, {
          step: 'apply_patch',
          args: step.args,
          targets,
          mayCreate,
        })
        if (gate && !gate.approved)
          throw new E_DEV_GATE_DECLINED([
            gate.note ?? 'Approval was declined for step "apply_patch".',
          ])
        let outcome: ReturnType<typeof derivePatchOutcome>
        try {
          outcome = derivePatchOutcome(files, parsed)
        } catch (error) {
          throw new E_DEV_STEP_FAILED([
            'apply_patch',
            isError(error) ? error.message : String(error),
          ])
        }
        for (const path of outcome.recreated) bookkeeping.recreated.add(path)
        await applyDelta({
          delta: outcome.delta,
          files,
          state,
          bounds,
          fileSystem: config.fileSystem,
          pathTranslator: config.pathTranslator,
          mimeResolver: config.mimeResolver,
          ...bookkeeping,
          skipAddedMimeResolution: true,
        })
        return
      }
      if (step.step === 'write') {
        const requested =
          step.args.paths === undefined
            ? undefined
            : normalizeSelectors(step.args.paths as readonly string[])
        const matchesRequested = (path: string): boolean =>
          requested?.some((candidate) =>
            candidate.includes('*') ? globMatches(candidate, path) : candidate === path
          ) === true
        // Structural paths are selected from the collapsed end state: a pending rename is one
        // operation, so either its workspace destination or former on-disk source selects both.
        const selected =
          requested === undefined ? [...files.keys()] : validateSelectors(requested, files)
        const pendingRenames = [...bookkeeping.persistedPaths].filter(([path, disk]) => {
          const matches =
            files.has(path) &&
            path !== disk &&
            (requested === undefined || matchesRequested(path) || matchesRequested(disk))
          if (matches && !selected.includes(path)) selected.push(path)
          return matches
        })
        const pendingDeletes = [...bookkeeping.pendingDeletions].filter(
          ([path, disk]) =>
            requested === undefined || matchesRequested(path) || matchesRequested(disk)
        )
        const writes = [...files].filter(([path, file]) => {
          if (requested !== undefined && !selected.includes(path)) return false
          const diskPath = bookkeeping.persistedPaths.get(path)
          // A renamed destination may retain its acquisition name as `path`, while its
          // on-disk source is a different baseline entry. Compare against that source.
          const baseline =
            diskPath !== undefined && diskPath !== path
              ? state.persistedBaseline.get(diskPath)
              : state.persistedBaseline.get(path)
          return baseline?.text !== file.text
        })
        const targets = [
          ...new Set([
            ...selected,
            ...pendingRenames.flatMap(([path, disk]) => [path, disk]),
            ...pendingDeletes.flatMap(([path, disk]) => [path, disk]),
          ]),
        ].sort()
        const mayCreate = writes
          .filter(([path]) => !bookkeeping.persistedPaths.has(path))
          .map(([path]) => path)
          .sort()
        const implicitGranularWrite =
          plan.steps.length === 2 && plan.steps[0]!.args.persists === true
        const gate = implicitGranularWrite
          ? undefined
          : await config.gate(gateContext, {
              step: 'write',
              args: step.args,
              targets,
              mayCreate,
            })
        if (gate && !gate.approved)
          throw new E_DEV_GATE_DECLINED([gate.note ?? 'Approval was declined for step "write".'])
        if (pendingRenames.length > 0 && !config.fileSystem.rename)
          throw new E_DEV_STEP_FAILED(['write', 'filesystem does not support rename'])
        if (pendingDeletes.length > 0 && !config.fileSystem.delete)
          throw new E_DEV_STEP_FAILED(['write', 'filesystem does not support delete'])
        // A destination must move before an operation that would overwrite it as a source.
        // Break a genuine cycle by first moving one source to a stat-checked sibling temporary.
        const remaining = new Map(pendingRenames)
        while (remaining.size) {
          const disks = new Set(remaining.values())
          const ready = [...remaining]
            .filter(([destination]) => !disks.has(destination))
            .sort(([a], [b]) => a.localeCompare(b))
          if (!ready.length) {
            const [destination, disk] = [...remaining].sort(([a], [b]) => a.localeCompare(b))[0]!
            const directory = destination.includes('/')
              ? destination.slice(0, destination.lastIndexOf('/'))
              : ''
            let temporary: string | undefined
            for (let attempt = 0; attempt < 8; attempt++) {
              const candidate = `${directory ? `${directory}/` : ''}.dev-tools-rename-${Math.random().toString(36).slice(2)}`
              try {
                await config.fileSystem.stat(
                  config.pathTranslator.toBackendPath(candidate) as string
                )
              } catch {
                temporary = candidate
                break
              }
            }
            if (!temporary)
              throw writeFailure(
                `could not allocate a temporary rename path in "${directory || '.'}"`
              )
            try {
              const source = await mutationTarget('write', disk)
              const temporaryTarget = await mutationTarget('write', temporary, true)
              await config.fileSystem.rename!(source.backend, temporaryTarget.backend, {
                signal: options?.signal,
              })
            } catch (error) {
              throw writeFailure(
                `rename cycle temporary "${temporary}" failed: ${isError(error) ? error.message : String(error)}`
              )
            }
            remaining.set(destination, temporary)
            continue
          }
          for (const [destination, disk] of ready) {
            try {
              const source = await mutationTarget('write', disk)
              const target = await mutationTarget('write', destination, true)
              await config.fileSystem.rename!(source.backend, target.backend, {
                signal: options?.signal,
              })
            } catch (error) {
              throw writeFailure(
                `rename to "${destination}" failed: ${isError(error) ? error.message : String(error)}`
              )
            }
            bookkeeping.persistedPaths.set(destination, destination)
            state.persistedBaseline.set(destination, { ...files.get(destination)! })
            if (!written.includes(destination)) written.push(destination)
            remaining.delete(destination)
          }
        }
        for (const [path, disk] of pendingDeletes.sort(([a], [b]) => a.localeCompare(b))) {
          try {
            const target = await mutationTarget('write', disk)
            await config.fileSystem.delete!(target.backend, { signal: options?.signal })
          } catch (error) {
            throw writeFailure(
              `delete "${path}" failed: ${isError(error) ? error.message : String(error)}`
            )
          }
          bookkeeping.pendingDeletions.delete(path)
          state.persistedBaseline.delete(path)
        }
        for (const [path, file] of writes.sort(([a], [b]) => a.localeCompare(b))) {
          try {
            const target = await mutationTarget('write', path, true)
            await config.fileSystem.write(target.backend, new TextEncoder().encode(file.text), {
              signal: options?.signal,
            })
          } catch (error) {
            throw writeFailure(
              `write "${path}" failed: ${isError(error) ? error.message : String(error)}`
            )
          }
          bookkeeping.persistedPaths.set(path, path)
          state.persistedBaseline.set(path, { ...file })
          if (!written.includes(path)) written.push(path)
        }
        return
      }
      if (!['format', 'lint', 'check'].includes(step.step))
        throw new E_DEV_STEP_UNAVAILABLE([step.step])
      const kind = step.step as 'format' | 'lint' | 'check'
      if (
        (kind === 'format' && !registry.hasFormat()) ||
        (kind === 'lint' && !registry.hasLint()) ||
        (kind === 'check' && !registry.hasCheck())
      )
        throw new E_DEV_ENGINE_REQUIRED([`no ${kind} capability is configured`])
      const authoredSelector = step.args.paths as readonly string[] | undefined
      const selector = authoredSelector === undefined ? null : normalizeSelectors(authoredSelector)
      const selected = selector === null ? [...files.keys()] : validateSelectors(selector, files)
      const eligibleGenerator =
        selector !== null &&
        registry.engines.some((engine) => {
          const capabilities =
            kind === 'format' ? engine.formats : kind === 'lint' ? engine.lints : undefined
          return (
            capabilities?.some((capability) => {
              if (capability?.generates !== true) return false
              return (
                capability.scope === undefined ||
                capability.scope.some((scope) =>
                  selector.some((pattern) => patternsOverlap(scope, pattern))
                )
              )
            }) === true
          )
        })
      if (selector !== null && selected.length === 0 && !eligibleGenerator)
        throw new E_DEV_BAD_ARG([`selector "${selector.join(', ')}" matches no workspace file`])
      const planned = await registry.plan({
        kind,
        paths: selected,
        extensions: [...new Set([...files.keys()].map(extensionOf))],
        selector,
        fix: step.args.fix === true,
      })
      const runtimeDiagnostics = [
        ...planned.skipped.map((item) => ({
          path: null,
          severity: 'info' as const,
          message:
            item.reason === 'no-capability'
              ? `no ${kind} capability is configured for extension group ${item.group ?? item.extensions.join(', ')}`
              : `selection suppressed ${kind} capability for extension group ${item.group ?? item.extensions.join(', ')}`,
          engineId: null,
        })),
        ...planned.scopeExcluded.map((item) => ({
          path: null,
          severity: 'info' as const,
          message: `${item.count} file(s) excluded by scope for engine "${item.engineId}" capability ${item.capabilityIndex}`,
          engineId: null,
        })),
      ]
      diagnostics.push(...stampDiagnostics(runtimeDiagnostics, files, root, config.pathTranslator))
      const mayCreate =
        kind === 'check'
          ? []
          : [
              ...new Set(
                planned.invocations.flatMap((invocation) => {
                  if (!invocation.inPlace) return ['**']
                  return invocation.selector === null
                    ? (invocation.scope ?? [])
                    : invocation.selector
                })
              ),
            ].sort()
      const gate = await config.gate(gateContext, {
        step: kind,
        args: step.args,
        targets: selected,
        mayCreate: mayCreate.includes('**') ? ['**'] : mayCreate,
        engines: planned.invocations.map((invocation) => ({
          engineId: invocation.engineId,
          extensions: invocation.groups,
          inPlace: invocation.inPlace,
          ...(invocation.scope === null ? {} : { scope: invocation.scope }),
        })),
      })
      if (gate && !gate.approved)
        throw new E_DEV_GATE_DECLINED([gate.note ?? `Approval was declined for step "${kind}".`])
      for (const invocation of planned.invocations) {
        // The preflight is only safe for files whose current workspace text is on disk.
        // Keep in-memory changes out of later in-place requests: an external fixer would
        // otherwise rewrite the stale disk version and its re-read would lose that change.
        // An in-place re-read refreshes persistedBaseline, so its own changes deliberately
        // become eligible for the next fixer in this same step.
        const dirtyPaths = new Set(
          [...files].flatMap(([path, file]) => {
            const persisted = state.persistedBaseline.get(path)
            return persisted === undefined || file.text !== persisted.text ? [path] : []
          })
        )
        const invocationPaths = invocation.inPlace
          ? invocation.paths.filter((path) => !dirtyPaths.has(path))
          : invocation.paths
        const effectiveInvocation = invocation.inPlace
          ? { ...invocation, paths: invocationPaths }
          : invocation
        // `paths` is extension-narrowed work selection.  The façade instead gets every
        // current workspace file in declared scope (then the explicit step boundary), so
        // a formatter can access its scoped non-source configuration and prior-step output.
        const allowlist = effectiveInvocation.inPlace
          ? [...files.keys()].filter(
              (path) =>
                effectiveInvocation.scope!.some((scope) => globMatches(scope, path)) &&
                (effectiveInvocation.selector === null ||
                  effectiveInvocation.selector.some((candidate) => globMatches(candidate, path))) &&
                !dirtyPaths.has(path)
            )
          : []
        const renameDestinations = new Set<string>()
        const policy = effectiveInvocation.inPlace ? config.handle.effectivePolicy() : undefined
        const access = effectiveInvocation.inPlace
          ? makeDevFileAccess({
              invocation: effectiveInvocation,
              allowlist,
              fileSystem: config.fileSystem,
              pathTranslator: config.pathTranslator,
              policy: policy === undefined ? undefined : createFsNode(policy),
              selector: effectiveInvocation.selector,
              signal: options?.signal,
              renameDestinations,
            })
          : undefined
        // Each envelope entry is a conjunction.  With a selector, re-reading either
        // side alone would admit files the façade was not allowed to create.
        const envelope: string[][] =
          invocation.scope === null
            ? []
            : invocation.selector === null
              ? invocation.scope.map((scope) => [scope])
              : invocation.scope.flatMap((scope) =>
                  invocation
                    .selector!.filter((candidate) => patternsOverlap(scope, candidate))
                    .map((candidate) => [scope, candidate])
                )
        const preRead = effectiveInvocation.inPlace
          ? await snapshotInPlaceEnvelope({
              envelope,
              excluded: dirtyPaths,
              files,
              fileSystem: config.fileSystem,
              pathTranslator: config.pathTranslator,
              signal: options?.signal,
            })
          : undefined
        const delta = await registry.dispatch(effectiveInvocation, {
          files,
          root,
          signal: options?.signal,
          makeAccess: () =>
            access ??
            (() => {
              throw new E_DEV_STEP_UNAVAILABLE(['DevFileAccess'])
            })(),
        })
        if (kind === 'check' && hasMutation(delta))
          throw new E_DEV_STEP_FAILED([
            effectiveInvocation.engineId,
            'check returned mutation fields',
          ])
        if (
          effectiveInvocation.paths.length === 0 &&
          !effectiveInvocation.generates &&
          hasMutation(delta)
        )
          throw new E_DEV_BAD_ARG([
            `engine "${effectiveInvocation.engineId}" mutated an empty invocation without generates`,
          ])
        if (effectiveInvocation.inPlace) {
          const reRead = await rereadInPlace({
            envelope: [...envelope, ...[...renameDestinations].map((path) => [path])],
            excluded: dirtyPaths,
            beforeSnapshot: preRead?.paths,
            files,
            unreadable: bookkeeping.unreadable,
            persistedPaths: bookkeeping.persistedPaths,
            persistedBaseline: state.persistedBaseline,
            renames: bookkeeping.renames,
            recreated: bookkeeping.recreated,
            fileSystem: config.fileSystem,
            pathTranslator: config.pathTranslator,
            bounds,
            mimeResolver: config.mimeResolver,
            signal: options?.signal,
          })
          const advisory = new Set<string>([
            ...(delta.changed?.keys() ?? []),
            ...(delta.added?.keys() ?? []),
            ...(delta.deleted ?? []),
            ...[...(delta.renamed ?? [])].flatMap(([from, to]) => [from, to]),
          ])
          const missing = [...reRead.changed].filter((path) => !advisory.has(path))
          const extra = [...advisory].filter((path) => !reRead.changed.has(path))
          const rereadDiagnostics: Array<
            RawDiagnostic & { engineId: string | null; [runtimeDiagnostic]?: boolean }
          > = [
            ...delta.diagnostics,
            ...(preRead?.diagnostics ?? []).map((diagnostic) => ({
              ...diagnostic,
              engineId: null,
              [runtimeDiagnostic]: true,
            })),
            ...reRead.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              engineId: null,
              [runtimeDiagnostic]: true,
            })),
          ]
          if (missing.length || extra.length)
            rereadDiagnostics.push({
              path: null,
              severity: 'warning',
              message: `engine advisory delta disagreed with re-read (unclaimed: ${missing.join(', ') || 'none'}; not observed: ${extra.join(', ') || 'none'})`,
              engineId: invocation.engineId,
              [runtimeDiagnostic]: true,
            })
          diagnostics.push(
            ...stampDiagnostics(
              rereadDiagnostics,
              files,
              root,
              config.pathTranslator,
              invocation.engineId
            )
          )
        } else {
          const applied = await applyDelta({
            delta,
            files,
            state,
            bounds,
            fileSystem: config.fileSystem,
            pathTranslator: config.pathTranslator,
            mimeResolver: config.mimeResolver,
            ...bookkeeping,
            engineId: invocation.engineId,
            invocationPaths: invocation.paths,
            selector: invocation.selector,
          })
          diagnostics.push(
            ...stampDiagnostics(
              applied.diagnostics,
              files,
              root,
              config.pathTranslator,
              invocation.engineId
            )
          )
        }
      }
    }
    for (const [stepIndex, step] of plan.steps.entries()) {
      const context: DevStepContext = {
        plan,
        stepIndex,
        step,
        workspace,
        stash,
        signal: options?.signal,
        engines: registry,
        shortCircuit: (replacement): never => {
          throw { devToolsShortCircuit: true, workspace: replacement }
        },
      }
      try {
        await runOnion(
          context,
          config.use ?? [],
          async () => {
            syncFromWorkspace()
            await executeStep(step)
            syncToWorkspace()
            if (step.step === 'write') {
              const token = mintToken()
              ;(workspace as { token: DevWorkspaceToken }).token = token
            }
          },
          () => {
            throw new E_DEV_STEP_FAILED([step.step, 'middleware returned without calling next()'])
          }
        )
      } catch (error) {
        if (isObject(error) && error.devToolsShortCircuit === true && 'workspace' in error) {
          const replacement = error.workspace as DevWorkspace
          if (!issuedTokens.has(replacement.token) || replacement.token !== workspace.token)
            throw new E_DEV_STEP_FAILED([
              step.step,
              'middleware shortCircuit workspace is stale or foreign',
            ])
          workspace = replacement
          syncFromWorkspace()
          continue
        }
        throw error
      }
    }
    const summary = await assembleChanges(
      state.acquisitionBaseline,
      files,
      bookkeeping.renames,
      bookkeeping.recreated,
      bookkeeping.unreadable
    )
    return {
      diagnostics,
      changes: summary.changes,
      reads,
      written,
      unreadable: [...bookkeeping.unreadable].sort(),
      ok: !diagnostics.some((item) => item.severity === 'error'),
      lineCountsAvailable: summary.lineCountsAvailable,
    }
  }
  const pipeline = ((paths: readonly string[], options?: RunOptions): DevChain => {
    const make = (ops: DevOp[], open?: RunOptions): DevChain => {
      const append = (step: string, args: Record<string, unknown> = {}): DevChain =>
        make([...ops, { step, args }], open)
      return {
        readLines: (args) =>
          make(
            [
              ...ops,
              {
                step: 'read_lines',
                args: {
                  path: args.path,
                  start: args.start,
                  ...(args.end === undefined ? {} : { end: args.end }),
                },
                ...(args.label === undefined ? {} : { label: args.label }),
              },
            ],
            open
          ),
        edit: (args) => append('edit', args),
        applyPatch: (args) => append('apply_patch', args),
        write: (args) => append('write', args ?? {}),
        format: (args) => append('format', args ?? {}),
        lint: (args) => append('lint', args ?? {}),
        check: () => append('check'),
        run: (override) => execute(paths, compile(ops), { ...open, ...override }),
        then: (onfulfilled, onrejected) =>
          execute(paths, compile(ops), open).then(onfulfilled, onrejected),
        toOps: () => ops.map((op) => ({ ...op, args: { ...op.args } })),
      }
    }
    return make([], options)
  }) as DevPipeline
  Object.defineProperties(pipeline, {
    ops: {
      value: (paths: readonly string[], ops: DevOp[], options?: RunOptions) =>
        execute(paths, compile(ops), options),
    },
    compile: { value: compile },
    capabilities: { value: registry },
    engines: { value: registry.engines },
    _runGranular: {
      value: (paths: readonly string[], ops: DevOp[], options?: RunOptions) =>
        execute(paths, compile(ops), options, true),
    },
  })
  return pipeline
}

export type {
  DevCapabilityProbe,
  Severity,
  RawDiagnostic,
  Diagnostic,
  WorkspaceDelta,
  FileChangeSummary,
  DevResult,
  FormatCapability,
  LintCapability,
  CheckCapability,
  DevEngine,
  FormatRequest,
  LintRequest,
  CheckRequest,
  DevFileAccess,
  DevWorkspaceToken,
  DevWorkspace,
  DevGateVerdict,
  DevGateContext,
  DevGateCall,
  DevGateFn,
  DevCandidate,
  DevSelectionContext,
  DevStep,
  DevPlan,
  DevOp,
  WorkspaceBounds,
  RunOptions,
  DevStepContext,
  DevStepMiddlewareFn,
  DevSelectionMiddlewareFn,
  DevChain,
  DevPipeline,
} from './types'
export * from './exceptions'
