import { isError } from '@nhtio/adk/guards'
import { Middleware } from '@nhtio/middleware'
import { normalizeSandboxPath } from '../sandbox/paths'
import { E_INVALID_DEV_PIPELINE_CONFIG, E_DEV_STEP_FAILED } from './exceptions'
import { extensionOf, isPattern, pathMatches, validatePattern } from './matcher'
import type {
  DevCapabilityProbe,
  DevEngine,
  DevEngineRegistry,
  DevDispatchContext,
  DevInvocation,
  DevPlanRequest,
  DevPlanResult,
  DevSelectionContext,
  DevCandidate,
  StampedDelta,
  WorkspaceDelta,
} from './types'

const fail = (engine: string, index: number, reason: string): never => {
  throw new E_INVALID_DEV_PIPELINE_CONFIG([
    `engine "${engine}", capability index ${index}: ${reason}`,
  ])
}

/** Validate one declared capability, including the runtime-only parts of its contract. */
const validateCapability = (engine: string, index: number, cap: any, kind: string): any => {
  if (!cap || typeof cap !== 'object' || Array.isArray(cap))
    fail(engine, index, `${kind} capability must be an object`)
  const method = kind === 'format' ? 'format' : kind === 'lint' ? 'lint' : 'check'
  if (typeof cap[method] !== 'function')
    fail(engine, index, `${kind} capability method is required`)
  if (!Array.isArray(cap.extensions) || cap.extensions.length === 0)
    fail(engine, index, `${kind} extensions must be a non-empty array`)
  if (kind === 'lint' && typeof cap.fixable !== 'boolean')
    fail(engine, index, 'lint fixable must be a boolean')
  for (const ext of cap.extensions) {
    if (typeof ext !== 'string' || ext !== ext.toLowerCase() || ext.includes('.'))
      fail(engine, index, `invalid extension ${String(ext)}`)
  }
  for (const field of ['inPlace', 'generates', 'fixable'] as const) {
    if (cap[field] !== undefined && typeof cap[field] !== 'boolean')
      fail(engine, index, `${field} must be a boolean`)
  }
  if (cap.scope !== undefined) {
    if (!Array.isArray(cap.scope) || cap.scope.some((value: unknown) => typeof value !== 'string'))
      fail(engine, index, 'scope must be an array of strings')
    if (cap.scope.length === 0 && cap.inPlace)
      fail(engine, index, 'inPlace capabilities require a non-empty scope')
    try {
      cap.scope = [
        ...new Set(
          cap.scope.map((value: string) => {
            const normalized = normalizeSandboxPath(value.trim())
            return isPattern(normalized) ? validatePattern(normalized) : normalized
          })
        ),
      ].sort()
    } catch (error) {
      fail(engine, index, `invalid scope: ${isError(error) ? error.message : String(error)}`)
    }
  } else if (cap.inPlace) {
    fail(engine, index, 'inPlace capabilities require a non-empty scope')
  }
  if (cap.needs !== undefined) {
    if (!Array.isArray(cap.needs) || cap.needs.some((value: unknown) => typeof value !== 'string'))
      fail(engine, index, 'needs must be a string array')
    const allowed = new Set(['delete', 'rename', 'mkdir'])
    for (const need of cap.needs)
      if (!allowed.has(need)) fail(engine, index, `unknown needs value ${String(need)}`)
    cap.needs = [...new Set(cap.needs)]
  }
  if (kind === 'lint' && cap.generates === true && cap.fixable !== true)
    fail(engine, index, 'generates requires fixable: true')
  return cap
}

/** Duck-type guard for a complete engine declaration. */
const implementsDevEngine = (engine: unknown, engineIndex: number): engine is DevEngine => {
  const value = engine as any
  const name = value && typeof value.id === 'string' ? value.id : `index ${engineIndex}`
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `engine "${name}", capability index 0: engine must be an object`,
    ])
  if (typeof value.id !== 'string')
    throw new E_INVALID_DEV_PIPELINE_CONFIG([
      `engine "${name}", capability index 0: id must be a string`,
    ])
  return true
}

/** Build a declaration-only, stateless development engine registry. */
export const buildDevRegistry = (
  engines: readonly DevEngine[],
  selection: readonly any[] = []
): DevEngineRegistry => {
  const ids = new Set<string>()
  const normalized: DevEngine[] = []
  engines.forEach((engine, ei) => {
    implementsDevEngine(engine, ei)
    if (ids.has(engine.id))
      throw new E_INVALID_DEV_PIPELINE_CONFIG([`duplicate engine id "${engine.id}"`])
    ids.add(engine.id)
    const copy: any = { ...engine }
    for (const kind of ['formats', 'lints', 'checks'] as const) {
      if (copy[kind] === undefined) continue
      if (!Array.isArray(copy[kind]))
        throw new E_INVALID_DEV_PIPELINE_CONFIG([
          `engine "${engine.id}", capability index 0: ${kind} must be an array`,
        ])
      copy[kind] = copy[kind].map((capability: unknown, index: number) =>
        validateCapability(engine.id, index, capability, kind.slice(0, -1))
      )
    }
    normalized.push(copy)
  })
  const probe: DevCapabilityProbe = {
    hasFormat: (extension) =>
      normalized.some((x) =>
        (x.formats ?? []).some(
          (c) =>
            extension === undefined ||
            c.extensions.includes('*') ||
            c.extensions.includes(extension)
        )
      ),
    hasLint: (extension) =>
      normalized.some((x) =>
        (x.lints ?? []).some(
          (c) =>
            extension === undefined ||
            c.extensions.includes('*') ||
            c.extensions.includes(extension)
        )
      ),
    hasCheck: (extension) =>
      normalized.some((x) =>
        (x.checks ?? []).some(
          (c) =>
            extension === undefined ||
            c.extensions.includes('*') ||
            c.extensions.includes(extension)
        )
      ),
  }
  const matchesExtension = (extensions: readonly string[], extension: string): boolean =>
    extensions.includes('*') || extensions.includes(extension)
  const inScope = (scope: readonly string[] | undefined, path: string): boolean =>
    scope === undefined || scope.some((pattern) => pathMatches(pattern, path))
  const entries = (kind: 'format' | 'lint' | 'check') =>
    normalized.flatMap((engine) =>
      (engine[kind === 'format' ? 'formats' : kind === 'lint' ? 'lints' : 'checks'] ?? []).map(
        (capability: any, capabilityIndex: number) => ({ engine, capability, capabilityIndex })
      )
    )
  const arbitrate = async (
    kind: DevSelectionContext['kind'],
    group: string | null,
    request: { paths: readonly string[]; extensions: readonly string[] },
    candidates: DevCandidate[]
  ): Promise<DevCandidate[]> => {
    if (selection.length === 0 || candidates.length <= 1) return candidates
    const context: DevSelectionContext = { kind, group, request, candidates: [...candidates] }
    const middleware = new Middleware<any>()
    for (const fn of selection) middleware.add(fn)
    let failed: unknown
    // Flag, not a value test: `throw undefined` is legal JS and `failed !== undefined` cannot
    // tell it from "no error", so a stage rejecting with undefined would be silently ignored.
    let didFail = false
    await middleware
      .runner()
      .errorHandler(async (error) => {
        didFail = true
        failed = error
      })
      .finalHandler(async () => {})
      .run((fn, next) => Promise.resolve(fn(context, next)))
    if (didFail) throw failed
    const original = new Set(
      candidates.map((candidate) => `${candidate.engineId}\\0${candidate.capabilityIndex}`)
    )
    const seen = new Set<string>()
    return context.candidates.filter((candidate) => {
      const key = `${candidate.engineId}\\0${candidate.capabilityIndex}`
      if (!original.has(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const plan = async (request: DevPlanRequest): Promise<DevPlanResult> => {
    const invocations: DevInvocation[] = []
    const skipped: Array<DevPlanResult['skipped'][number]> = []
    const scopeExcluded: Array<DevPlanResult['scopeExcluded'][number]> = []
    const all = entries(request.kind)
    const lookup = new Map(
      all.map((entry) => [`${entry.engine.id}\\0${entry.capabilityIndex}`, entry])
    )
    const groups = [...new Set(request.paths.map(extensionOf))].sort()
    const selected = new Map<
      string,
      { candidate: DevCandidate; groups: string[]; paths: string[]; order: number }
    >()
    for (let groupIndex = 0; request.kind !== 'check' && groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]
      const paths = request.paths.filter((path) => extensionOf(path) === group)
      const candidates = all
        .filter(
          (entry) =>
            matchesExtension(entry.capability.extensions, group) && !entry.capability.generates
        )
        .map((entry) => ({
          engineId: entry.engine.id,
          capabilityIndex: entry.capabilityIndex,
          extensions: entry.capability.extensions,
          inPlace: entry.capability.inPlace === true,
        }))
      if (candidates.length === 0) {
        skipped.push({ group, reason: 'no-capability', extensions: [group] })
        continue
      }
      const survivors = await arbitrate(
        request.kind,
        group,
        { paths, extensions: [group] },
        candidates
      )
      if (survivors.length === 0) {
        skipped.push({ group, reason: 'suppressed-by-selection', extensions: [group] })
        continue
      }
      for (const candidate of request.kind === 'format' ? survivors.slice(0, 1) : survivors) {
        const key = `${candidate.engineId}\\0${candidate.capabilityIndex}`
        const current = selected.get(key)
        const admitted = paths.filter((path) => inScope(lookup.get(key)!.capability.scope, path))
        if (current) {
          current.groups.push(group)
          current.paths.push(...admitted)
        } else selected.set(key, { candidate, groups: [group], paths: admitted, order: groupIndex })
      }
    }
    if (request.kind === 'check') {
      const extensions = [
        ...new Set(
          request.extensions.length > 0 ? request.extensions : request.paths.map(extensionOf)
        ),
      ].sort()
      const candidates = all
        .filter((entry) =>
          extensions.some((extension) => matchesExtension(entry.capability.extensions, extension))
        )
        .map((entry) => ({
          engineId: entry.engine.id,
          capabilityIndex: entry.capabilityIndex,
          extensions: entry.capability.extensions,
          inPlace: false,
        }))
      if (candidates.length === 0) {
        skipped.push({ group: null, reason: 'no-capability', extensions })
      } else {
        const survivors = await arbitrate('check', null, { paths: [], extensions }, candidates)
        if (survivors.length === 0)
          skipped.push({ group: null, reason: 'suppressed-by-selection', extensions })
        for (const candidate of survivors)
          selected.set(`${candidate.engineId}\\0${candidate.capabilityIndex}`, {
            candidate,
            groups: [],
            paths: [],
            order: 0,
          })
      }
    }
    const generators = all
      .filter((entry) => entry.capability.generates === true)
      .map((entry) => ({
        engineId: entry.engine.id,
        capabilityIndex: entry.capabilityIndex,
        extensions: entry.capability.extensions,
        inPlace: entry.capability.inPlace === true,
      }))
    for (const candidate of await arbitrate(
      request.kind,
      null,
      { paths: [], extensions: [] },
      generators
    )) {
      const entry = lookup.get(`${candidate.engineId}\\0${candidate.capabilityIndex}`)!
      const paths = request.paths.filter((path) => inScope(entry.capability.scope, path))
      selected.set(`${candidate.engineId}\\0${candidate.capabilityIndex}`, {
        candidate,
        groups: [],
        paths,
        order: groups.length + selected.size,
      })
    }
    for (const item of [...selected.values()].sort((left, right) => left.order - right.order)) {
      const entry = lookup.get(`${item.candidate.engineId}\\0${item.candidate.capabilityIndex}`)!
      const capability: any = entry.capability
      const excluded = request.paths.filter(
        (path) =>
          matchesExtension(capability.extensions, extensionOf(path)) &&
          capability.scope !== undefined &&
          !inScope(capability.scope, path)
      ).length
      if (excluded > 0)
        scopeExcluded.push({
          engineId: item.candidate.engineId,
          capabilityIndex: item.candidate.capabilityIndex,
          count: excluded,
        })
      invocations.push({
        engineId: item.candidate.engineId,
        capabilityIndex: item.candidate.capabilityIndex,
        kind: request.kind,
        groups: item.groups,
        paths: [...new Set(item.paths)],
        selector: request.selector,
        fix: request.fix && capability.fixable === true,
        inPlace: capability.inPlace === true,
        scope: capability.scope ?? null,
        needs: capability.needs ?? [],
        generates: capability.generates === true,
        fixable: capability.fixable === true,
      })
    }
    return { invocations, skipped, scopeExcluded }
  }
  const dispatch = async (
    invocation: DevInvocation,
    context: DevDispatchContext
  ): Promise<StampedDelta> => {
    const list = normalized.find((engine) => engine.id === invocation.engineId)?.[
      invocation.kind === 'format' ? 'formats' : invocation.kind === 'lint' ? 'lints' : 'checks'
    ] as any[] | undefined
    const capability: any = list?.[invocation.capabilityIndex]
    if (!capability)
      throw new E_DEV_STEP_FAILED([
        invocation.kind,
        `engine "${invocation.engineId}" capability ${invocation.capabilityIndex} is unavailable`,
      ])
    const files = new Map([...context.files].map(([path, file]) => [path, { ...file }]))
    const request: any =
      invocation.kind === 'check'
        ? { files, root: context.root, signal: context.signal }
        : {
            files,
            paths: invocation.paths,
            selector: invocation.selector,
            root: context.root,
            signal: context.signal,
            ...(invocation.inPlace ? { access: context.makeAccess(invocation) } : {}),
            ...(invocation.kind === 'lint' ? { fix: invocation.fix } : {}),
          }
    try {
      const delta: WorkspaceDelta =
        await capability[
          invocation.kind === 'format' ? 'format' : invocation.kind === 'lint' ? 'lint' : 'check'
        ](request)
      return {
        ...delta,
        diagnostics: (delta.diagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          engineId: invocation.engineId,
        })),
      }
    } catch (error) {
      throw new E_DEV_STEP_FAILED(
        [
          invocation.kind,
          `engine "${invocation.engineId}": ${isError(error) ? error.message : String(error)}`,
        ],
        { cause: error }
      )
    }
  }
  return { ...probe, engines: normalized, plan, dispatch }
}
