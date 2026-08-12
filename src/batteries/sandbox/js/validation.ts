import { E_INVALID_SANDBOX_CONFIG } from '../exceptions'
import { guestLimitFloors, guestLimitsDefaults, hostcallQuotasDefaults } from '../types'
import type { GuestLimits, HostcallQuotas } from '../types'

const resolve = <T extends object>(
  partial: Partial<T> | undefined,
  defaults: T,
  floors: T,
  label: string
): T => {
  const out = { ...defaults, ...(partial ?? {}) } as T
  for (const key of Object.keys(defaults)) {
    const value = (out as Record<string, number>)[key]
    const floor = (floors as Record<string, number>)[key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < floor
    )
      throw new E_INVALID_SANDBOX_CONFIG([
        `${label}.${key}=${String(value)} must be a finite integer >= ${floor}`,
      ])
  }
  return out
}
/** Resolve and validate all seven guest limits exactly once. */
export const resolveGuestLimits = (value?: Partial<GuestLimits>): GuestLimits =>
  resolve(value, guestLimitsDefaults, guestLimitFloors, 'limits')
/** Resolve and validate all three hostcall quotas exactly once. */
export const resolveHostcallQuotas = (value?: Partial<HostcallQuotas>): HostcallQuotas =>
  resolve(
    value,
    hostcallQuotasDefaults,
    { hostcallTimeoutMs: 1, maxHostcallsPerEvaluation: 1, maxConcurrentHostcalls: 1 },
    'hostcallQuotas'
  )
