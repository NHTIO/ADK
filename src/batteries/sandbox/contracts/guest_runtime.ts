import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
import type { GuestLimits, GuestHandle } from '../types'

/** Runtime boundary for a hardened guest realm; limits and capability declarations cross the boundary. */
export interface GuestRuntime {
  /** Spawn a guest with fully resolved hostile-realm limits and async capability stubs. */
  spawn(o: {
    modules: string[]
    globals: ReadonlyArray<{ name: string; kind: 'async-fn' }>
    limits: GuestLimits
    signal?: AbortSignal
  }): Promise<GuestHandle>
}

/** Duck-type schema. */
export const guestRuntimeSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (value !== null && value !== undefined && typeof (value as any).spawn === 'function')
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsGuestRuntime = (value: unknown): value is GuestRuntime =>
  passesSchema(guestRuntimeSchema, value)
