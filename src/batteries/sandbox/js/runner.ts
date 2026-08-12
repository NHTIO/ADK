import { createGuestRuntime } from './service'
import { resolveGuestLimits } from './validation'
import type { GuestOutcome } from '../types'
import type { GuestGlobal, GuestRuntimeLike } from './ses_contracts'

/** Host runner that retains capability implementations and exposes only enumerated names. */
export const createGuestRunner = async (
  globals: Record<string, GuestGlobal>,
  limits = resolveGuestLimits(),
  modules: Record<string, unknown> = {}
): Promise<GuestRuntimeLike> => {
  return {
    async spawn(): Promise<Awaited<ReturnType<GuestRuntimeLike['spawn']>>> {
      const implementations: Record<string, (...args: unknown[]) => unknown> = {}
      for (const [name, declaration] of Object.entries(globals))
        implementations[name] = (...args: unknown[]) =>
          declaration.fn(args, new AbortController().signal)
      const runtime = await createGuestRuntime(implementations, limits, modules)
      return runtime.spawn({ modules: Object.keys(modules), globals: [], limits })
    },
  }
}
/** Type-only terminal outcome helper. */
export const isGuestOutcome = (value: unknown): value is GuestOutcome =>
  Boolean(value && typeof value === 'object' && 'durationMs' in value)
