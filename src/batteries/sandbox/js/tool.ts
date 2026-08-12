import { Tool } from '@nhtio/adk/forge'
import { createGuestRunner } from './runner'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { runToolGate } from '../../tools/_shared'
import { E_SES_EVALUATION_TIMEOUT } from './exceptions'
import { resolveGuestLimits, resolveHostcallQuotas } from './validation'
import { E_SANDBOX_FAILED, E_SANDBOX_GATE_REQUIRED } from '../exceptions'
import type { EvaluateJavascriptConfig } from './ses_contracts'

/** Assemble the SES JavaScript evaluation tool. */
export const createEvaluateJavascriptTool = (config: EvaluateJavascriptConfig): Tool => {
  if (!config.gate) throw new E_SANDBOX_GATE_REQUIRED(['evaluate_javascript requires a gate'])
  const limits = resolveGuestLimits(config.limits)
  resolveHostcallQuotas(config.hostcallQuotas)
  const inputSchema = validator.object({
    source: validator.string().required(),
    timeout_seconds: validator.number().min(1).default(30),
  })
  return new Tool({
    name: 'evaluate_javascript',
    description:
      'Evaluate JavaScript in a hardened SES guest. No ambient fetch, process, require, Date.now, or Math.random. Injected capabilities are asynchronous.',
    inputSchema,
    trusted: false,
    handler: async (raw, ctx) => {
      const args = raw as { source: string; timeout_seconds: number }
      await runToolGate(config.gate, ctx, 'evaluate_javascript', args)
      const runtime =
        config.runtime ??
        (await createGuestRunner(config.globals ?? {}, limits, config.modules ?? {}))
      const guest = await runtime.spawn({
        modules: Object.keys(config.modules ?? {}),
        globals: Object.keys(config.globals ?? {}).map((name) => ({
          name,
          kind: 'async-fn' as const,
        })),
        limits,
        signal: ctx.abortSignal,
      })
      try {
        return JSON.stringify(
          await guest.evaluate(args.source, { timeoutMs: args.timeout_seconds * 1000 })
        )
      } catch (error) {
        if (isInstanceOf(error, 'E_SES_EVALUATION_TIMEOUT', E_SES_EVALUATION_TIMEOUT)) {
          await guest.kill()
          throw new E_SANDBOX_FAILED([
            `Evaluation timed out after ${args.timeout_seconds} seconds (kind: timed-out).`,
          ])
        }
        throw error
      }
    },
  })
}
