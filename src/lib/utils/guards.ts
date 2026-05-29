import { passesSchema } from './validation'
import { validator } from '@nhtio/validation'

/**
 * Returns `true` if `value` is an instance of the class identified by `type` (and optionally `ctor`).
 *
 * @remarks
 * Performs three checks in order: `instanceof ctor`, `Symbol.hasInstance`, then constructor-name
 * comparison. The constructor-name fallback handles cross-realm cases where `instanceof` fails.
 *
 * @typeParam T - The expected instance type.
 * @param value - The value to test.
 * @param type - The constructor name to compare against when `instanceof` is unavailable.
 * @param ctor - Optional constructor to use for `instanceof` and `Symbol.hasInstance` checks.
 * @returns `true` when `value` is an instance of the class described by `type`/`ctor`.
 */
export const isInstanceOf = <T>(
  value: unknown,
  type: string,
  ctor?: new (...args: any[]) => T
): value is T => {
  // eslint-disable-next-line adk/use-is-instance-of -- this IS the implementation of isInstanceOf
  if ('undefined' !== typeof ctor && value instanceof ctor) return true
  /* istanbul ignore next 4 */
  if (
    'undefined' !== typeof ctor &&
    typeof ctor[Symbol.hasInstance] === 'function' &&
    ctor[Symbol.hasInstance](value)
  )
    /* istanbul ignore next */
    return true
  // eslint-disable-next-line adk/prefer-is-object -- this guard is the building block isObject depends on (no circular usage)
  if ('object' === typeof value && null !== value) {
    const valueWithConstructor = value as { constructor?: Function }
    const constructorName = valueWithConstructor.constructor?.name
    return constructorName === type
  }
  return false
}

const errorSchema = validator
  .any()
  .custom((value, helpers) => {
    if (isInstanceOf(value, 'Error', Error)) {
      return value
    }
    return helpers.error('any.invalid')
  })
  .required()

/**
 * Returns `true` if `value` is an `Error` instance or satisfies the `Error` duck-type shape.
 *
 * @remarks
 * Returns `false` for `undefined` and `null` — the `Error` contract requires an actual instance.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the `Error` shape.
 */
export const isError = (value: unknown): value is Error => {
  return passesSchema(errorSchema, value)
}

/**
 * Type guard to check if a value is a plain object (not null, not array)
 * @param value - The value to check
 * @returns True if the value is a plain object, false otherwise
 */
export const isObject = (value: unknown): value is { [key: string]: unknown } => {
  // eslint-disable-next-line adk/prefer-is-object -- this IS the implementation of isObject
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
