/**
 * SDK error → ADK classification for the Anthropic Messages battery.
 *
 * @remarks
 * Extracted so the dispatch path (`adapter.ts`) and the token-count path (`count_tokens.ts`) share
 * ONE classifier. They previously carried byte-identical private copies, which meant a fix to one
 * silently left the other wrong — exactly what happened with the statusless-`APIError` bug this
 * module's {@link AnthropicMessagesErrorStatusResolver} seam addresses.
 *
 * Narrowing is STRUCTURAL (`isSdkError` below), never nominal against a statically imported class.
 * Issue #46: importing `@anthropic-ai/sdk/core/error` directly gave the bundler a second, inlined
 * copy of the SDK's error classes, and `instanceof`/constructor-name narrowing against that copy
 * never matched the classes the REAL client (imported from `@anthropic-ai/sdk`) throws — every
 * HTTP error classified `fatal` with status `0`, so `retry` and `Retry-After` never fired. The
 * structural walk requires no class identity at all, so it works under bundling, dualRealm
 * setups, and any future reshuffle of the SDK's internals.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/error_translation
 */

import { isObject, isError } from '@nhtio/adk/guards'
import type { AnthropicMessagesErrorStatusResolver } from './types'

/**
 * Whether an SDK error instance is at least the named class from the REAL `@anthropic-ai/sdk`
 * module the client imports.
 *
 * @remarks
 * Issue #46: this module previously narrowed with `isInstanceOf(err, "APIError", APIError)` where the
 * `APIError` binding came from a STATIC import of `@anthropic-ai/sdk/core/error`, and the bundler
 * inlined that module's error classes into the published chunk. `adapter.ts` imports the client from
 * `@anthropic-ai/sdk`, which resolves to a DIFFERENT (non-inlined) module instance — so the client
 * throws `RateLimitError`/`InternalServerError` instances whose ancestry ends at a bundled-vs-real
 * `APIError` pair with equal NAMES but different REPTMs, and every nominal and name check failed. All
 * 429/502/503/504/529 errors fell through to `fatal, status 0` and `retry` never fired.
 *
 * Structural narrowing avoids the second class identity entirely: every real SDK error class is an
 * `Error` subclass, so the check walks the prototype chain for the named constructor and refuses
 * anything the SDK could not have thrown (a bare `Error`, a `TypeError`, a string).
 *
 * @param err - The thrown value (already known to be an `Error`).
 * @param name - The SDK error class name to match in the prototype chain.
 */
const isSdkError = (err: Error, name: string): boolean => {
  for (
    let current: object | null | undefined = err;
    current !== undefined && current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    if (current.constructor?.name === name) return true
  }
  return false
}

/**
 * Whether the thrown value carries the two observations every HTTP-status-carrying SDK error has.
 *
 * @remarks
 * `APIError` declares `status` and `headers` on every instance, so this is the final structural
 * confirmation that the value came from the SDK rather than something that merely has an `APIError`
 * ancestor name in its chain.
 */
const isApiErrorShape = (
  err: object
): err is { status?: number; headers?: Headers; error?: unknown } =>
  'status' in err && 'headers' in err && 'error' in err

/**
 * The response headers of a real SDK HTTP error, or `undefined` for anything else.
 *
 * @remarks
 * The `Retry-After` header is read on the retry path (`adapter.ts` and `count_tokens.ts`), and BOTH
 * sites previously guarded with `isInstanceOf(err, 'APIError', APIError)` against the inlined copy —
 * so issue #46 silently disabled `Retry-After` honouring as well as retry classification. Exporting
 * the structural check here keeps ONE identity-free definition of "is this an SDK HTTP error" and
 * lets those callers stop importing `@anthropic-ai/sdk/core/error` (which is what inlined the second
 * class identity in the first place).
 *
 * @param err - The thrown value.
 * @returns The error's `Headers`, or `undefined` when it is not an SDK HTTP error.
 */
export const anthropicErrorHeaders = (err: unknown): Headers | undefined => {
  if (!isError(err)) return undefined
  return isSdkError(err, 'APIError') && isApiErrorShape(err) ? err.headers : undefined
}

/**
 * Body-text marker identifying an Anthropic context-overflow rejection.
 *
 * @remarks
 * Context overflow arrives as a 400 `BadRequestError` and is detected from body TEXT, not status —
 * the status alone cannot distinguish it from any other bad request.
 */
export const CONTEXT_OVERFLOW_PHRASE = 'prompt is too long'

/**
 * The outcome of classifying an SDK error.
 */
export type AnthropicErrorClassification =
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'context-overflow'; message: string }
  | { kind: 'retriable'; status: number; message: string }
  | { kind: 'fatal'; status: number; message: string }

/**
 * Apply a consumer-supplied status resolver, defending against every way it can misbehave.
 *
 * @param resolver - The consumer hook, or `undefined` when none was configured.
 * @param input - The error, its body text, and the SDK-reported status.
 * @param warn - Optional sink for a one-line diagnostic when the resolver misbehaves.
 * @returns The resolved status, or `undefined` to leave the SDK status in force.
 */
const applyStatusResolver = (
  resolver: AnthropicMessagesErrorStatusResolver | undefined,
  input: { error: unknown; bodyText: string; sdkStatus: number },
  warn?: (msg: string) => void
): number | undefined => {
  if (resolver === undefined) return undefined
  // The warn SINK is consumer-supplied too, so it can throw just like the resolver. Every
  // diagnostic emitted from this helper goes through here: a logger fault must never become the
  // failure the caller sees, which would replace a real, reportable upstream error with an
  // unrelated one from the diagnostic path.
  const safeWarn = (msg: string): void => {
    try {
      warn?.(msg)
    } catch {
      // Nothing useful to do — the channel for reporting problems is itself the problem.
    }
  }
  let resolved: number | undefined
  try {
    resolved = resolver(input)
  } catch (err) {
    // `String(err)` can throw in its own right (a hostile `toString`/`Symbol.toPrimitive`), so the
    // message is built inside this catch rather than passed out of it.
    let detail: string
    try {
      detail = isError(err) ? err.message : String(err)
    } catch {
      detail = '<uncoercible thrown value>'
    }
    safeWarn(`resolveErrorStatus threw and was ignored: ${detail}`)
    return undefined
  }
  if (resolved === undefined) return undefined
  if (typeof resolved !== 'number' || !Number.isInteger(resolved)) {
    let shown: string
    try {
      shown = String(resolved)
    } catch {
      shown = '<uncoercible>'
    }
    safeWarn(`resolveErrorStatus returned a non-integer (${shown}); ignoring it.`)
    return undefined
  }
  if (resolved < 100 || resolved > 599) {
    safeWarn(`resolveErrorStatus returned ${resolved}, outside 100-599; ignoring it.`)
    return undefined
  }
  return resolved
}

/**
 * Classify an error thrown by the Anthropic SDK into an ADK disposition.
 *
 * @remarks
 * Ordering is deliberate. Abort and timeout are checked first because they are control-flow
 * outcomes rather than failures. `APIConnectionError` is retriable at status `0` — a transport
 * fault has no HTTP status and never will, and that branch establishes the convention that a
 * statusless error can still be retriable.
 *
 * For an `APIError`, the consumer's `resolveErrorStatus` hook (when configured) runs BEFORE both
 * the context-overflow check and retriable classification, so a recovered status participates in
 * every downstream decision and is what gets reported — a recovered `529` surfaces as `529`, not
 * `0`. Without a resolver the behaviour is unchanged from before the hook existed: a statusless
 * `APIError` coerces to `0`, matches no retriable status, and is fatal.
 *
 * Branch coverage for real SDK error shapes (issue #46): an abort (`APIUserAbortError`), a request
 * timeout (`APIConnectionTimeoutError`, the `APIConnectionError` subclass the SDK throws on its own
 * deadline), a transport failure (`APIConnectionError`, retriable at status `0`), any HTTP-status
 * error (an `APIError` carrying `status` and `Headers`) whose subclasses are matched through the
 * same structural walk, and finally a non-HTTP SDK failure (`AnthropicError`, e.g. a
 * `RetryableError`) or any other thrown value — both fatal at status `0`.
 *
 * @param err - The thrown value.
 * @param retriableStatuses - Status codes configured as retriable.
 * @param opts - Optional status resolver and warning sink.
 * @returns The classification.
 */
export const translateAnthropicError = (
  err: unknown,
  retriableStatuses: ReadonlyArray<number>,
  opts?: {
    resolveErrorStatus?: AnthropicMessagesErrorStatusResolver
    warn?: (msg: string) => void
  }
): AnthropicErrorClassification => {
  // Every real SDK error is an `Error`, so non-Error values cannot reach the structural checks;
  // classify them fatal at the bottom as before.
  if (!isError(err)) return { kind: 'fatal', status: 0, message: String(err) }
  if (isSdkError(err, 'APIUserAbortError')) return { kind: 'abort' }
  if (isSdkError(err, 'APIConnectionTimeoutError')) {
    return { kind: 'timeout' }
  }
  if (isSdkError(err, 'APIConnectionError')) {
    return { kind: 'retriable', status: 0, message: err.message }
  }
  if (isSdkError(err, 'APIError') && isApiErrorShape(err)) {
    const sdkStatus = typeof err.status === 'number' ? err.status : 0
    const bodyText = isObject(err.error) ? JSON.stringify(err.error) : String(err.error ?? '')
    const status =
      applyStatusResolver(
        opts?.resolveErrorStatus,
        { error: err, bodyText, sdkStatus },
        opts?.warn
      ) ?? sdkStatus
    if (status === 400 && bodyText.toLowerCase().includes(CONTEXT_OVERFLOW_PHRASE)) {
      return { kind: 'context-overflow', message: bodyText }
    }
    if (retriableStatuses.includes(status)) {
      return { kind: 'retriable', status, message: bodyText || err.message }
    }
    return { kind: 'fatal', status, message: bodyText || err.message }
  }
  if (isSdkError(err, 'AnthropicError')) return { kind: 'fatal', status: 0, message: err.message }
  return { kind: 'fatal', status: 0, message: err.message }
}
