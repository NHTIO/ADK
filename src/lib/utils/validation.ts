import { BaseException } from '../classes/base_exception'
import { validator, ValidationError } from '@nhtio/validation'
import type { Schema } from '@nhtio/validation'

/**
 * Returns `true` if `value` satisfies `schema` without throwing.
 *
 * @remarks
 * Aborts on the first validation error. Use {@link validateOrThrow} or
 * {@link asyncValidateOrThrow} when you need the full set of field errors.
 *
 * @param schema - The schema to validate against.
 * @param value - The value to test.
 * @returns `true` when `value` passes the schema; `false` otherwise.
 */
export const passesSchema = (schema: Schema, value: unknown): boolean => {
  const { error } = schema.validate(value, { abortEarly: true })
  return !error
}

/**
 * Returns `true` if `value` is a `ValidationError` or satisfies its minimum duck-type shape.
 *
 * @remarks
 * The duck-typing path handles `ValidationError` objects that cross module or realm boundaries
 * where `instanceof` would return `false`.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the `ValidationError` shape.
 */
export const isValidationError = (value: unknown): value is ValidationError => {
  const schema = validator.alternatives(
    validator.object().instance(ValidationError as any),
    validator.function().instance(ValidationError as any),
    validator
      .object({
        message: validator.string().required(),
        details: validator
          .array()
          .items(
            validator.object({
              message: validator.string().required(),
              path: validator
                .array()
                .items(validator.alternatives(validator.string(), validator.number()))
                .required(),
              type: validator.string().required(),
              context: validator.object().unknown(true).required(),
            })
          )
          .required(),
      })
      .unknown(true)
  )
  return passesSchema(schema, value)
}

const messageFromValidationError = (reason: ValidationError | undefined, fallback: string) => {
  return reason ? reason.details.map((d) => d.message).join(' and ') : fallback
}

/**
 * Thrown when input fails schema validation.
 *
 * @remarks
 * Carries the full `details` array from the underlying `ValidationError` so callers can surface
 * field-level messages without unwrapping the `cause` manually.
 */
export class ValidationException extends BaseException {
  static status = 422
  static code = 'VALIDATION_EXCEPTION'
  static fatal = false

  /** The raw field-level error details from the underlying `ValidationError`. */
  declare readonly details?: ValidationError['details']

  /**
   * @param reason - The `ValidationError` thrown by the schema; its `details` are surfaced
   *   directly on this exception and its messages are joined to form the human-readable message.
   */
  constructor(reason: ValidationError) {
    const message = messageFromValidationError(reason, 'Validation failed')
    super(message, {
      code: ValidationException.code,
      status: ValidationException.status,
      fatal: ValidationException.fatal,
      cause: reason,
    })
    Object.defineProperty(this, 'details', {
      value: reason.details,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
}

/**
 * Validates `value` against `schema` synchronously and returns the coerced result typed as `T`.
 *
 * @remarks
 * Collects all field errors before throwing. Use {@link asyncValidateOrThrow} for schemas that
 * include async custom validators.
 *
 * @typeParam T - The expected type of `value` after successful validation.
 * @param schema - The schema to validate against.
 * @param value - The value to validate.
 * @param convert - When `true`, the validator coerces values to their target types (e.g. string
 *   `"1"` → number `1`). Defaults to `false` to prevent silent type coercion.
 * @returns The validated (and optionally coerced) value typed as `T`.
 * @throws {@link ValidationException} when `value` does not satisfy `schema`.
 */
export const validateOrThrow = <T>(schema: Schema, value: unknown, convert: boolean = false): T => {
  const { value: returnable, error } = schema.validate(value, { abortEarly: false, convert })
  if (error) {
    throw new ValidationException(error)
  }
  return returnable as T
}

/**
 * Validates `value` against `schema` asynchronously and returns the coerced result typed as `T`.
 *
 * @remarks
 * Collects all field errors before throwing. Prefer this over {@link validateOrThrow} when the
 * schema includes async custom validators.
 *
 * @typeParam T - The expected type of the validated and coerced return value.
 * @param schema - The schema to validate against.
 * @param value - The value to validate.
 * @param convert - When `true`, the validator coerces values to their target types (e.g. string
 *   `"1"` → number `1`). Defaults to `false` to prevent silent type coercion.
 * @returns The validated (and optionally coerced) value typed as `T`.
 * @throws {@link ValidationException} when `value` does not satisfy `schema`.
 */
export const asyncValidateOrThrow = async <T>(
  schema: Schema,
  value: unknown,
  convert: boolean = false
): Promise<T> => {
  try {
    return await schema.validateAsync(value, { abortEarly: false, convert })
  } catch (error) {
    if (isValidationError(error)) {
      throw new ValidationException(error)
    }
    throw error
  }
}
