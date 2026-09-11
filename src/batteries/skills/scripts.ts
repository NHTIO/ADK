/** Gated, argv-only execution of skill-provided scripts under a per-call policy. */
import { v6 as uuidv6 } from 'uuid'
import { validator } from '@nhtio/validation'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { E_TURN_GATE_ABORTED } from '@nhtio/adk/exceptions'
import { Tool, Retrievable, SpooledArtifact } from '@nhtio/adk/common'
import { runToolGate, type ToolGateFn } from '@nhtio/adk/batteries/tools/_shared'
import {
  classifySandboxPathRejection,
  createExistingSymlinkGuard,
  normalizeSandboxPath,
} from '../sandbox/paths'
import {
  E_SKILL_MANIFEST_INVALID,
  E_SKILL_NOT_LOADED,
  E_SKILL_SCRIPT_DENIED,
  E_SKILL_SCRIPT_FAILED,
  E_SKILL_SCRIPT_GATE_UNAVAILABLE,
  E_SKILL_SCRIPT_POLICY_WIDENED,
  E_SKILL_SCRIPT_TIMEOUT,
  E_SKILL_SOURCE_PATH_REJECTED,
  E_SKILL_WORKSPACE_FAILED,
} from './exceptions'
import type { SkillRecord } from './manager'
import type { SandboxPolicy } from '../sandbox/types'
import type { DispatchContext } from '@nhtio/adk/types'
import type { SkillScriptConfig, SkillWorkspace } from './types'
import type { SkillScriptParam, SkillScriptSpec } from './contracts'

const generatedName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const encoder = new TextEncoder()
const truncation = '\n[output truncated]'

/** Validate a value before putting it in argv. Values are never shell-interpolated. */
export const assertArgvValue = (value: unknown, name: string): string => {
  const text = String(value)
  if (text.startsWith('-') || text.includes('\0'))
    throw new E_SKILL_MANIFEST_INVALID([`${name}: unsafe argv value`])
  return text
}

const slashPath = (value: string): string => {
  if (value.startsWith('/') || value.startsWith('\\'))
    throw new E_SKILL_SOURCE_PATH_REJECTED([value])
  const reason = classifySandboxPathRejection(value)
  if (reason !== undefined) throw new E_SKILL_SOURCE_PATH_REJECTED([`${value} (${reason})`])
  try {
    const normal = normalizeSandboxPath(value)
    if (!normal || normal === '.' || normal.startsWith('../') || normal.includes('/../'))
      throw new Error('outside skill subtree')
    return normal
  } catch {
    throw new E_SKILL_SOURCE_PATH_REJECTED([value])
  }
}

/** Validate and normalise a source-owned filename. Leading separators are rejected first. */
export const validateSkillSourcePath = (value: string): string => slashPath(value)

const descendant = (child: string, parent: string): boolean => {
  const c = child.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const p = parent.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  return p === '/' ? c.startsWith('/') : c === p || c.startsWith(`${p}/`)
}
const concrete = (value: string): boolean => !/[!*?{}[\]]/.test(value)
const list = (value: readonly string[] | undefined): readonly string[] => value ?? []
const authorised = (path: string, rules: readonly string[]): boolean =>
  rules.some((rule) =>
    concrete(rule) ? descendant(path, rule) : descendant(path, rule.replace(/[!*?{}[\]]/g, ''))
  )
const covered = (deny: string, by: string): boolean =>
  concrete(deny) && concrete(by) && descendant(deny, by)

/**
 * Check the battery's path-aware policy subset relation. This is intentionally conservative:
 * globs supplied by a per-call policy are undecidable and fail closed.
 */
export const assertPolicySubset = (perCall: SandboxPolicy, session: SandboxPolicy): void => {
  if (perCall.filesystem.disabled || session.filesystem.disabled)
    throw new E_SKILL_SCRIPT_POLICY_WIDENED(['filesystem.disabled'])
  if (perCall.network.disabled || session.network.disabled)
    throw new E_SKILL_SCRIPT_POLICY_WIDENED(['network.disabled'])
  for (const path of list(perCall.filesystem.allowRead)) {
    if (!concrete(path) || !authorised(path, list(session.filesystem.allowRead)))
      throw new E_SKILL_SCRIPT_POLICY_WIDENED([`filesystem.allowRead:${path}`])
  }
  for (const deny of list(session.filesystem.denyRead)) {
    if (!list(perCall.filesystem.denyRead).some((candidate) => covered(deny, candidate)))
      throw new E_SKILL_SCRIPT_POLICY_WIDENED([`filesystem.denyRead:${deny}`])
  }
  for (const path of list(perCall.filesystem.allowWrite)) {
    if (!concrete(path) || !authorised(path, list(session.filesystem.allowWrite)))
      throw new E_SKILL_SCRIPT_POLICY_WIDENED([`filesystem.allowWrite:${path}`])
    if (list(perCall.filesystem.denyWrite).some((deny) => descendant(path, deny))) continue
    if (list(session.filesystem.denyWrite).some((deny) => descendant(path, deny)))
      throw new E_SKILL_SCRIPT_POLICY_WIDENED([`filesystem.allowWrite:${path}`])
  }
  for (const domain of list(perCall.network.allowedDomains)) {
    // A per-call `*` is the WIDEST possible request, so it must clear the same membership test as
    // any named domain: it is authorised only when the session itself permits `*`. Special-casing
    // `domain !== '*'` here would let the one value that widens the most bypass the check entirely.
    if (
      !list(session.network.allowedDomains).includes(domain) &&
      !list(session.network.allowedDomains).includes('*')
    )
      throw new E_SKILL_SCRIPT_POLICY_WIDENED([`network:${domain}`])
  }
}

const validateParam = (param: SkillScriptParam): void => {
  if (!param.name || !param.description)
    throw new E_SKILL_MANIFEST_INVALID([`parameter ${param.name}`])
  if (!param.required && !param.flag)
    throw new E_SKILL_MANIFEST_INVALID([`optional positional ${param.name}`])
  if (param.type === 'enum' && (!param.values || param.values.length === 0))
    throw new E_SKILL_MANIFEST_INVALID([`enum ${param.name}`])
}

/** Validate a declaration, including the provider-safe generated tool name. */
export const validateSkillScript = (skillId: string, spec: SkillScriptSpec): string => {
  const name = `run_${skillId}_${spec.name}`
  if (!generatedName.test(name)) throw new E_SKILL_MANIFEST_INVALID([`${skillId}/${spec.name}`])
  for (const param of spec.params ?? []) validateParam(param)
  return name
}

const schemaFor = (spec: SkillScriptSpec, config: SkillScriptConfig) => {
  const shape: Record<string, unknown> = {}
  for (const param of spec.params ?? []) {
    let schema =
      param.type === 'number'
        ? validator.number()
        : param.type === 'boolean'
          ? validator.boolean()
          : validator.string()
    if (param.type === 'enum') schema = schema.valid(...(param.values ?? []))
    shape[param.name] = (param.required ? schema.required() : schema.optional()).description(
      param.description
    )
  }
  shape.timeout_seconds = validator
    .number()
    .min(1)
    .max(config.maxTimeoutSeconds)
    .default(config.defaultTimeoutSeconds)
  return validator.object(shape as Record<string, ReturnType<typeof validator.string>>)
}

const gateScript = async (
  gate: ToolGateFn,
  ctx: DispatchContext,
  name: string,
  args: unknown
): Promise<void> => {
  try {
    await runToolGate(gate, ctx, name, args)
  } catch (error) {
    if (isInstanceOf(error, 'E_TURN_GATE_ABORTED', E_TURN_GATE_ABORTED)) {
      if (ctx.abortSignal.aborted) throw error
      throw new E_SKILL_SCRIPT_GATE_UNAVAILABLE([name])
    }
    const outcome =
      isError(error) || typeof error === 'object'
        ? (error as { outcome?: { kind?: string }; kind?: string })
        : {}
    if (outcome.outcome?.kind === 'gate-declined' || outcome.kind === 'gate-declined')
      throw new E_SKILL_SCRIPT_DENIED([name])
    throw new E_SKILL_SCRIPT_GATE_UNAVAILABLE([name])
  }
}

const argvFor = (
  spec: SkillScriptSpec,
  raw: Record<string, unknown>,
  interpreter: readonly string[]
): string[] => {
  const argv = [...interpreter]
  argv.push(spec.path)
  for (const param of spec.params ?? []) {
    const value = raw[param.name]
    if (value === undefined) continue
    const flag = param.flag && assertArgvValue(param.flag, `${param.name}.flag`)
    if (param.type === 'boolean' && flag) {
      if (value) argv.push(flag)
      continue
    }
    if (flag) argv.push(flag)
    argv.push(assertArgvValue(value, param.name))
  }
  return argv
}

const drain = async (
  stream: ReadableStream<Uint8Array>,
  state: { bytes: number; chunks: Uint8Array[]; truncated: boolean },
  cap: number
): Promise<void> => {
  const reader = stream.getReader()
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return
      if (state.bytes < cap) {
        const take = item.value.slice(0, Math.max(0, cap - state.bytes))
        if (take.length) state.chunks.push(take)
        state.bytes += take.length
        if (take.length < item.value.length) state.truncated = true
      } else state.truncated = true
    }
  } finally {
    reader.releaseLock()
  }
}

/** Forge one fixed-schema script tool. The record liveness check is synchronous and precedes all awaits. */
export const forgeSkillScriptTool = (o: {
  skill: {
    readonly id: string
    readonly version: string
    readonly trustTier?: 'first-party' | 'third-party-public' | 'third-party-private'
  }
  record: SkillRecord
  spec: SkillScriptSpec
  config: SkillScriptConfig
  sessionPolicy: SandboxPolicy
  gate?: ToolGateFn
  materializedRoot: string
}): Tool => {
  const name = validateSkillScript(o.skill.id, o.spec)
  const policyFor = (): SandboxPolicy => ({
    filesystem: {
      denyRead: ['/'],
      allowRead: [o.materializedRoot, ...o.config.interpreterReadPaths],
      allowWrite: [`${o.materializedRoot}/tmp`],
    },
    network: {},
  })
  const outputTier =
    o.skill.trustTier === 'first-party'
      ? 'third-party-private'
      : (o.skill.trustTier ?? 'third-party-public')
  return new Tool({
    name,
    description: o.spec.description,
    inputSchema: schemaFor(o.spec, o.config),
    trusted: false,
    meta: { skill: o.skill.id, skillVersion: o.skill.version },
    handler: async (raw, ctx) => {
      if (!o.record.tryEnter()) throw new E_SKILL_NOT_LOADED([o.skill.id])
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const args = raw as Record<string, unknown>
        if (o.gate) await gateScript(o.gate, ctx, name, args)
        const policy = policyFor()
        assertPolicySubset(policy, o.sessionPolicy)
        const guard = createExistingSymlinkGuard(o.materializedRoot, o.config.workspace.fileSystem)
        const relative = validateSkillSourcePath(o.spec.path)
        await guard(relative)
        const controller = new AbortController()
        const requested = Number(args.timeout_seconds)
        const timeout = Math.min(requested, o.config.maxTimeoutSeconds)
        timer = setTimeout(() => controller.abort(), timeout * 1000)
        // The child must die on EITHER our timeout OR the enclosing turn/dispatch
        // aborting. Passing controller.signal alone left an aborted turn's script
        // running until its own timeout. AbortSignal.any forwards both.
        const runSignal = AbortSignal.any([controller.signal, ctx.abortSignal])
        const correlationId = uuidv6()
        const execution = await o.config.handle.run({
          argv: argvFor(
            { ...o.spec, path: relative },
            args,
            o.config.interpreters[o.spec.interpreter] ?? []
          ),
          policy,
          correlationId,
          cwd: o.materializedRoot,
          env: {},
          signal: runSignal,
        })
        const state = { bytes: 0, chunks: [] as Uint8Array[], truncated: false }
        let completed: { exitCode: number; failed: boolean }
        try {
          await Promise.all([
            drain(execution.stdout, state, o.config.maxOutputBytes),
            drain(execution.stderr, state, o.config.maxOutputBytes),
          ])
          completed = await execution.completed
        } finally {
          clearTimeout(timer)
          timer = undefined
        }
        if (controller.signal.aborted && !ctx.abortSignal.aborted)
          throw new E_SKILL_SCRIPT_TIMEOUT([name])
        const bytes = state.chunks.slice()
        if (state.truncated) bytes.push(encoder.encode(truncation))
        const body = bytes.reduce((all, value) => {
          const next = new Uint8Array(all.length + value.length)
          next.set(all)
          next.set(value, all.length)
          return next
        }, new Uint8Array())
        const id = uuidv6()
        const reader = await ctx.storeRetrievableBytes(
          id,
          new ReadableStream({
            start(c) {
              c.enqueue(body)
              c.close()
            },
          })
        )
        ctx.turnRetrievables.add(
          new Retrievable({
            id,
            content: new SpooledArtifact(reader),
            trustTier: outputTier,
            source: `${o.skill.id}:${o.spec.name}`,
            kind: 'skill-script',
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        )
        // Default (failOnNonzeroExit !== false): a nonzero exit is a host-detectable failure, so
        // a broken or rejected script is not presented to the model as a successful run. Output is
        // already spooled; the error carries the retrievable id so it stays inspectable. Set
        // failOnNonzeroExit: false to receive the acknowledgement string for any completed run.
        const acknowledgement = `Script ${name} exited ${completed.exitCode}; captured ${state.bytes} bytes; truncated=${state.truncated}; retrievable=${id}`
        if (o.config.failOnNonzeroExit !== false && (completed.failed || completed.exitCode !== 0))
          throw new E_SKILL_SCRIPT_FAILED([name, acknowledgement])
        return acknowledgement
      } catch (error) {
        if (isInstanceOf(error, 'E_SKILL_SCRIPT_TIMEOUT', E_SKILL_SCRIPT_TIMEOUT)) throw error
        // An enclosing turn/dispatch abort reaches here as the run/completed promise's rejection,
        // whose name is not E_SKILL_*. Propagate it as the abort it is rather than mislabelling
        // cancellation as a workspace failure (matches gateScript's own abort handling above).
        if (
          isInstanceOf(error, 'E_TURN_GATE_ABORTED', E_TURN_GATE_ABORTED) ||
          ctx.abortSignal.aborted
        )
          throw error
        if (isError(error) && error.name.startsWith('E_SKILL_')) throw error
        throw new E_SKILL_WORKSPACE_FAILED([isError(error) ? error.message : String(error)])
      } finally {
        if (timer) clearTimeout(timer)
        o.record.exit()
      }
    },
  })
}

/** Materialise a source file list after validating every source-owned path. */
export const validateMaterializedPaths = (paths: readonly string[]): readonly string[] =>
  paths.map(validateSkillSourcePath)

/** Keep the workspace type visible to consumers implementing the materialisation seam. */
export type { SkillWorkspace }
