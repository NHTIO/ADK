/**
 * @module @nhtio/adk/batteries/isolation/child_process
 *
 * Node `child_process`-backed {@link @nhtio/adk/batteries/isolation!IsolationTransport} for the
 * isolation battery — fork (or BYO-spawn) a real out-of-process guest and drive it through the exact
 * same {@link @nhtio/adk/batteries/isolation!createIsolatedService}/{@link
 * @nhtio/adk/batteries/isolation!serveIsolated} API as every other transport.
 *
 * @remarks
 * **Node-only.** This subpath barrel imports `node:child_process` directly and will not load in a
 * browser or Web Worker bundle — deliberately, unlike the main `@nhtio/adk/batteries/isolation` barrel
 * (`../index.ts`), which stays environment-neutral (zero `node:*` imports anywhere in its own module
 * graph) so it can be imported from isomorphic code. Import THIS subpath only from node-only entry
 * points (a server process, a build script, a node-targeted worker pool manager) — never from code
 * that might also run in a browser.
 *
 * **Why a child process instead of `worker_threads`?** Both give you a separate V8 isolate and a
 * message-passing channel, but they differ in exactly the failure mode this battery exists to contain:
 * a `Worker` thread shares the host process's address space and, on some native-addon segfaults or a
 * V8 fatal error, can bring the ENTIRE host process down with it — there is no way to "just terminate
 * the worker" once the underlying process has already crashed. A `child_process` is a genuinely
 * separate OS process: a native crash, an out-of-memory kill, or an uncaught fatal error inside the
 * guest terminates only that process. The host observes it as an ordinary `'exit'`/`'error'` event
 * (surfaced here via {@link @nhtio/adk/batteries/isolation!IsolationTransport.onCrash}) and can
 * `recycle()` a fresh one without the calling process/agent ever going down. For untrusted or
 * native-dependency-heavy guest code (the isolation battery's core use case), that process-level
 * containment is the entire point — trading a bit of IPC overhead and startup latency for a hard
 * fault boundary `worker_threads` cannot offer.
 */

export {
  createChildProcessTransport,
  forkIsolated,
  type ChildResolver,
  type ForkIsolatedModuleOptions,
  type ForkIsolatedOptions,
  type ForkIsolatedResolverOptions,
  type IsolatedChildLike,
} from './transport'
