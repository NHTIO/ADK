import { echoSpec } from './echo_spec'
import { serveIsolated } from '@nhtio/adk/batteries/isolation'
import type {
  IsolatedEmitter,
  IsolationCallContext,
  StreamHandle,
} from '@nhtio/adk/batteries/isolation'

/**
 * Guest entry point forked by the child_process transport's test suite. Implements {@link echoSpec}
 * against `serveIsolated`'s duck-detected `process.send` port. Not run directly by vitest — the test
 * harness prebundles this module (via esbuild-wasm, `format: 'cjs'`) into a runnable temp file and
 * `fork()`s THAT; see the `.node.spec.ts` files' `prebundleChild` helper for why.
 */
serveIsolated(echoSpec, ({ emit }: { emit: IsolatedEmitter<typeof echoSpec> }) => ({
  echo: (v: unknown) => v,
  fail: (msg: string) => {
    throw new Error(msg)
  },
  die: (code: number) => {
    process.exit(code)
  },
  // Never resolves on its own; rejects once the host's `abort` envelope fires `ctx.signal` — an
  // implementation opting into `{ signal: true }` is responsible for actually observing the signal,
  // the protocol layer only plumbs it through (see `serve.ts`'s `handleCall`). `ctx` is typed optional
  // to match `IsolatedImplementation`'s general shape (not every method opts into `{ signal: true }`),
  // but `hang` always declares `signal: true` in `echoSpec`, so it is always actually provided here.
  hang: (ctx?: IsolationCallContext) =>
    new Promise<never>((_resolve, reject) => {
      if (!ctx) {
        reject(new Error('hang called without a signal context'))
        return
      }
      if (ctx.signal.aborted) {
        reject(new Error('hang aborted'))
        return
      }
      ctx.signal.addEventListener('abort', () => reject(new Error('hang aborted')), { once: true })
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
