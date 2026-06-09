/**
 * Environment-neutral retry/backoff/timeout primitives shared across HTTP-backed batteries.
 *
 * @module @nhtio/adk/lib/utils/retry
 *
 * @remarks
 * These are pure helpers — no DOM, no Node built-ins, only `setTimeout`, `AbortController`, and
 * `AbortSignal`, all of which exist in every target runtime (Node, browser, edge, workers). They
 * are shared (not duplicated) by the OpenAI Chat Completions battery and the OpenAI Embeddings
 * battery so retry behavior stays identical across the bundled batteries. The bundler inlines this
 * module into each consumer, so sharing introduces no build coupling.
 */

/**
 * Minimal backoff configuration shape. Any retry config carrying `baseDelayMs`/`maxDelayMs`
 * satisfies it structurally, so batteries can pass their own richer config objects directly.
 */
export interface BackoffConfig {
  /** Base delay in milliseconds for the first retry; doubles each attempt (default 500). */
  baseDelayMs?: number
  /** Upper bound in milliseconds on any single backoff delay (default 30_000). */
  maxDelayMs?: number
}

/**
 * Exponential backoff with a ceiling: `min(baseDelayMs * 2^(attempt-1), maxDelayMs)`.
 *
 * @param attempt - 1-based attempt number.
 * @param cfg - Carries `baseDelayMs` (default 500) and `maxDelayMs` (default 30_000).
 * @returns The (un-jittered) delay in ms.
 */
export const computeBackoff = (attempt: number, cfg: BackoffConfig): number => {
  const base = cfg.baseDelayMs ?? 500
  const max = cfg.maxDelayMs ?? 30_000
  return Math.min(base * Math.pow(2, attempt - 1), max)
}

/**
 * Abort-aware jittered sleep used for retry backoff.
 *
 * @remarks
 * Resolves (never rejects) the instant `signal` aborts, so an aborted caller does not stay parked
 * in a backoff delay — the caller's retry loop re-checks abort state immediately after and bails.
 * The timer and the abort listener are both torn down on whichever fires first, so nothing leaks.
 *
 * @param ms - Base delay in ms; jittered by ±10%.
 * @param signal - Optional abort signal that short-circuits the sleep.
 */
export const sleepWithJitter = (ms: number, signal?: AbortSignal): Promise<void> => {
  const jittered = ms * (0.9 + Math.random() * 0.2)
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let onAbort: (() => void) | undefined
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, jittered)
    if (signal) {
      onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Parses an HTTP `Retry-After` header value (delta-seconds or HTTP-date) into milliseconds.
 *
 * @param raw - The header value.
 * @returns Milliseconds to wait, or `0` when the value cannot be parsed or is in the past.
 */
export const parseRetryAfter = (raw: string): number => {
  const asNum = Number(raw)
  if (Number.isFinite(asNum)) return asNum * 1000
  const asDate = Date.parse(raw)
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  return 0
}

/**
 * Combines several abort signals into one.
 *
 * @remarks
 * Returns the linked signal plus a `dispose` that detaches any listeners the fallback path
 * attached, so repeated links on a long-lived signal (one per retry attempt) do not accumulate
 * listeners. The native `AbortSignal.any` path self-manages its listeners, so `dispose` is a no-op
 * there.
 *
 * @param signals - The signals to combine.
 * @returns The linked signal and a `dispose` to tear down fallback listeners.
 */
export const linkAbortSignals = (
  signals: ReadonlyArray<AbortSignal>
): { signal: AbortSignal; dispose: () => void } => {
  const anyFn = (AbortSignal as unknown as { any?: (sigs: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') {
    return { signal: anyFn(signals as AbortSignal[]), dispose: () => {} }
  }
  // Fallback for older runtimes: hand-link via a fresh controller.
  const ctrl = new AbortController()
  const links: Array<{ sig: AbortSignal; handler: () => void }> = []
  for (const sig of signals) {
    if (sig.aborted) {
      ctrl.abort()
      break
    }
    const handler = () => ctrl.abort()
    sig.addEventListener('abort', handler, { once: true })
    links.push({ sig, handler })
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      for (const { sig, handler } of links) sig.removeEventListener('abort', handler)
      links.length = 0
    },
  }
}
