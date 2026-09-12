import { DateTime } from 'luxon'
import { isObject } from '@nhtio/adk/guards'
import { createSkillMiddlewareSet } from './middleware'
import { createSkillArtifactRegistry } from './artifacts'
import { rewrapSkillTool, assertSkillToolNames } from './import'
import { resolveSkillChannel, spoolSkillBody } from './channels'
import { forgeIsolatedTools, validateIsolationConfig } from './isolated'
import { Retrievable, Tool, SpooledMarkdownArtifact } from '@nhtio/adk/common'
import { forgeSkillScriptTool, validateSkillScript, validateSkillSourcePath } from './scripts'
import {
  E_INVALID_SKILLS_CONFIG,
  E_SKILL_MANIFEST_INVALID,
  E_SKILL_NOT_FOUND,
  E_SKILL_ALREADY_LOADED,
  E_SKILL_NOT_LOADED,
} from './exceptions'
import type { SkillRef, SkillSource } from './contracts'
import type { DispatchContext, TurnContext } from '@nhtio/adk/types'
import type {
  SkillDescriptor,
  SkillManager,
  SkillManagerConfig,
  SkillSourceResolver,
  LoadResult,
  RefreshResult,
  ProjectedSkill,
  SkillWorkspace,
} from './types'

/**
 * The live ownership record captured by every skill-owned tool wrapper. `tryEnter()` performs
 * the retired check and active-call increment in one synchronous operation; `exit()` decrements
 * it and releases a retired workspace when the last call finishes. Retirement is synchronous and
 * is performed only while the manager mutex is held. Every skill-owned tool wrapper — module
 * tools, isolated JS tools and scripts alike — must close over this exact record rather than
 * consulting a registry, because hydrated wrappers can outlive the context they were registered
 * in: unregistering reaches only the context that requested the unload, so the record is the
 * authority on liveness and the registry is not.
 */
export interface SkillRecord {
  readonly id: string
  readonly version: string
  readonly retired: boolean
  tryEnter(): boolean
  exit(): void
}

type LiveRecord = SkillRecord & {
  ref: SkillRef
  descriptor: SkillDescriptor
  tools: Tool[]
  retrievable?: Retrievable
  /** Tool-call timestamp after which body-reader calls belong to this loaded record. */
  loadedAt: DateTime
  root?: string
  workspace?: SkillWorkspace
  waitForDisposal(): Promise<void>
  retire(): void
  activeCalls(): number
  forceDispose(): void
}

type Candidate = { ref: SkillRef; shadowedBy?: SkillRef }

const asSource = async (resolver: SkillSourceResolver): Promise<SkillSource> => {
  const value = typeof resolver === 'function' ? await resolver() : resolver
  const source =
    isObject(value) && 'default' in value ? (value as { default: SkillSource }).default : value
  if (!source || typeof source.id !== 'string' || typeof source.discover !== 'function') {
    throw new Error('does not implement the SkillSource contract')
  }
  return source
}

const bodyText = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const response = new Response(stream)
  return response.text()
}

/**
 * Create a skills manager. Construct one manager per conversation/session, alongside its runner;
 * share source objects when discovery caching is desired, but never share loaded manager state.
 */
export const createSkillManager = async (config: SkillManagerConfig): Promise<SkillManager> => {
  if (!config || !Array.isArray(config.sources) || typeof config.gate !== 'function') {
    throw new E_INVALID_SKILLS_CONFIG(['sources and gate are required'])
  }
  validateIsolationConfig(config)
  if (
    config.scripts &&
    !config.scripts.hostEnvIsolated &&
    !config.unsafe?.scriptsPermissivePolicy
  ) {
    throw new E_INVALID_SKILLS_CONFIG([
      'scripts.hostEnvIsolated is required unless unsafe.scriptsPermissivePolicy is enabled',
    ])
  }
  const unsafe = [
    config.isolation && !config.isolation.resolveGuest && config.unsafe?.isolatedToolsInProcess
      ? 'isolatedToolsInProcess'
      : undefined,
    config.unsafe?.scriptsPermissivePolicy ? 'scriptsPermissivePolicy' : undefined,
    config.unsafe?.ungatedSkillTools ? 'ungatedSkillTools' : undefined,
  ].filter((value): value is string => value !== undefined)
  for (const control of unsafe) console.warn(`Skill unsafe control enabled: ${control}`)
  const sources: SkillSource[] = []
  try {
    for (const resolver of config.sources) sources.push(await asSource(resolver))
  } catch (error) {
    throw new E_INVALID_SKILLS_CONFIG([`sources resolver failed: ${String(error)}`])
  }
  const sourceIds = new Set<string>()
  for (const source of sources) {
    if (sourceIds.has(source.id))
      throw new E_INVALID_SKILLS_CONFIG([`duplicate source id: ${source.id}`])
    sourceIds.add(source.id)
  }

  const artifactRegistry = await createSkillArtifactRegistry(config)
  const withLock = (() => {
    let tail = Promise.resolve()
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await fn()
      } finally {
        release()
      }
    }
  })()

  let candidates: Candidate[] = []
  const updateAvailable = new Set<string>()
  const records = new Map<string, LiveRecord>()
  const reservations = new Map<string, string>()
  let disposed = false

  const discover = async (onlyId?: string): Promise<RefreshResult> => {
    const next: Candidate[] = []
    const seen = new Map<string, SkillRef>()
    for (const source of sources) {
      try {
        for await (const discovered of source.discover()) {
          if (onlyId !== undefined && discovered.id !== onlyId) continue
          const ref = { ...discovered, sourceId: source.id } as SkillRef
          const prior = seen.get(ref.id)
          if (!prior) {
            seen.set(ref.id, ref)
            next.push({ ref })
          } else next.push({ ref, shadowedBy: prior })
        }
      } catch (error) {
        throw new E_INVALID_SKILLS_CONFIG([
          `source discovery failed: ${source.id}: ${String(error)}`,
        ])
      }
    }
    if (onlyId === undefined) candidates = next
    else candidates = [...candidates.filter((c) => c.ref.id !== onlyId), ...next]
    const updates = [...records]
      .filter(
        ([id]) => candidates.find((c) => c.ref.id === id)?.ref.version !== records.get(id)?.version
      )
      .map(([id]) => id)
    for (const id of updates) updateAvailable.add(id)
    return {
      ids: [...new Set(next.map((c) => c.ref.id))],
      updateAvailable: updates,
    }
  }
  await discover()

  const winner = (id: string): Candidate | undefined =>
    candidates.find((c) => c.ref.id === id && !c.shadowedBy)
  const sourceFor = (ref: SkillRef): SkillSource =>
    sources.find((source) => source.id === ref.sourceId) as SkillSource
  const descriptorFor = async (ref: SkillRef): Promise<SkillDescriptor> => {
    const descriptor = await sourceFor(ref).descriptor(ref)
    if (!descriptor || typeof descriptor !== 'object') throw new E_SKILL_MANIFEST_INVALID([ref.id])
    const value = descriptor as SkillDescriptor
    if (value.id !== ref.id || value.version !== ref.version)
      throw new E_SKILL_MANIFEST_INVALID([`${ref.id}: id/version mismatch`])
    if (typeof value.name !== 'string' || typeof value.description !== 'string')
      throw new E_SKILL_MANIFEST_INVALID([ref.id])
    return value
  }

  const makeRecord = (
    ref: SkillRef,
    descriptor: SkillDescriptor,
    tools: readonly Tool[],
    retrievable: Retrievable | undefined,
    root: string | undefined,
    workspace: SkillWorkspace | undefined
  ): LiveRecord => {
    let retired = false
    let active = 0
    // Workspace disposal is refcount-gated, not racy. `disposeRoot` is only ever called when
    // `active === 0` (from `exit()` as the last call settles, or from `retire()`/`forceDispose()`
    // when none is in flight), so no live call can be mid-`handle.run` against a directory being
    // disposed — `tryEnter()` returns false the instant `retired` is set, so a new call cannot
    // start either. The dispose promise is captured (not fired-and-forgotten) so `dispose()` can
    // await every record's `waitForDisposal()` before returning, and `disposeRoot` is idempotent:
    // the `!disposal` guard means a second trigger (e.g. retire after exit) never starts a second
    // teardown. That is why disposal is not awaited inline at each call site — awaiting it there
    // would serialise unrelated unloads for no benefit, since the guarantee is structural.
    let disposal: Promise<void> | undefined
    const disposeRoot = (): void => {
      if (!disposal && root && workspace) disposal = workspace.dispose(root)
    }
    const record: LiveRecord = {
      id: ref.id,
      version: ref.version,
      ref,
      descriptor,
      tools: [...tools],
      retrievable,
      loadedAt: DateTime.now(),
      root,
      workspace,
      get retired() {
        return retired
      },
      tryEnter() {
        if (retired) return false
        active++
        return true
      },
      exit() {
        active--
        if (active === 0 && retired) disposeRoot()
      },
      retire() {
        retired = true
        if (active === 0) disposeRoot()
      },
      activeCalls() {
        return active
      },
      forceDispose() {
        disposeRoot()
      },
      waitForDisposal() {
        return disposal ?? Promise.resolve()
      },
    }
    return record
  }

  const project = (ctx: DispatchContext | TurnContext, record: LiveRecord): void => {
    for (const tool of record.tools) ctx.tools.register(tool, true)
    if (record.retrievable) ctx.turnRetrievables.add(record.retrievable)
  }
  const registryNames = (ctx: DispatchContext): readonly string[] =>
    ctx.tools.all().map((tool) => tool.name)
  const registryOwners = (ctx: DispatchContext): ReadonlyMap<string, string | undefined> =>
    new Map(
      ctx.tools.all().map((tool) => [tool.name, tool.meta.get('skill') as string | undefined])
    )

  /**
   * The PREPARE half of prepare-then-swap. It resolves the descriptor, validates and reserves
   * names, materialises the workspace, spools the body and rewraps tools — everything that can
   * fail or await — and returns a ready-to-install {@link LiveRecord} WITHOUT touching the live
   * `records` map or the context registry. Its only externally visible mutation is the name
   * reservation, which it rolls back itself on any failure (restoring `priorReservations`) before
   * rethrowing.
   *
   * This purity is the failure-safety contract for both {@link load} and refresh: because nothing
   * live is swapped until `prepareLocked` has already succeeded, a throw here leaves the previously
   * loaded version — its record, its registered tools, its projected body — entirely intact. The
   * caller performs the swap synchronously (no awaits between prepare succeeding and the records/
   * registry/reservations exchange), so there is no window in which a half-prepared skill is
   * observable. Do NOT move any live mutation into this function, and do NOT add an `await` into
   * the caller's swap block — either change would reintroduce the incoherent-on-failure state this
   * design exists to prevent. Covered by the "preserves old state on failure" case in
   * `tests/unit/batteries/skills/concurrency.cross.spec.ts`.
   */
  const prepareLocked = async (
    id: string,
    ctx: DispatchContext,
    replacing?: LiveRecord
  ): Promise<{ record: LiveRecord; result: LoadResult }> => {
    if (disposed) throw new E_SKILL_NOT_LOADED([id])
    const entry = winner(id)
    if (!entry) throw new E_SKILL_NOT_FOUND([id])
    if (records.has(id) && !replacing) throw new E_SKILL_ALREADY_LOADED([id])
    const descriptor = await descriptorFor(entry.ref)
    const originals = descriptor.tools ?? []
    const isolatedDeclarations =
      config.isolation && descriptor.isolatedTools ? descriptor.isolatedTools : []
    const scriptDeclarations = config.scripts && descriptor.scripts ? descriptor.scripts : []
    const scriptNames = scriptDeclarations.map((script) => validateSkillScript(id, script))
    const names = [
      ...originals.map((tool) => tool.name),
      ...isolatedDeclarations.map((tool) => tool.name),
      ...scriptNames,
    ]
    assertSkillToolNames({
      candidates: names,
      reserved: new Set(
        [...reservations].filter(([, owner]) => owner !== id).map(([name]) => name)
      ),
      registryNames: registryNames(ctx),
      registryOwners: registryOwners(ctx),
      skillId: id,
      artifactKinds: [SpooledMarkdownArtifact, ...artifactRegistry.kinds.values()],
    })
    const priorReservations = new Map([...reservations].filter(([, owner]) => owner === id))
    for (const name of names) reservations.set(name, id)
    let workspace: SkillWorkspace | undefined
    let root: string | undefined
    try {
      const source = sourceFor(entry.ref)
      const body = await bodyText(await source.read(entry.ref))
      if (scriptDeclarations.length) {
        const scriptPaths = scriptDeclarations.map((script) => validateSkillSourcePath(script.path))
        if (!source.list)
          throw new E_SKILL_MANIFEST_INVALID([`${id}: source does not list script files`])
        const listed = await source.list(entry.ref)
        for (const path of scriptPaths) {
          if (!listed.map(validateSkillSourcePath).includes(path))
            throw new E_SKILL_MANIFEST_INVALID([`${id}: script file is not listed: ${path}`])
        }
        workspace = config.scripts!.workspace
        root = await workspace.materialize(
          entry.ref,
          (async function* () {
            for (const path of listed) {
              const normalized = validateSkillSourcePath(path)
              yield {
                path: normalized,
                bytes: await source.read(entry.ref, normalized),
              }
            }
          })()
        )
      }
      const channel = resolveSkillChannel(descriptor, config.defaultChannel)
      const retrievable = await spoolSkillBody(ctx, entry.ref, descriptor, body, channel)
      const recordPlaceholder = makeRecord(entry.ref, descriptor, [], retrievable, root, workspace)
      const tools = [
        ...originals.map((original) =>
          rewrapSkillTool({
            original,
            skill: { id, version: entry.ref.version, trustTier: descriptor.trustTier },
            record: recordPlaceholder,
            gate: config.unsafe?.ungatedSkillTools ? undefined : config.gate,
            resolveArtifact: () => artifactRegistry.resolve(id, original.name, descriptor),
            // Own-property only: bracket access would walk the prototype chain, so a tool named
            // after an inherited Object key ('toString', 'constructor', …) would pick up a
            // function as its "declared" output kind and reject every valid return as a mismatch.
            declaredOutput:
              descriptor.toolOutputs && Object.hasOwn(descriptor.toolOutputs, original.name)
                ? descriptor.toolOutputs[original.name]
                : undefined,
          })
        ),
        ...(scriptDeclarations.length
          ? scriptDeclarations.map((spec) =>
              forgeSkillScriptTool({
                skill: {
                  id,
                  version: entry.ref.version,
                  trustTier: descriptor.trustTier,
                },
                record: recordPlaceholder,
                spec,
                config: config.scripts!,
                sessionPolicy: config.unsafe?.scriptsPermissivePolicy ?? config.scripts!.policy,
                gate: config.unsafe?.ungatedSkillTools ? undefined : config.gate,
                materializedRoot: root!,
              })
            )
          : []),
        ...(config.isolation && isolatedDeclarations.length
          ? forgeIsolatedTools({
              declarations: isolatedDeclarations,
              isolation: config.isolation,
              gate: config.unsafe?.ungatedSkillTools ? undefined : config.gate,
              record: recordPlaceholder,
              skill: { id, version: entry.ref.version },
            })
          : []),
      ]
      recordPlaceholder.workspace = workspace
      recordPlaceholder.root = root
      recordPlaceholder.tools = tools
      return {
        record: recordPlaceholder,
        result: {
          id,
          channel,
          tools,
          retrievable,
        },
      }
    } catch (error) {
      for (const name of names) if (reservations.get(name) === id) reservations.delete(name)
      for (const [name, owner] of priorReservations) reservations.set(name, owner)
      if (root && workspace) await workspace.dispose(root)
      throw error
    }
  }

  const loadLocked = async (id: string, ctx: DispatchContext): Promise<LoadResult> => {
    const prepared = await prepareLocked(id, ctx)
    records.set(id, prepared.record)
    project(ctx, prepared.record)
    return prepared.result
  }

  const refresh = async (id?: string): Promise<RefreshResult> => withLock(async () => discover(id))
  const load = async (id: string, ctx: DispatchContext): Promise<LoadResult> =>
    withLock(() => loadLocked(id, ctx))
  const unload = async (id: string, ctx: DispatchContext): Promise<void> =>
    withLock(async () => {
      const record = records.get(id)
      if (!record) throw new E_SKILL_NOT_LOADED([id])
      record.retire()
      // Only unregister the entry if it is still OUR tool object; a later projection may have
      // replaced the name with a different owner's tool, which we must not clobber.
      for (const tool of record.tools)
        if (ctx.tools.get(tool.name) === tool) ctx.tools.unregister(tool.name)
      if (record.retrievable) {
        ctx.turnRetrievables.delete(record.retrievable)
        // ArtifactTool calls carry the selected artifact id in args.callId and are marked
        // fromArtifactTool. Requiring both fields avoids deleting ordinary tool results and
        // reads of a script's separately-spooled output artifact.
        for (const call of ctx.turnToolCalls) {
          if (
            call.fromArtifactTool &&
            call.createdAt.toMillis() >= record.loadedAt.toMillis() &&
            call.args.callId === record.retrievable.id
          ) {
            await ctx.deleteToolCall(call.id)
          }
        }
      }
      records.delete(id)
      for (const [name, owner] of reservations) if (owner === id) reservations.delete(name)
    })
  const projected = (_ctx: DispatchContext | TurnContext): readonly ProjectedSkill[] =>
    [...records.values()].map((record) => ({
      id: record.id,
      retrievable: record.retrievable,
      tools: record.tools,
    }))
  const managerCore: Omit<SkillManager, 'middleware'> = {
    unsafe,
    catalog: () =>
      candidates.map((c) => ({
        ref: c.ref,
        loaded: records.has(c.ref.id),
        ...(updateAvailable.has(c.ref.id) ? { updateAvailable: true } : {}),
        ...(c.shadowedBy ? { shadowedBy: c.shadowedBy } : {}),
      })),
    loaded: () => [...records.keys()],
    projected,
    refresh,
    refreshAndProject: async (ctx, id) =>
      withLock(async () => {
        const result = await discover(id)
        // An omitted `id` refreshes EVERY loaded skill — the tool contract for a bare
        // `refresh_skills` is "re-read and swap the loaded version", so guarding the swap behind
        // `if (id)` would re-discover the catalog yet leave every loaded body and tool stale while
        // still reporting a refresh. Snapshot the target ids before the loop so a swap that
        // re-keys `records` cannot perturb the iteration.
        const targetIds = id ? [id] : [...records.keys()]
        for (const targetId of targetIds) {
          const old = records.get(targetId)
          if (!old) continue
          // Prepare-then-swap, PER SKILL. `prepareLocked` does all the fallible/awaiting work and
          // mutates no live state; if it throws, `old` stays loaded, projected and reserved, and
          // the swap below never runs for it — a failed refresh of one skill is a no-op for that
          // skill, not a torn state. Everything below is the swap: synchronous, no awaits, so no
          // half-swapped skill is ever observable. Order matters — unregister the outgoing tools
          // by identity (guarding against a tool another owner replaced ours with), drop the old
          // retrievable and reservations, then install the prepared record — and `old.retire()`
          // runs LAST so its deferred workspace disposal targets the now-replaced materialisation.
          const prepared = await prepareLocked(targetId, ctx as DispatchContext, old)
          for (const tool of old.tools)
            if (ctx.tools.get(tool.name) === tool) ctx.tools.unregister(tool.name)
          if (old.retrievable) ctx.turnRetrievables.delete(old.retrievable)
          for (const [name, owner] of reservations)
            if (owner === targetId) reservations.delete(name)
          for (const tool of prepared.record.tools) reservations.set(tool.name, targetId)
          records.set(targetId, prepared.record)
          updateAvailable.delete(targetId)
          project(ctx, prepared.record)
          old.retire()
        }
        return result
      }),
    load,
    unload,
    dispose: async () =>
      withLock(async () => {
        disposed = true
        const current = [...records.values()]
        for (const record of current) record.retire()
        const ceilings = [
          config.scripts?.maxTimeoutSeconds,
          config.isolation?.maxTimeoutSeconds,
        ].filter((value): value is number => value !== undefined)
        const timeout = Math.max(0, ...(ceilings.length ? ceilings : [0])) * 1000
        const deadline = Date.now() + timeout
        while (current.some((record) => record.activeCalls() > 0) && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
        }
        for (const record of current) record.forceDispose()
        await Promise.all(current.map((record) => record.waitForDisposal()))
        records.clear()
        reservations.clear()
      }),
  }
  const manager = managerCore as SkillManager
  Object.defineProperties(manager, {
    middleware: {
      value: createSkillMiddlewareSet(manager, {
        autoRefresh: config.autoRefresh,
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    },
  })
  return manager
}
