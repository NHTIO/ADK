import { createCompartmentRuntime } from './compartment'
import type { GuestLimits } from '../types'
import type { GuestRuntimeLike } from './ses_contracts'

/** In-process runtime factory for environments where SES is available. */
export const createGuestRuntime = async (
  globals: Record<string, (...args: unknown[]) => unknown>,
  limits: GuestLimits,
  modules: Record<string, unknown> = {}
): Promise<GuestRuntimeLike> => ({
  async spawn() {
    return createCompartmentRuntime(globals, limits, modules)
  },
})
