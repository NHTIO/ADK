/**
 * A deliberately-broken guest Worker for the browser transport's crash-surfacing tests (WP2):
 * throws synchronously at top-level, before ever calling `serveIsolated`/signalling `ready`. Loaded
 * via `new Worker(new URL('./browser_crash_worker.ts', import.meta.url), { type: 'module' })` — the
 * resulting uncaught error escapes the worker's top-level scope and fires the DOM `Worker` instance's
 * `'error'` event, which `createWorkerTransport` wires to `onCrash`.
 */
throw new Error('browser_crash_worker: deliberate top-level crash for isolation battery tests')
