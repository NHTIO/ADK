/**
 * Exceptions raised by the ordering validation battery.
 *
 * @module @nhtio/adk/batteries/validation/exceptions
 */

import { createException } from '@nhtio/adk/factories'
import type { BaseException } from '@nhtio/adk/types'
import type { BlockingOrderingViolation } from './types'

/** Thrown when ordering guard options do not satisfy the battery contract. */
export const E_INVALID_ORDERING_GUARD_OPTIONS = createException<[string]>(
  'E_INVALID_ORDERING_GUARD_OPTIONS',
  'Invalid ordering guard options: %s',
  'E_INVALID_ORDERING_GUARD_OPTIONS',
  422,
  true
)

/** Thrown when a string profile name is absent from the registered profile catalog. */
export const E_UNKNOWN_ORDERING_PROFILE = createException<[string]>(
  'E_UNKNOWN_ORDERING_PROFILE',
  'Unknown ordering profile "%s"; call orderingProfiles() to list registered profiles.',
  'E_UNKNOWN_ORDERING_PROFILE',
  422,
  true
)

/** A blocking ordering exception enriched with the complete violation list. */
export interface OrderingViolationException extends BaseException {
  /** Blocking violations that caused the dispatch rejection. */
  violations: BlockingOrderingViolation[]
}

/** A repair failure, retaining enough progress to reconcile a partially-mutated store. */
export interface OrderingRepairException extends BaseException {
  /** The original ids in the collision group being repaired. */
  groupIds: string[]
  /** Group members deleted before a degraded replacement failed. */
  deletedIds: string[]
  /** The persistence or context error that caused the repair to fail. */
  cause?: unknown
}

/** Thrown internally when materialising an ordering repair cannot complete. */
export const E_ORDERING_REPAIR_FAILED = createException<[string]>(
  'E_ORDERING_REPAIR_FAILED',
  'Ordering repair failed: %s',
  'E_ORDERING_REPAIR_FAILED',
  422,
  false
)

/** Constructs a structured repair failure without losing the underlying store error. */
export const createOrderingRepairError = (
  message: string,
  cause: unknown,
  groupIds: string[],
  deletedIds: string[]
): OrderingRepairException => {
  const error = new E_ORDERING_REPAIR_FAILED([message]) as OrderingRepairException
  error.cause = cause
  error.groupIds = [...groupIds]
  error.deletedIds = [...deletedIds]
  return error
}

/**
 * Thrown when a dispatch contains blocking ordering violations.
 *
 * @remarks
 * This factory remains compatible with the repository's printf-style exception convention. Use
 * {@link createOrderingViolationError} when the structured violation list is available.
 */
export const E_ORDERING_VIOLATION = createException<[number, string]>(
  'E_ORDERING_VIOLATION',
  'Ordering guard rejected dispatch: %d violation(s) found (first: %s)',
  'E_ORDERING_VIOLATION',
  422,
  false
)

/**
 * Constructs an ordering rejection and attaches its typed blocking violation list.
 *
 * @param count - Number of blocking violations.
 * @param firstDetail - Human-readable detail for the first violation.
 * @param violations - Complete list of violations that may feed the rejection path.
 * @returns The enriched exception instance.
 */
export const createOrderingViolationError = (
  count: number,
  firstDetail: string,
  violations: BlockingOrderingViolation[]
): OrderingViolationException => {
  const error = new E_ORDERING_VIOLATION([count, firstDetail]) as OrderingViolationException
  error.violations = violations
  return error
}
