import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError, isObject } from '../utils/guards'
import {
  E_TURN_GATE_ABORTED,
  E_TURN_GATE_TIMEOUT,
  E_INVALID_TURN_GATE_RESOLUTION,
  E_INVALID_INITIAL_TURN_GATE_VALUE,
} from '../exceptions/runtime'
import type { Schema } from '@nhtio/validation'

/**
 * Plain input object supplied to {@link TurnGate} at construction time.
 *
 * @remarks
 * `turnId` and `abortSignal` are injected by the runner — callers constructing a gate via
 * `ctx.waitFor()` never supply them directly.
 *
 * `abortSignal` is `AbortSignal` (not `AbortController`) because the gate reacts to turn-level
 * cancellation but cannot trigger it. The gate owns its own internal `AbortController` for
 * `gate.abort()`.
 */
export interface RawTurnGate {
  /** Stable unique identifier for this gate. */
  id: string
  /** The ID of the turn that opened this gate. */
  turnId: string
  /** Human-readable label describing why this gate was opened (e.g. `'tool_approval'`). */
  reason: string
  /** Arbitrary data supplied to the gate opener; passed through to `turnGateOpen` listeners. */
  payload: unknown
  /** Optional validator schema for the resolution value. When present, `resolve()` validates before settling. */
  schema?: Schema
  /** Optional timeout in milliseconds. When elapsed the gate self-rejects with {@link @nhtio/adk!E_TURN_GATE_TIMEOUT}. */
  timeout?: number
  /** The turn's abort signal. When fired the gate self-rejects with {@link @nhtio/adk!E_TURN_GATE_ABORTED}. */
  abortSignal?: AbortSignal
  /** When this gate was created. */
  createdAt: string | number | Date | DateTime
}

/**
 * Fully-resolved {@link RawTurnGate} after schema validation.
 *
 * @internal
 */
interface ResolvedTurnGate {
  id: string
  turnId: string
  reason: string
  payload: unknown
  schema?: Schema
  timeout?: number
  abortSignal?: AbortSignal
  createdAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawTurnGate} before constructing a {@link TurnGate}.
 *
 * @remarks
 * - `schema` and `abortSignal` are validated as opaque passthrough values.
 * - `timeout` must be a positive integer when provided.
 */
const rawTurnGateSchema = validator.object<RawTurnGate>({
  id: validator.string().required(),
  turnId: validator.string().required(),
  reason: validator.string().required(),
  payload: validator.any().required(),
  schema: validator
    .any()
    .custom((value, helpers) => {
      if (value === undefined || value === null) return undefined
      if (typeof (value as any).validate === 'function') return value
      return helpers.error('any.invalid')
    })
    .optional(),
  timeout: validator.number().integer().min(1).optional(),
  abortSignal: validator
    .any()
    .custom((value, helpers) => {
      if (value === undefined || value === null) return undefined
      // eslint-disable-next-line adk/use-is-instance-of -- native built-in; AbortSignal cross-realm is handled by the duck-type fallback below
      if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value
      if (
        isObject(value) &&
        typeof (value as any).aborted === 'boolean' &&
        typeof (value as any).addEventListener === 'function'
      ) {
        return value
      }
      return helpers.error('any.invalid')
    })
    .optional(),
  createdAt: validator.datetime().required(),
})

/**
 * A cooperative suspension gate that blocks a turn's middleware pipeline until resolved, rejected,
 * aborted, or timed out.
 *
 * @typeParam T - The expected type of the resolution value.
 *
 * @remarks
 * Created exclusively via `ctx.waitFor()` — middleware never constructs a gate directly.
 * The gate emits `turnGateOpen` on the runner's observability bus at creation time and
 * `turnGateClosed` when it settles.
 *
 * Resolution is validated against an optional schema before the internal promise is settled.
 * A validation failure throws {@link @nhtio/adk!E_INVALID_TURN_GATE_RESOLUTION} **synchronously in the
 * caller's context** — the promise is NOT settled and the gate remains open.
 */
export class TurnGate<T = unknown> {
  /**
   * Validator schema that accepts a {@link RawTurnGate} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a gate entry.
   */
  public static schema = rawTurnGateSchema

  /**
   * Returns `true` if `value` is a {@link TurnGate} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link TurnGate} instance.
   */
  public static isTurnGate(value: unknown): value is TurnGate {
    return isInstanceOf(value, 'TurnGate', TurnGate)
  }

  declare readonly id: string
  declare readonly turnId: string
  declare readonly reason: string
  declare readonly payload: unknown
  declare readonly createdAt: DateTime
  declare readonly isSettled: boolean

  #id: string
  #turnId: string
  #reason: string
  #payload: unknown
  #createdAt: DateTime
  #settled: boolean
  #schema: Schema | undefined
  #controller: AbortController
  #resolve!: (value: T) => void
  #reject!: (reason: unknown) => void
  #promise: Promise<T>

  /**
   * @param raw - The raw gate input validated against `rawTurnGateSchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_TURN_GATE_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawTurnGate) {
    let resolved: ResolvedTurnGate
    try {
      resolved = validateOrThrow<ResolvedTurnGate>(rawTurnGateSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_TURN_GATE_VALUE({ cause: isError(err) ? err : undefined })
    }

    this.#id = resolved.id
    this.#turnId = resolved.turnId
    this.#reason = resolved.reason
    this.#payload = resolved.payload
    this.#createdAt = resolved.createdAt
    this.#settled = false
    this.#schema = resolved.schema
    this.#controller = new AbortController()

    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })

    // Wire the internal abort controller
    const onAbort = () => {
      if (!this.#settled) {
        this.#settled = true
        this.#reject(new E_TURN_GATE_ABORTED())
      }
    }

    this.#controller.signal.addEventListener('abort', onAbort, { once: true })

    // Wire the external turn abort signal
    if (resolved.abortSignal) {
      if (resolved.abortSignal.aborted) {
        // Already aborted — reject immediately after construction
        queueMicrotask(() => onAbort())
      } else {
        resolved.abortSignal.addEventListener('abort', onAbort, { once: true })
        // Clean up the external listener once the gate settles via another path
        this.#promise.then(
          () => resolved.abortSignal!.removeEventListener('abort', onAbort),
          () => resolved.abortSignal!.removeEventListener('abort', onAbort)
        )
      }
    }

    // Wire the timeout
    if (resolved.timeout !== undefined) {
      const timer = setTimeout(() => {
        if (!this.#settled) {
          this.#settled = true
          this.#reject(new E_TURN_GATE_TIMEOUT())
        }
      }, resolved.timeout)

      this.#promise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer)
      )
    }

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      turnId: {
        get: () => this.#turnId,
        enumerable: true,
        configurable: false,
      },
      reason: {
        get: () => this.#reason,
        enumerable: true,
        configurable: false,
      },
      payload: {
        get: () => this.#payload,
        enumerable: true,
        configurable: false,
      },
      createdAt: {
        get: () => this.#createdAt,
        enumerable: true,
        configurable: false,
      },
      isSettled: {
        get: () => this.#settled,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Resolves the gate with `value`, unblocking the awaiting middleware.
   *
   * @remarks
   * If a schema was provided at construction, `value` is validated synchronously before the
   * promise is settled. A validation failure throws {@link @nhtio/adk!E_INVALID_TURN_GATE_RESOLUTION}
   * in the caller's context — the promise is NOT settled and the gate remains open.
   *
   * No-ops if the gate is already settled.
   *
   * @param value - The resolution value. Must satisfy the gate's schema when one was provided.
   * @throws {@link @nhtio/adk!E_INVALID_TURN_GATE_RESOLUTION} when `value` fails schema validation.
   */
  resolve(value: unknown): void {
    if (this.#settled) return
    if (this.#schema !== undefined) {
      try {
        value = validateOrThrow(this.#schema, value, true)
      } catch (err) {
        throw new E_INVALID_TURN_GATE_RESOLUTION({
          cause: isError(err) ? err : undefined,
        })
      }
    }
    this.#settled = true
    this.#resolve(value as T)
  }

  /**
   * Rejects the gate with `error`, unblocking the awaiting middleware with a rejection.
   *
   * @remarks
   * No-ops if the gate is already settled.
   *
   * @param error - The rejection reason.
   */
  reject(error: Error): void {
    if (this.#settled) return
    this.#settled = true
    this.#reject(error)
  }

  /**
   * Aborts the gate by firing the internal `AbortController`, which rejects the promise with
   * {@link @nhtio/adk!E_TURN_GATE_ABORTED}.
   *
   * @remarks
   * No-ops if the gate is already settled. Distinct from the turn-level abort signal — this
   * allows callers to cancel a specific gate without aborting the whole turn.
   */
  abort(): void {
    if (this.#settled) return
    this.#controller.abort()
  }

  /**
   * Returns the internal promise. Called by `ctx.waitFor()` to block the middleware pipeline.
   *
   * @internal
   */
  _promise(): Promise<T> {
    return this.#promise
  }
}
