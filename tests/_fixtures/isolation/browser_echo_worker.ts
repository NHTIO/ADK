import { browserEchoSpec } from './browser_echo_spec'
import { serveIsolated } from '@nhtio/adk/batteries/isolation'
import type {
  IsolatedEmitter,
  IsolationCallContext,
  StreamHandle,
} from '@nhtio/adk/batteries/isolation'

/**
 * Guest entry point for the browser Worker transport's test suite (WP2). Implements
 * {@link browserEchoSpec} against `serveIsolated`'s duck-detected Worker `self` scope.
 *
 * @remarks
 * Loaded directly by the `.browser.spec.ts` file via `new Worker(new URL('./browser_echo_worker.ts',
 * import.meta.url), { type: 'module' })` — vitest's browser project runs a real Vite dev server, which
 * transforms/resolves this `.ts` module (including its `@nhtio/adk` bare-specifier import, aliased to
 * `src/` by `vite.config.mts`) natively, with no separate bundling step. This is the browser
 * counterpart to WP3's `echo_child.ts` (which instead needs `esbuild-wasm` prebundling because
 * `child_process.fork()` cannot load un-transpiled TypeScript).
 */
serveIsolated(browserEchoSpec, ({ emit }: { emit: IsolatedEmitter<typeof browserEchoSpec> }) => ({
  echo: (v: unknown) => v,
  fail: (msg: string) => {
    throw new Error(msg)
  },
  // Never resolves on its own; rejects once the host's `abort` envelope fires `ctx.signal` — an
  // implementation opting into `{ signal: true }` is responsible for actually observing the signal,
  // the protocol layer only plumbs it through (see `serve.ts`'s `handleCall`).
  hang: (ctx?: IsolationCallContext) =>
    new Promise<never>((_resolve, reject) => {
      if (ctx!.signal.aborted) {
        reject(new Error('hang aborted'))
        return
      }
      ctx!.signal.addEventListener('abort', () => reject(new Error('hang aborted')), { once: true })
    }),
  counter: (n: number, handle: StreamHandle) =>
    new ReadableStream<number>({
      start(controller) {
        void (async () => {
          for (let i = 0; i < n; i += 1) {
            if (handle.signal.aborted) break
            controller.enqueue(i)
            emit.progress(i)
            await new Promise((resolve) => setTimeout(resolve, 1))
          }
          controller.close()
        })()
      },
    }),
}))
