import { Tool } from '@nhtio/adk/forge'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { runToolGate } from '@nhtio/adk/batteries/tools/_shared'
import { E_INVALID_SKILLS_CONFIG, E_SKILL_NOT_LOADED } from './exceptions'
import {
  E_SANDBOX_FAILED,
  E_SES_EVALUATION_TIMEOUT,
  createGuestRunner,
  resolveGuestLimits,
} from '@nhtio/adk/batteries/sandbox'
import type { SkillRecord } from './manager'
import type { SkillScriptParam } from './contracts'
import type { GuestRuntimeLike } from '../sandbox/js/ses_contracts'
import type { SkillIsolatedTool, SkillIsolationConfig } from './types'

const parameterShape = (params: readonly SkillScriptParam[] | undefined) => {
  const shape: Record<string, ReturnType<typeof validator.any>> = {}
  for (const param of params ?? []) {
    const schema =
      param.type === 'number'
        ? validator.number()
        : param.type === 'boolean'
          ? validator.boolean()
          : param.type === 'enum'
            ? validator.string().valid(...(param.values ?? []))
            : validator.string()
    shape[param.name] = param.required ? schema.required() : schema.optional()
  }
  return shape
}

/** Forge the isolated (tier-2) tools belonging to one loaded skill. */
export const forgeIsolatedTools = (o: {
  declarations: readonly SkillIsolatedTool[]
  isolation: SkillIsolationConfig
  gate: ((ctx: unknown, call: { tool: string; args: unknown }) => void | Promise<void>) | undefined
  record: SkillRecord
  skill: { readonly id: string; readonly version: string }
}): Tool[] => {
  const { declarations, isolation, gate, record, skill } = o
  const limits = resolveGuestLimits(isolation.limits)
  return declarations.map((declaration) => {
    const inputSchema = validator
      .object({
        ...parameterShape(declaration.params),
        timeout_seconds: validator
          .number()
          .min(1)
          .max(isolation.maxTimeoutSeconds)
          .default(isolation.defaultTimeoutSeconds),
      })
      .unknown(false)
      .required()
    return new Tool({
      name: declaration.name,
      description: declaration.description,
      inputSchema,
      trusted: false,
      meta: { skill: skill.id, skillVersion: skill.version },
      handler: async (raw, ctx) => {
        if (!record.tryEnter()) throw new E_SKILL_NOT_LOADED([skill.id])
        const value = raw as Record<string, unknown> & { timeout_seconds: number }
        const { timeout_seconds: timeoutSeconds, ...validatedArgs } = value
        try {
          await runToolGate(gate, ctx, declaration.name, value)
          if (ctx.abortSignal.aborted)
            throw new DOMException('The operation was aborted', 'AbortError')
          const runtime: GuestRuntimeLike = isolation.resolveGuest
            ? await isolation.resolveGuest({
                globals: isolation.globals ?? {},
                modules: isolation.modules ?? {},
                limits,
                signal: ctx.abortSignal,
              })
            : await createGuestRunner(isolation.globals ?? {}, limits, isolation.modules ?? {})
          const guest = await runtime.spawn({
            modules: Object.keys(isolation.modules ?? {}),
            globals: Object.keys(isolation.globals ?? {}).map((name) => ({
              name,
              kind: 'async-fn' as const,
            })),
            limits,
            signal: ctx.abortSignal,
          })
          try {
            return JSON.stringify(
              await guest.evaluate(`(${declaration.source})(${JSON.stringify(validatedArgs)})`, {
                timeoutMs: timeoutSeconds * 1000,
              })
            )
          } catch (error) {
            if (isInstanceOf(error, 'E_SES_EVALUATION_TIMEOUT', E_SES_EVALUATION_TIMEOUT)) {
              await guest.kill()
              throw new E_SANDBOX_FAILED([
                `Evaluation timed out after ${timeoutSeconds} seconds (kind: timed-out).`,
              ])
            }
            throw error
          } finally {
            // kill is idempotent for the stock compartment and releases conforming guests.
            await guest.kill()
          }
        } finally {
          record.exit()
        }
      },
    })
  })
}

/** Validate the structural safety choice before any skill descriptor is loaded. */
export const validateIsolationConfig = (config: {
  isolation?: SkillIsolationConfig
  unsafe?: { isolatedToolsInProcess?: true }
}): void => {
  if (
    config.isolation &&
    !config.isolation.resolveGuest &&
    !config.unsafe?.isolatedToolsInProcess
  ) {
    throw new E_INVALID_SKILLS_CONFIG([
      'isolation.resolveGuest is required unless unsafe.isolatedToolsInProcess is enabled',
    ])
  }
  if (config.isolation && !config.isolation.resolveGuest && config.unsafe?.isolatedToolsInProcess) {
    console.warn('Skill isolated tools are running in-process; cancellation is best-effort.')
  }
}
