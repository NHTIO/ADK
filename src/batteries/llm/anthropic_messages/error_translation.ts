/**
 * SDK error → ADK classification for the Anthropic Messages battery.
 *
 * @remarks
 * Extracted so the dispatch path (`adapter.ts`) and the token-count path (`count_tokens.ts`) share
 * ONE classifier. They previously carried byte-identical private copies, which meant a fix to one
 * silently left the other wrong — exactly what happened with the statusless-`APIError` bug this
 * module's {@link AnthropicMessagesErrorStatusResolver} seam addresses.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/error_translation
 */

import { isObject, isError, isInstanceOf } from '@nhtio/adk/guards'
import {
  APIError,
  AnthropicError,
  APIConnectionError,
  APIUserAbortError,
  APIConnectionTimeoutError,
} from '@anthropic-ai/sdk/core/error'
import type { AnthropicMessagesErrorStatusResolver } from './types'

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
  if (isInstanceOf(err, 'APIUserAbortError', APIUserAbortError)) return { kind: 'abort' }
  if (isInstanceOf(err, 'APIConnectionTimeoutError', APIConnectionTimeoutError)) {
    return { kind: 'timeout' }
  }
  if (isInstanceOf(err, 'APIConnectionError', APIConnectionError)) {
    return { kind: 'retriable', status: 0, message: err.message }
  }
  if (isInstanceOf(err, 'APIError', APIError)) {
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
  const message = isError(err) ? err.message : String(err)
  if (isInstanceOf(err, 'AnthropicError', AnthropicError)) {
    return { kind: 'fatal', status: 0, message }
  }
  return { kind: 'fatal', status: 0, message }
}
