/**
 * Cross-battery helpers shared by the configured HTTP tool batteries (SearXNG, Scrapper, …).
 *
 * @module @nhtio/adk/batteries/tools/_shared
 *
 * @remarks
 * These are internal building blocks for the *factory-style* tool batteries — the ones that talk
 * to a configured HTTP instance behind custom auth and expose input/output middleware pipelines.
 * Rather than each battery carry its own copy, the common machinery lives here:
 *
 * - {@link resolveArtifact} / {@link resolveArtifactSync} — turn an {@link ArtifactResolver}
 *   (a constructor, a sync resolver, or an async / dynamic-import resolver) into the **sync**
 *   `() => SpooledArtifactConstructor` that `Tool.artifactConstructor` requires. Mirrors the vector
 *   battery's `resolveClientCtor`.
 * - {@link resolveHeaders} — collapse a static header object or a (sync/async) resolver into a
 *   plain header record for one request (refreshable-auth friendly).
 * - {@link runInputPipeline} / {@link runOutputPipeline} — the onion middleware runners (fresh
 *   runner per call, short-circuit + non-terminal detection), generic over the context type.
 *
 * This module imports harness primitives only through their specific subpath barrels
 * (`@nhtio/adk/spooled_artifact`, `@nhtio/adk/forge`, `@nhtio/adk/guards`) per the batteries
 * barrel-only rule.
 */

import { Middleware } from '@nhtio/middleware'
import { SpooledArtifact } from '@nhtio/adk/spooled_artifact'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import type { NextFn } from '@nhtio/middleware'
import type { SpooledArtifactConstructor } from '@nhtio/adk/forge'

// ── Header resolution ────────────────────────────────────────────────────────

/** A static set of request headers (used for custom instance authentication). */
export type ToolHeaders = Record<string, string>

/**
 * A resolver returning request headers, sync or async. Use this form when the auth token is
 * refreshable — the resolver runs on every request, so a fresh token can be minted per call.
 */
export type ToolHeadersResolver = () => ToolHeaders | Promise<ToolHeaders>

/**
 * Resolve the configured headers (a static object or a sync/async resolver) for a single request.
 *
 * @param headers - The static header record, the resolver, or `undefined`.
 * @returns A fresh, owned copy of the resolved headers (`{}` when none supplied).
 */
export const resolveHeaders = async (
  headers: ToolHeaders | ToolHeadersResolver | undefined
): Promise<ToolHeaders> => {
  if (typeof headers === 'function') return { ...(await headers()) }
  return { ...(headers ?? {}) }
}

// ── Artifact resolver ────────────────────────────────────────────────────────

/** Convenience alias for the spooled-artifact constructor a tool wraps its output in. */
export type SpooledArtifactCtor = SpooledArtifactConstructor

/**
 * The artifact configuration accepted by a factory: a constructor, a sync resolver, or an async /
 * dynamic-import resolver (which may yield a module namespace whose `default` is the constructor).
 *
 * @remarks
 * Mirrors the vector battery's `client` resolver and `Tool.artifactConstructor`'s indirection. The
 * async form lets a consumer `() => import('@nhtio/adk/spooled_artifact').then(m => m.SpooledMarkdownArtifact)`
 * so the artifact class never enters their static module graph.
 */
export type ArtifactResolver =
  | SpooledArtifactCtor
  | (() => SpooledArtifactCtor | { default: SpooledArtifactCtor })
  | (() => Promise<SpooledArtifactCtor | { default: SpooledArtifactCtor }>)

/** The sync subset of {@link ArtifactResolver} — a constructor or a sync resolver (no Promise). */
export type SyncArtifactResolver =
  | SpooledArtifactCtor
  | (() => SpooledArtifactCtor | { default: SpooledArtifactCtor })

/** Unwrap a resolved value that may be a module namespace whose `default` is the constructor. */
const unwrapDefault = (value: unknown): unknown => {
  if (isObject(value) && 'default' in value) {
    const def = (value as { default?: unknown }).default
    if (SpooledArtifact.isSpooledArtifactConstructor(def)) return def
  }
  return value
}

/**
 * Resolve an {@link ArtifactResolver} to the **sync** `() => SpooledArtifactCtor` that
 * `Tool.artifactConstructor` requires (the wrap-site and the construction-time validator both
 * invoke it synchronously, so an async resolver cannot be passed straight through).
 *
 * @remarks
 * A bare constructor is itself a function, so it is distinguished from a resolver via
 * `SpooledArtifact.isSpooledArtifactConstructor` (the same duck-typed guard the core validator
 * uses) rather than by arity. Async because a dynamic-import resolver must be awaited here.
 *
 * @param resolver - The artifact configuration. When `undefined`, callers should fall back to
 *   their own default (this function rejects `undefined` so the default lives with the caller).
 * @param onInvalid - Throws a battery-scoped error; receives a human-readable reason.
 * @returns A sync `() => SpooledArtifactCtor` suitable for `Tool.artifactConstructor`.
 */
export const resolveArtifact = async (
  resolver: ArtifactResolver,
  onInvalid: (reason: string) => never
): Promise<() => SpooledArtifactCtor> => {
  // A constructor: hand back a thunk that returns it.
  if (SpooledArtifact.isSpooledArtifactConstructor(resolver)) {
    const ctor = resolver
    return () => ctor
  }
  // Otherwise it must be a resolver function.
  if (typeof resolver !== 'function') {
    onInvalid('artifact must be a SpooledArtifact constructor or a resolver returning one')
  }
  let resolved: unknown
  try {
    resolved = await (resolver as () => unknown)()
  } catch (err) {
    onInvalid(`artifact resolver threw: ${isError(err) ? err.message : String(err)}`)
  }
  resolved = unwrapDefault(resolved)
  if (!SpooledArtifact.isSpooledArtifactConstructor(resolved)) {
    onInvalid('artifact resolver did not resolve to a SpooledArtifact constructor')
  }
  const ctor = resolved as SpooledArtifactCtor
  return () => ctor
}

/**
 * Synchronous {@link resolveArtifact}: accepts only the {@link SyncArtifactResolver} subset and
 * throws (via `onInvalid`) on an async resolver — a runtime guard for JS callers who bypass the
 * compile-time narrowing.
 *
 * @param resolver - A constructor or a sync resolver.
 * @param onInvalid - Throws a battery-scoped error; receives a human-readable reason.
 * @returns A sync `() => SpooledArtifactCtor` suitable for `Tool.artifactConstructor`.
 */
export const resolveArtifactSync = (
  resolver: SyncArtifactResolver,
  onInvalid: (reason: string) => never
): (() => SpooledArtifactCtor) => {
  if (SpooledArtifact.isSpooledArtifactConstructor(resolver)) {
    const ctor = resolver
    return () => ctor
  }
  if (typeof resolver !== 'function') {
    onInvalid('artifact must be a SpooledArtifact constructor or a resolver returning one')
  }
  let resolved: unknown
  try {
    resolved = (resolver as () => unknown)()
  } catch (err) {
    onInvalid(`artifact resolver threw: ${isError(err) ? err.message : String(err)}`)
  }
  if (isInstanceOf(resolved, 'Promise', Promise)) {
    onInvalid(
      'artifact resolver is async; use the async factory variant for dynamic-import resolvers'
    )
  }
  resolved = unwrapDefault(resolved)
  if (!SpooledArtifact.isSpooledArtifactConstructor(resolved)) {
    onInvalid('artifact resolver did not resolve to a SpooledArtifact constructor')
  }
  const ctor = resolved as SpooledArtifactCtor
  return () => ctor
}

// ── Middleware pipeline runners ──────────────────────────────────────────────

/** Internal sentinel a short-circuiting input stage throws to unwind the pipeline immediately. */
const SHORT_CIRCUIT = Symbol('adk.tools.shortCircuit')

interface ShortCircuitSignal {
  [SHORT_CIRCUIT]: true
  result: string
}

/** `true` when `value` is the short-circuit sentinel produced by {@link makeShortCircuit}. */
export const isShortCircuit = (value: unknown): value is { result: string } =>
  isObject(value) && (value as Record<symbol, unknown>)[SHORT_CIRCUIT] === true

/**
 * Build a `shortCircuit(result)` function for an input-pipeline context. Calling it throws the
 * internal sentinel, which {@link runInputPipeline} catches and converts into the verbatim result
 * (skipping the HTTP request entirely — e.g. a cache hit).
 *
 * @returns A function that, when called with a result string, throws the short-circuit sentinel.
 */
export const makeShortCircuit = (): ((result: string) => never) => {
  return (result: string): never => {
    const signal: ShortCircuitSignal = { [SHORT_CIRCUIT]: true, result }
    throw signal
  }
}

/** A generic onion middleware stage over a mutable context `C`. */
export type MiddlewareFn<C> = (ctx: C, next: NextFn) => void | Promise<void>

/**
 * Run an input pipeline over `ctx`. Returns the short-circuit string when a stage short-circuited,
 * or `undefined` when the pipeline reached its terminal handler. A non-terminal pipeline (a stage
 * that neither called `next()` nor short-circuited) throws — the caller converts it to an
 * `Error:` string.
 *
 * @param mw - The `Middleware` instance holding the stages (a fresh `.runner()` is minted here).
 * @param ctx - The mutable input context handed to each stage.
 * @param label - Battery name, used in the non-terminal error message.
 * @returns The short-circuit result string, or `undefined` if the pipeline ran to completion.
 */
export const runInputPipeline = async <C>(
  mw: Middleware<MiddlewareFn<C>>,
  ctx: C,
  label: string
): Promise<string | undefined> => {
  let reached = false
  let caught: unknown
  await mw
    .runner()
    .errorHandler(async (error: unknown) => {
      caught = error
    })
    .finalHandler(async () => {
      reached = true
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (caught !== undefined) {
    if (isShortCircuit(caught)) return caught.result
    throw caught
  }
  if (!reached) {
    throw new Error(`${label} input pipeline did not call next() and did not short-circuit.`)
  }
  return undefined
}

/**
 * Run an output pipeline over `ctx`; rethrow any stage error to the caller's try/catch. A
 * non-terminal pipeline (no `next()`) throws.
 *
 * @param mw - The `Middleware` instance holding the stages (a fresh `.runner()` is minted here).
 * @param ctx - The mutable output context handed to each stage.
 * @param label - Battery name, used in the non-terminal error message.
 */
export const runOutputPipeline = async <C>(
  mw: Middleware<MiddlewareFn<C>>,
  ctx: C,
  label: string
): Promise<void> => {
  let reached = false
  let caught: unknown
  await mw
    .runner()
    .errorHandler(async (error: unknown) => {
      caught = error
    })
    .finalHandler(async () => {
      reached = true
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (caught !== undefined) throw caught
  if (!reached) throw new Error(`${label} output pipeline did not call next().`)
}

/**
 * Optional per-call gate run before a side-effecting tool executes. Throwing aborts the call
 * and surfaces through the standard tool-error path (`E_TOOL_DOWNSTREAM_ERROR` with the denial
 * as `cause`). The canonical implementation awaits `ctx.waitFor({ reason: 'tool_approval',
 * payload: call })` — the ADK gates primitive — and throws on denial; WHO approves and HOW is
 * the consumer's contract, this type is the seam.
 */
export type ToolGateFn = (
  ctx: unknown,
  call: { tool: string; args: unknown }
) => void | Promise<void>

/**
 * Await a configured {@link ToolGateFn} (no-op when absent). Factory batteries call this at
 * the top of their handlers so the gate runs before any side effect.
 *
 * @param gate - The configured gate, if any.
 * @param ctx - The dispatch context the handler received.
 * @param tool - The tool name (post-override).
 * @param args - The validated tool args.
 */
export const runToolGate = async (
  gate: ToolGateFn | undefined,
  ctx: unknown,
  tool: string,
  args: unknown
): Promise<void> => {
  if (gate) await gate(ctx, { tool, args })
}
