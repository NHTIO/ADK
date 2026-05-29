import { passesSchema } from './validation'
import { validator } from '@nhtio/validation'
import { printf as format } from 'fast-printf'
import { BaseException } from '../classes/base_exception'

/**
 * Options accepted by {@link @nhtio/adk!BaseException} (and factory-created exceptions) beyond the
 * standard `ErrorOptions`.
 *
 * @remarks
 * These mirror the static defaults on {@link @nhtio/adk!BaseException} but allow per-throw overrides so a
 * single exception class can carry different metadata at different throw sites.
 */
export type ExceptionOptions = ErrorOptions & {
  code?: string
  status?: number
  fatal?: boolean
}

/**
 * Constructor signature of an exception class produced by {@link createException}.
 *
 * @typeParam T - Tuple of printf-style format argument types. When `T` is an empty tuple the
 *   constructor takes no positional message arguments; when non-empty the first argument must be
 *   an array of values matching `T`.
 */
export type CreatedException<T extends any[] = []> = typeof BaseException &
  (T extends []
    ? {
        new (options?: ExceptionOptions): BaseException
      }
    : { new (args: T, options?: ExceptionOptions): BaseException })

/**
 * Factory that produces a named {@link @nhtio/adk!BaseException} subclass with a fixed printf-style message
 * template, error code, HTTP status, and fatality flag.
 *
 * @remarks
 * Prefer this over hand-writing subclasses for simple, static exception definitions.
 *
 * @typeParam T - Tuple of printf format argument types. Pass a non-empty tuple to require
 *   callers to supply interpolation values at the throw site.
 *
 * @param name - The `name` property set on thrown instances (used by {@link isNamedException}).
 * @param message - Printf-style template string for the error message.
 * @param code - Machine-readable error code stored on the static and instance `code` property.
 * @param status - HTTP status code associated with this exception class.
 * @param fatal - When `true`, signals that the error is unrecoverable.
 * @returns A constructor for a {@link @nhtio/adk!BaseException} subclass with the given metadata baked in.
 *
 * @example
 * ```ts
 * export const E_NOT_FOUND = createException<[string]>(
 *   'E_NOT_FOUND', 'Resource %s not found', 'E_NOT_FOUND', 404, false
 * )
 * throw new E_NOT_FOUND(['my-id'])
 * ```
 */
export const createException = <T extends any[] = []>(
  name: string,
  message: string,
  code: string,
  status?: number,
  fatal?: boolean
): CreatedException<T> => {
  const Ctor = class extends BaseException {
    static message = message
    static code = code
    static status = status
    static fatal = fatal
    constructor(args?: T | ExceptionOptions, options?: ExceptionOptions) {
      const hasMessageArgs = Array.isArray(args)
      const messageArgs = hasMessageArgs ? args : []
      const errorOptions = hasMessageArgs ? options : args

      super(format(message, ...messageArgs), errorOptions)
      this.name = name
    }
  }
  // Without this, the factory returns an anonymous class — constructor.name is "" and
  // cross-realm `isInstanceOf(err, 'E_FOO')` (which falls back to constructor-name comparison)
  // never matches. Setting the name on the class itself makes the identity carry through.
  Object.defineProperty(Ctor, 'name', { value: name, configurable: true })
  return Ctor as unknown as CreatedException<T>
}

/**
 * Returns `true` if `value` is a {@link @nhtio/adk!BaseException} or satisfies its minimum duck-type shape.
 *
 * @remarks
 * The duck-typing path handles exceptions that cross module or realm boundaries where
 * `instanceof` would return `false` for structurally identical objects.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the {@link @nhtio/adk!BaseException} shape.
 */
export const isException = (value: unknown): value is BaseException => {
  const schema = validator.alternatives(
    validator.object().instance(BaseException as any),
    validator.function().instance(BaseException as any),
    validator
      .object({
        name: validator.string().required(),
        message: validator.string().required(),
        help: validator.string().optional(),
        code: validator.string().optional(),
        status: validator.number().optional(),
        fatal: validator.boolean().optional(),
      })
      .unknown(true)
  )
  return passesSchema(schema, value)
}

/**
 * Narrows `value` to a {@link @nhtio/adk!BaseException} whose `name` property matches `name` exactly.
 *
 * @remarks
 * Useful for catching a specific factory-created exception by its string identifier when
 * `instanceof` checks are not available (e.g. across module boundaries).
 *
 * @param value - The value to test.
 * @param name - The exact string to compare against `value.name`.
 * @returns `true` when `value` is a {@link @nhtio/adk!BaseException} with the given `name`.
 */
export const isNamedException = (value: unknown, name: string): value is BaseException => {
  return isException(value) && value.name === name
}
