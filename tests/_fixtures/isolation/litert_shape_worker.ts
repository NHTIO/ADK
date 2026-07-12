import { litertShapeSpec } from './litert_shape_spec'
import { serveIsolated } from '@nhtio/adk/batteries/isolation'
import type { IsolatedEmitter } from '@nhtio/adk/batteries/isolation'

/**
 * Browser Worker twin of `litert_shape_child.ts` — implements {@link litertShapeSpec} against the same
 * FAKE, deterministic LiteRT-LM-shaped engine, served over a real `postMessage` boundary instead of
 * `child_process` IPC. Loaded prebundled (esbuild-wasm → flat ESM) by the `adk:isolation-worker-prebundle`
 * Vite middleware at `/@isolation-worker/litert_shape_worker.js` — see `vite.config.mts` for why raw
 * unbundled `@nhtio/adk` ESM graphs stack-overflow WebKit's worker module loader.
 */
serveIsolated(litertShapeSpec, ({ emit }: { emit: IsolatedEmitter<typeof litertShapeSpec> }) => ({
  init: (_settings: unknown) => {
    emit.progress({ phase: 'loading', progress: 0.5 })
    emit.progress({ phase: 'loading', progress: 1 })
  },
  createConversation: (_config?: unknown) => undefined,
  send: (messages: unknown) => {
    const text = String((messages as { text?: string })?.text ?? messages)
    return `fake-reply: ${text.split(/\s+/).length} words`
  },
  cancel: () => undefined,
  dispose: () => undefined,
  loseDevice: () => {
    emit.deviceLost({ reason: 'simulated TDR' })
  },
  sendStreaming: (messages: unknown) =>
    new ReadableStream<string>({
      start(controller) {
        const text = String((messages as { text?: string })?.text ?? messages)
        for (const word of text.split(/\s+/)) controller.enqueue(word)
        controller.close()
      },
    }),
}))
