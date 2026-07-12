/**
 * Runtime validation schemas and wrappers for the isolation battery's option bags and spec shape.
 *
 * @remarks
 * Follows the repo's eager-validation convention (see the transformers.js STT adapter's
 * `validation.ts`): `@nhtio/validation` schemas with `.unknown(false)` so typos in an options bag fail
 * loud at construction time, never silently at first use. This module also installs the public,
 * validating {@link defineIsolatedService} — re-exported from this battery's `index.ts` barrel — on top
 * of `types.ts`'s pure {@link resolveIsolatedServiceSpec} primitive.
 */

import { isError } from '@nhtio/adk/guards'
import { E_INVALID_ISOLATION_OPTIONS } from './exceptions'
import { validator, ValidationError } from '@nhtio/validation'
import {
  resolveIsolatedServiceSpec,
  type EventMap,
  type IsolatedServiceSpec,
  type IsolatedServiceSpecInput,
  type MethodMap,
  type StreamMap,
} from './types'

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/** Validator schema for the `{ name, methods?, streams?, events? }` shape `defineIsolatedService` takes. */
export const isolatedServiceSpecInputSchema = validator
  .object<{ name: string; methods?: object; streams?: object; events?: object }>({
    name: validator.string().min(1).required(),
    methods: validator.object().unknown(true).optional(),
    streams: validator.object().unknown(true).optional(),
    events: validator.object().unknown(true).optional(),
  })
  .unknown(false)

/**
 * Validate a spec input against {@link isolatedServiceSpecInputSchema} AND the cross-map name-collision
 * rule (a name may not appear in more than one of `methods`/`streams`/`events` — methods and streams
 * both become properties of the same {@link @nhtio/adk/batteries/isolation!IsolatedFacade} object, so a
 * collision there would silently shadow one implementation with the other).
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} on any failure.
 */
export const validateIsolatedServiceSpecInput = <
  M extends MethodMap,
  S extends StreamMap,
  E extends EventMap,
>(
  input: IsolatedServiceSpecInput<M, S, E>
): IsolatedServiceSpecInput<M, S, E> => {
  const { value, error } = isolatedServiceSpecInputSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_ISOLATION_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  const methodNames = Object.keys(input.methods ?? {})
  const streamNames = Object.keys(input.streams ?? {})
  const eventNames = Object.keys(input.events ?? {})
  const seen = new Map<string, 'methods' | 'streams' | 'events'>()
  for (const [names, bucket] of [
    [methodNames, 'methods'],
    [streamNames, 'streams'],
    [eventNames, 'events'],
  ] as const) {
    for (const name of names) {
      const existing = seen.get(name)
      if (existing) {
        throw new E_INVALID_ISOLATION_OPTIONS([
          `name "${name}" is declared in both "${existing}" and "${bucket}" — every method/stream/event name must be unique across the whole spec`,
        ])
      }
      seen.set(name, bucket)
    }
  }
  return value as IsolatedServiceSpecInput<M, S, E>
}

/**
 * Define an isolated service's spec — validates `input` eagerly (see
 * {@link validateIsolatedServiceSpecInput}) then resolves it via
 * {@link @nhtio/adk/batteries/isolation!resolveIsolatedServiceSpec}. This is the public entry point
 * re-exported as `defineIsolatedService` from this battery's `index.ts` barrel.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when the spec fails
 *   validation (missing/empty `name`, unknown top-level key, or a name collision across
 *   `methods`/`streams`/`events`).
 */
export const defineIsolatedServiceValidated = <
  M extends MethodMap = Record<never, never>,
  S extends StreamMap = Record<never, never>,
  E extends EventMap = Record<never, never>,
>(
  input: IsolatedServiceSpecInput<M, S, E>
): IsolatedServiceSpec<M, S, E> =>
  resolveIsolatedServiceSpec(validateIsolatedServiceSpecInput(input))

/** Shape of the `encodables` option shared by host + serve options (sugar for encoder `registerClass`). */
const encodablesSchema = validator.array().items(validator.function()).optional()

/** Shape of the {@link @nhtio/adk/batteries/isolation!IsolationObservabilityHooks} block, spread into
 *  both host + serve option schemas. */
const observabilityHooksShape = {
  onIsolation: validator.function().optional(),
  onSpawn: validator.function().optional(),
  onDispose: validator.function().optional(),
  onRecycle: validator.function().optional(),
  onCrashReport: validator.function().optional(),
  onRespawnAuto: validator.function().optional(),
  onCall: validator.function().optional(),
  onStream: validator.function().optional(),
  onAbort: validator.function().optional(),
  onWire: validator.function().optional(),
  onCodecEscalate: validator.function().optional(),
  debugPayloads: validator.boolean().optional(),
}

/** Shape of the `autoRespawn` option shared by every `createIsolatedService`-flavored options bag
 *  (`isolatedServiceOptionsSchema` and, via WP2, `spawnIsolatedOptionsSchema`). Hoisted rather than
 *  re-declared so both schemas stay in lockstep. */
const autoRespawnSchema = validator
  .object({
    policy: validator
      .custom((v, h) =>
        v && typeof (v as { record?: unknown }).record === 'function' ? v : h.error('any.invalid')
      )
      .required(),
  })
  .unknown(false)
  .optional()

/** Validator schema for `createIsolatedService`'s options bag. */
export const isolatedServiceOptionsSchema = validator
  .object<{
    readyTimeoutMs?: number
    disposeGraceMs?: number
    autoRespawn?: object
    encodables?: unknown[]
  }>({
    readyTimeoutMs: validator.number().positive().optional(),
    disposeGraceMs: validator.number().positive().optional(),
    autoRespawn: autoRespawnSchema,
    encodables: encodablesSchema,
    ...observabilityHooksShape,
  })
  .unknown(false)

/**
 * Validate `createIsolatedService`'s options bag.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} on failure.
 */
export const validateIsolatedServiceOptions = <T extends object>(input: T | undefined): T => {
  if (input === undefined) return {} as T
  const { value, error } = isolatedServiceOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_ISOLATION_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as T
}

/** Validator schema for `serveIsolated`/`serveIsolatedOverPort`'s options bag. */
export const serveIsolatedOptionsSchema = validator
  .object<{ encodables?: unknown[] }>({
    encodables: encodablesSchema,
    ...observabilityHooksShape,
  })
  .unknown(false)

/**
 * Validate `serveIsolated`/`serveIsolatedOverPort`'s options bag.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} on failure.
 */
export const validateServeIsolatedOptions = <T extends object>(input: T | undefined): T => {
  if (input === undefined) return {} as T
  const { value, error } = serveIsolatedOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_ISOLATION_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as T
}

// ── WP2 (browser): `spawnIsolated`/`createWorkerTransport` options ─────────────────────────────────────

/** A value is `URL`-like when it structurally exposes a string `href` (real `URL` instances, and
 *  anything sufficiently duck-compatible) — this schema never imports the DOM `URL` type; see
 *  `browser.ts`'s module doc for why. */
const looksLikeUrl = (value: unknown): boolean =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { href?: unknown }).href === 'string'

/** Shape of `SpawnIsolatedOptions.worker` — a guest script `string | URL`, or a {@link
 *  @nhtio/adk/batteries/isolation!WorkerResolver} function. Validated via `custom()` (mirrors
 *  `isolatedServiceOptionsSchema`'s `autoRespawn.policy` duck-check pattern) rather than
 *  `alternatives()`, since a `URL` instance is not itself expressible as a plain validator schema. */
const workerSpecSchema = validator
  .custom((v, h) =>
    typeof v === 'string' || typeof v === 'function' || looksLikeUrl(v) ? v : h.error('any.invalid')
  )
  .required()

/** Shape of the optional `workerOptions` dictionary forwarded to `new Worker(url, workerOptions)`. */
const workerOptionsSchema = validator
  .object<{ type?: string; credentials?: string; name?: string }>({
    type: validator.string().valid('classic', 'module').optional(),
    credentials: validator.string().valid('omit', 'same-origin', 'include').optional(),
    name: validator.string().optional(),
  })
  .unknown(false)
  .optional()

/** Validator schema for `spawnIsolated`/`createWorkerTransport`'s options bag — every field {@link
 *  isolatedServiceOptionsSchema} accepts, plus `worker`/`workerOptions`.
 *
 * @remarks
 * Deliberately NOT built via `isolatedServiceOptionsSchema.keys({...})`: `@nhtio/validation`'s `.keys()`
 * is typed to return `this` (the ORIGINAL object schema's type parameter), so TypeScript rejects a
 * `worker`/`workerOptions` key that isn't already part of that type param, even though the runtime
 * behavior of `.keys()` is correct (verified separately — it does properly extend both the allowed-key
 * set and required-ness at runtime). Declaring a sibling schema that repeats the shared fields (via the
 * hoisted `autoRespawnSchema`/`encodablesSchema`/`observabilityHooksShape` fragments, so nothing is
 * duplicated by VALUE) keeps both the runtime schema and its static type in sync without a `.keys()`
 * type-level workaround. */
export const spawnIsolatedOptionsSchema = validator
  .object<{
    readyTimeoutMs?: number
    disposeGraceMs?: number
    autoRespawn?: object
    encodables?: unknown[]
    worker: string
    workerOptions?: object
  }>({
    readyTimeoutMs: validator.number().positive().optional(),
    disposeGraceMs: validator.number().positive().optional(),
    autoRespawn: autoRespawnSchema,
    encodables: encodablesSchema,
    ...observabilityHooksShape,
    worker: workerSpecSchema,
    workerOptions: workerOptionsSchema,
  })
  .unknown(false)

/**
 * Validate `spawnIsolated`/`createWorkerTransport`'s options bag.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} on failure (missing
 *   `worker`, a `worker` that is neither a string/URL/function, or an unknown top-level key).
 */
export const validateSpawnIsolatedOptions = <T extends object>(input: T): T => {
  const { value, error } = spawnIsolatedOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_ISOLATION_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as T
}
