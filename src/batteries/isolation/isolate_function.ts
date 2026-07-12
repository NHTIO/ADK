/**
 * `isolateFunction` — the Blob-URL escape hatch: run a single plain function inside a throwaway,
 * source-rehydrated Worker, without the caller ever writing a guest script file.
 *
 * @remarks
 * **This is a `new Function`-based eval trust surface. Read this before using it.**
 *
 * Every other seam in this battery (`spawnIsolated`/`serveIsolated`/WP3's node backend) runs a guest
 * script the CALLER wrote, deployed, and controls the provenance of. `isolateFunction` is the opposite:
 * it takes an in-memory function VALUE, serializes it via `fn.toString()` (through
 * `@nhtio/encoder/function_serializer`'s `FunctionSerializer.dehydrate`), embeds that source text
 * verbatim into a synthesized classic-Worker script, and has the Worker rehydrate it with `new
 * Function(...)` at guest-side startup — there is no way to run source-rehydration without `new
 * Function` (or `eval`), and this module does not attempt to pretend otherwise. That is why the single
 * call site that opts into this is a literal, non-optional `{ allowSourceRehydration: true }` — both a
 * TypeScript literal-type requirement (passing `false` or a widened `boolean` fails to compile) AND a
 * runtime check (so a caller that reaches this through untyped JS, or an `as any` cast, still cannot
 * skip the acknowledgement). Treat any function handed to `isolateFunction` exactly as you would treat a
 * string handed to `eval`: only ever pass functions whose source your own process produced/controls.
 * `fn.toString()` captures no closures — only named, module-scope-free source is portable across the
 * Blob boundary (see {@link https://github.com/nhtio/nhtio-encoder | @nhtio/encoder}'s
 * `FunctionSerializer` for exactly which shapes round-trip).
 *
 * Design, deliberately MINI rather than the full `protocol.ts` envelope:
 *
 * - Host → guest: `{ id: string; args: WireValue[] }`. Each argument is encoded via `codec.ts`'s
 *   {@link encodeArgument} in `'auto'` mode (so plain JSON-safe arguments cost nothing — they cross as
 *   `enc: 'raw'` and the guest's inline unwrap is a no-op property read). If an argument contains an
 *   exotic leaf (a function/Error/custom-encodable) `encodeArgument` would need to escalate past `raw`
 *   — but the guest Blob has no module imports, so it cannot load `@nhtio/encoder` to decode an `enc:
 *   'nhtio'` value. Rather than ship a doomed message, {@link isolateFunction}'s `invoke` rejects such
 *   calls up front with {@link E_ISOLATE_FUNCTION_ARG_UNSUPPORTED}.
 * - Guest → host: `{ id: string; ok: true; value: { enc: 'raw'; v: unknown } } | { id: string; ok:
 *   false; error: { message: string; name: string; stack?: string } }` — hand-rolled inline in the Blob
 *   source (no `codec.ts` import there either), but shaped compatibly with `protocol.ts`'s `WireValue`/
 *   `WireError` so the HOST side can decode results via the SAME {@link decodeArgument}/`fromWireError`
 *   helpers WP1 already defines, rather than a third, bespoke decode path.
 *
 * `dispose()` terminates the Worker and revokes the Blob URL; every in-flight `invoke()` call, and every
 * call made afterward, rejects with {@link @nhtio/adk/batteries/isolation!E_ISOLATED_TERMINATED}. An
 * uncaught top-level error in the guest (e.g. `FunctionSerializer`'s rehydrator itself throwing) surfaces
 * as a Worker `'error'` event, at which point every in-flight call rejects with
 * {@link @nhtio/adk/batteries/isolation!E_ISOLATED_CRASHED} and the instance is marked crashed permanently
 * (no auto-respawn — this is a one-shot escape hatch, not a managed service; construct a new
 * {@link isolateFunction} instance to try again).
 */

import { nextCorrelationId } from './protocol'
import { isError, isObject } from '@nhtio/adk/guards'
import { createException } from '@nhtio/adk/factories'
import { decodeArgument, encodeArgument, fromWireError } from './codec'
import {
  E_ISOLATED_CRASHED,
  E_ISOLATED_TERMINATED,
  E_ISOLATION_UNSUPPORTED_ENV,
} from './exceptions'
import type { WireValue } from './protocol'
import type { BrowserErrorEvent, BrowserMessageEvent, BrowserWorker } from './browser'

// ── Locally-declared ambient `Worker` (see `browser.ts`'s module doc for why this is per-file) ─────────

declare const Worker: {
  new (scriptURL: string | URL): BrowserWorker
}

// ── Local exceptions (this module cannot add to the read-only `exceptions.ts`) ──────────────────────────

/**
 * Thrown when {@link isolateFunction} is called without the literal `{ allowSourceRehydration: true }`
 * acknowledgement. Fatal: this is a configuration/call-site error, caught before anything is spawned.
 */
export const E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION = createException<[string]>(
  'E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION',
  'isolateFunction(%s) requires explicit opt-in: pass { allowSourceRehydration: true }. This runs your ' +
    "function's source through `new Function` inside a Worker — treat it like `eval`.",
  'E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION',
  529,
  true
)

/**
 * Thrown when the function passed to {@link isolateFunction} cannot be serialized —
 * `@nhtio/encoder/function_serializer`'s `FunctionSerializer.canSerialize` rejects native functions
 * (`fn.toString()` containing `[native code]`) and bound functions (which stringify the same way).
 * Fatal: detected before any Worker is spawned; there is no fallback representation to fall back to.
 */
export const E_ISOLATE_FUNCTION_UNSERIALIZABLE = createException<[string]>(
  'E_ISOLATE_FUNCTION_UNSERIALIZABLE',
  'isolateFunction(%s): the function cannot be serialized (native or bound functions have no ' +
    'inspectable source) — pass a plain user-defined function instead',
  'E_ISOLATE_FUNCTION_UNSERIALIZABLE',
  529,
  true
)

/**
 * Thrown when an `invoke()` argument contains an exotic leaf (a function/Error/custom-encodable) that
 * `codec.ts`'s tiered encoder would need to escalate past the `'raw'` tier. The isolated Blob guest has
 * no module imports (by design — no bare specifiers survive a Blob URL) and therefore cannot load
 * `@nhtio/encoder` to decode an `enc: 'nhtio'` value; `isolateFunction` only ever supports plain,
 * structured-cloneable arguments. Non-fatal: a caller can pass different, plain arguments instead.
 */
export const E_ISOLATE_FUNCTION_ARG_UNSUPPORTED = createException<[string]>(
  'E_ISOLATE_FUNCTION_ARG_UNSUPPORTED',
  'isolateFunction call argument at %s cannot cross into the isolated Blob worker: it contains a ' +
    'function/Error/custom-encodable value, and the Blob guest has no encoder available to decode it — ' +
    'pass only plain, structured-cloneable arguments',
  'E_ISOLATE_FUNCTION_ARG_UNSUPPORTED',
  528,
  false
)

// ── Public options / handle shapes ──────────────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link isolateFunction}.
 *
 * @remarks
 * `allowSourceRehydration` MUST be the literal `true` — both at the type level (a widened `boolean`
 * fails to type-check) and at runtime (checked explicitly, so an untyped/`as any` call site cannot skip
 * the acknowledgement). See this module's doc comment for what that acknowledgement means.
 */
export interface IsolateFunctionOptions {
  /** Explicit, non-optional acknowledgement that this function's source will be rehydrated via `new
   *  Function` inside a Worker — an eval-equivalent trust surface. Must be the literal `true`. */
  allowSourceRehydration: true
  /** A developer-facing name, used in thrown exception messages and the Worker's `name` option.
   *  Defaults to `fn.name` (or `'anonymous'` when the function itself has no name). */
  name?: string
}

/** The live handle returned by {@link isolateFunction}. */
export interface IsolatedFunctionHandle<A extends unknown[], R> {
  /**
   * Invoke the isolated function with `args`, returning its result (or rejecting with whatever it
   * threw/rejected with, reconstructed as a plain `Error`). Lazily spawns the guest Worker on the first
   * call; subsequent calls reuse it.
   *
   * @throws {@link E_ISOLATE_FUNCTION_ARG_UNSUPPORTED} when an argument cannot cross into the guest.
   * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNSUPPORTED_ENV} when no browser `Worker`
   *   global is present.
   * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATED_CRASHED} when the guest has crashed.
   * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATED_TERMINATED} after `dispose()`.
   */
  invoke: (...args: A) => Promise<R>
  /** Terminate the guest Worker and revoke its Blob URL. Every in-flight (and future) `invoke()` call
   *  rejects with {@link @nhtio/adk/batteries/isolation!E_ISOLATED_TERMINATED}. Idempotent. */
  dispose: () => void
}

// ── Guest Blob source builder ────────────────────────────────────────────────────────────────────────

/** Build the classic-Worker source text embedding `dehydrated` (a `FunctionSerializer.dehydrate()`
 *  result) plus an inline rehydrator and mini `{id,args} -> {id,ok,value|error}` message loop. No
 *  `import`/`importScripts` anywhere — the dehydrated JSON is the ONLY thing carried across the Blob
 *  boundary; everything else is inlined so the guest never needs a module resolver. */
const buildGuestSource = (dehydrated: {
  _encodedType: 'function'
  _encodedValueType: 'string'
  _encodedValue: string
}): string => `
"use strict";
var __dehydrated = ${JSON.stringify(dehydrated)};
function __rehydrate(input) {
  var src = input._encodedValue;
  try {
    return (new Function("return (" + src + ")"))();
  } catch (e) {
    return (new Function("return (function " + src + ")"))();
  }
}
var __fn = __rehydrate(__dehydrated);
self.addEventListener("message", function (ev) {
  var id = ev.data.id;
  var args = ev.data.args;
  Promise.resolve()
    .then(function () {
      var plainArgs = args.map(function (wv) {
        if (wv && wv.enc === "raw") return wv.v;
        throw new Error(
          "isolateFunction guest cannot decode a non-raw argument — no encoder is available inside the isolated Blob worker"
        );
      });
      return __fn.apply(null, plainArgs);
    })
    .then(
      function (result) {
        self.postMessage({ id: id, ok: true, value: { enc: "raw", v: result } });
      },
      function (err) {
        self.postMessage({
          id: id,
          ok: false,
          error: {
            message: err && err.message ? err.message : String(err),
            name: err && err.name ? err.name : "Error",
            stack: err && err.stack ? err.stack : undefined,
          },
        });
      }
    );
});
`

// ── isolateFunction ──────────────────────────────────────────────────────────────────────────────────

interface MiniGuestEnvelope {
  id: string
  ok: boolean
  value?: WireValue
  error?: { message: string; name: string; stack?: string }
}

const isMiniGuestEnvelope = (value: unknown): value is MiniGuestEnvelope =>
  isObject(value) && typeof (value as { id?: unknown }).id === 'string'

/**
 * Run `fn` inside a throwaway, source-rehydrated Worker. See this module's doc comment for the full
 * design and the trust-boundary implications of `allowSourceRehydration`.
 *
 * @throws {@link E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION} when `allowSourceRehydration` is not
 *   the literal `true`.
 */
export const isolateFunction = <A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
  options: IsolateFunctionOptions
): IsolatedFunctionHandle<A, R> => {
  const label = options?.name ?? fn.name ?? 'anonymous'
  if (!isObject(options) || options.allowSourceRehydration !== true) {
    throw new E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION([label])
  }

  let worker: BrowserWorker | undefined
  let blobUrl: string | undefined
  let disposed = false
  let crashed = false
  let setupPromise: Promise<BrowserWorker> | undefined
  const pending = new Map<
    string,
    { resolve: (value: R) => void; reject: (reason: unknown) => void }
  >()

  const rejectAllPending = (reason: unknown): void => {
    for (const { reject } of pending.values()) reject(reason)
    pending.clear()
  }

  const setup = async (): Promise<BrowserWorker> => {
    if (typeof Worker === 'undefined') {
      throw new E_ISOLATION_UNSUPPORTED_ENV([
        `isolateFunction(${label}) requires a browser Worker global — none was found on globalThis`,
      ])
    }
    const { FunctionSerializer } = await import('@nhtio/encoder/function_serializer')
    if (!FunctionSerializer.canSerialize(fn)) {
      throw new E_ISOLATE_FUNCTION_UNSERIALIZABLE([label])
    }
    const dehydrated = FunctionSerializer.dehydrate(fn)
    const source = buildGuestSource(dehydrated)
    blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
    const w = new Worker(blobUrl)

    const onMessage = (ev: BrowserMessageEvent): void => {
      const envelope = ev.data
      if (!isMiniGuestEnvelope(envelope)) return
      const waiter = pending.get(envelope.id)
      if (!waiter) return
      pending.delete(envelope.id)
      if (envelope.ok) {
        void decodeArgument(envelope.value as WireValue, 'auto', `${label} result`).then(
          (value) => waiter.resolve(value as R),
          (err) => waiter.reject(err)
        )
      } else {
        const wireError = envelope.error ?? {
          message: 'unknown isolateFunction guest error',
          name: 'Error',
        }
        void fromWireError(wireError).then((err) => waiter.reject(err))
      }
    }
    const onError = (ev: BrowserErrorEvent): void => {
      crashed = true
      const reason = new E_ISOLATED_CRASHED([label], {
        cause: isError(ev)
          ? ev
          : new Error(ev.message || `isolateFunction(${label}) guest crashed`),
      })
      rejectAllPending(reason)
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)

    worker = w
    return w
  }

  const ensureWorker = (): Promise<BrowserWorker> => {
    if (disposed) return Promise.reject(new E_ISOLATED_TERMINATED([label]))
    if (crashed) return Promise.reject(new E_ISOLATED_CRASHED([label]))
    if (!setupPromise) setupPromise = setup()
    return setupPromise
  }

  const invoke = async (...args: A): Promise<R> => {
    const w = await ensureWorker()
    const encodedArgs = await Promise.all(
      args.map((arg, index) =>
        encodeArgument(arg, { mode: 'auto', label: `${label} args[${index}]` })
      )
    )
    const badIndex = encodedArgs.findIndex((wv) => wv.enc !== 'raw')
    if (badIndex !== -1) {
      throw new E_ISOLATE_FUNCTION_ARG_UNSUPPORTED([`${label} args[${badIndex}]`])
    }
    const id = nextCorrelationId()
    return new Promise<R>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ id, args: encodedArgs })
    })
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    worker?.terminate()
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    rejectAllPending(new E_ISOLATED_TERMINATED([label]))
  }

  return { invoke, dispose }
}
