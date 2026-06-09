/**
 * Base class for all structured exceptions in the ADK.
 *
 * @remarks
 * Subclasses should declare static `code`, `status`, `fatal`, and optionally `help` to avoid
 * repeating those values on every instance. Instance-level options always take precedence over
 * static defaults, so a single exception class can still be thrown with per-site overrides when
 * needed.
 *
 * The runtime cross-realm guard is inlined here rather than imported from `../utils/guards`
 * to break a circular-import chain: `guards` depends on `validation`, which extends
 * `BaseException`. Importing the shared `isInstanceOf` helper into this file would create a
 * load-order cycle that leaves `BaseException` undefined when `ValidationException extends
 * BaseException` evaluates.
 */
export class BaseException extends Error {
  /**
   * Returns `true` if `value` is a {@link BaseException} instance.
   *
   * @remarks
   * Performs cross-realm-safe detection: tries `instanceof`, then `Symbol.hasInstance`, then
   * constructor-name comparison. The ADK does not export the `BaseException` class itself
   * as a constructable value — use this guard plus the {@link BaseException} type for runtime
   * detection and TypeScript narrowing.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link BaseException} instance.
   */
  public static isBaseException(value: unknown): value is BaseException {
    // eslint-disable-next-line adk/use-is-instance-of -- module cycle (guards ↔ validation ↔ BaseException); the cross-realm fallback is inlined below
    if (value instanceof BaseException) return true
    if (
      typeof BaseException[Symbol.hasInstance] === 'function' &&
      BaseException[Symbol.hasInstance](value)
    )
      return true
    // eslint-disable-next-line adk/prefer-is-object -- module cycle (guards ↔ validation ↔ BaseException); isObject would create a load-order cycle
    if (typeof value === 'object' && value !== null) {
      const ctorName = (value as { constructor?: { name?: string } }).constructor?.name
      if (ctorName === 'BaseException') return true
    }
    return false
  }
  /**
   * Default help text inherited by all instances unless overridden at the throw site.
   */
  declare static help?: string
  /**
   * Default machine-readable error code inherited by all instances.
   */
  declare static code?: string
  /**
   * Default HTTP status code inherited by all instances.
   */
  declare static status?: number
  /**
   * Whether exceptions of this class are fatal by default.
   */
  declare static fatal?: boolean
  /**
   * Default message used when no message is supplied to the constructor.
   */
  declare static message?: string

  /**
   * Name of the class that raised the exception.
   */
  name: string

  /**
   * Human-readable guidance for resolving or reporting this error.
   */
  declare help?: string

  /**
   * Machine-readable error code for narrowing exception-handling logic.
   */
  declare code?: string

  /**
   * HTTP status code associated with this error.
   */
  declare status?: number

  /**
   * When `true`, the ADK treats this error as unrecoverable and should halt the agent loop.
   */
  declare fatal?: boolean

  /**
   * @param message - Human-readable error message. Falls back to the static `message` on the
   *   subclass if omitted.
   * @param options - Standard `ErrorOptions` extended with `code`, `status`, and `fatal`
   *   overrides. Static defaults on the subclass are used when these are absent.
   */
  constructor(
    message?: string,
    options?: ErrorOptions & { code?: string; status?: number; fatal?: boolean }
  ) {
    super(message, options)

    const ErrorConstructor = this.constructor as typeof BaseException

    this.name = ErrorConstructor.name
    this.message = message || ErrorConstructor.message || ''

    const code = options?.code || ErrorConstructor.code
    if (code !== undefined) {
      this.code = code
    }

    const status = options?.status || ErrorConstructor.status
    if (status !== undefined) {
      this.status = status
    }

    const fatal = options?.fatal ?? ErrorConstructor.fatal
    if (fatal !== undefined) {
      this.fatal = fatal
    }

    const help = ErrorConstructor.help
    if (help !== undefined) {
      this.help = help
    }

    Error.captureStackTrace(this, ErrorConstructor)
  }

  /** Tag used by `Object.prototype.toString` — reports the concrete exception class name. */
  get [Symbol.toStringTag]() {
    return this.constructor.name
  }

  toString() {
    if (this.code) {
      return `${this.name} [${this.code}]: ${this.message}`
    }
    return `${this.name}: ${this.message}`
  }
}
