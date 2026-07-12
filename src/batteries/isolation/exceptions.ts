/**
 * Battery-scoped exception constructors for the isolation battery.
 *
 * @remarks
 * Minted via `createException` from `@nhtio/adk/factories`, matching every other bundled battery's
 * convention (see e.g. the transformers.js STT adapter's `exceptions.ts`).
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when `serveIsolated()` cannot duck-detect a supported guest environment — neither
 * `globalThis.self.postMessage` (Web Worker) nor `globalThis.process?.send` (node child_process) is
 * present. Fatal: there is no meaningful guest to serve.
 */
export const E_ISOLATION_UNSUPPORTED_ENV = createException<[string]>(
  'E_ISOLATION_UNSUPPORTED_ENV',
  'Cannot serve an isolated service: %s',
  'E_ISOLATION_UNSUPPORTED_ENV',
  500,
  true
)

/**
 * Thrown when the codec must escalate a value past the `'raw'` tier (an exotic leaf: function, Error,
 * or registered custom-encodable) but the optional `@nhtio/encoder` peer is not installed. Printf arg:
 * the offending argument path. Non-fatal: a caller can catch this and pass the value through their own
 * BYO codec instead.
 */
export const E_ISOLATION_ENCODER_REQUIRED = createException<[string]>(
  'E_ISOLATION_ENCODER_REQUIRED',
  "Cannot encode isolation payload at %s: install the optional peer '@nhtio/encoder' (or supply a BYO codec) to cross function/Error/custom-encodable values",
  'E_ISOLATION_ENCODER_REQUIRED',
  528,
  false
)

/**
 * Thrown when a value cannot be encoded even with the encoder peer available — most commonly a
 * circular reference that ALSO contains an exotic leaf (a plain circular raw value is fine; see
 * `codec.ts`), or the encoder itself rejects the value. Wraps the encoder's own
 * `E_CIRCULAR_REFERENCE`/`E_UNENCODABLE_VALUE` as `cause`.
 */
export const E_ISOLATION_UNENCODABLE = createException<[string]>(
  'E_ISOLATION_UNENCODABLE',
  'Cannot encode isolation payload at %s: value is unencodable',
  'E_ISOLATION_UNENCODABLE',
  500,
  false
)

/**
 * Thrown by `IsolatedService` calls made while the guest has not yet signaled `ready` and the
 * configured `readyTimeoutMs` has elapsed. Printf arg: the elapsed timeout in milliseconds.
 */
export const E_ISOLATION_READY_TIMEOUT = createException<[number]>(
  'E_ISOLATION_READY_TIMEOUT',
  'Isolated service did not become ready within %dms',
  'E_ISOLATION_READY_TIMEOUT',
  504,
  false
)

/**
 * Thrown to reject every in-flight call and error every open stream when an `IsolatedService` is
 * disposed or recycled — the guest connection those calls/streams were bound to no longer exists.
 */
export const E_ISOLATED_TERMINATED = createException<[string]>(
  'E_ISOLATED_TERMINATED',
  'Isolated service %s was terminated',
  'E_ISOLATED_TERMINATED',
  499,
  false
)

/**
 * Thrown by `IsolatedService` calls made (or in flight) after the guest crashed and
 * `autoRespawn`/manual `recycle()` has not yet brought it back. Printf arg: the service name.
 */
export const E_ISOLATED_CRASHED = createException<[string]>(
  'E_ISOLATED_CRASHED',
  'Isolated service %s has crashed',
  'E_ISOLATED_CRASHED',
  503,
  false
)

/**
 * Thrown when an isolation battery options bag (spec input, host options, codec options, crash-policy
 * options) fails eager validation — e.g. an unknown top-level key, or a duplicate name across a spec's
 * `methods`/`streams`/`events`. Fatal: config bugs fail loud, not at first use.
 */
export const E_INVALID_ISOLATION_OPTIONS = createException<[string]>(
  'E_INVALID_ISOLATION_OPTIONS',
  'Invalid isolation battery options: %s',
  'E_INVALID_ISOLATION_OPTIONS',
  529,
  true
)
