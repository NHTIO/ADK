import { litertShapeSpec } from './litert_shape_spec'
import { serveIsolated } from '@nhtio/adk/batteries/isolation'
import type { IsolatedEmitter } from '@nhtio/adk/batteries/isolation'

/**
 * Guest entry point (node `child_process` fork target) implementing {@link litertShapeSpec} against a
 * FAKE, deterministic LiteRT-LM-shaped engine — no WebGPU, no `.litertlm` model, no `@litert-lm/core`
 * import. `send`/`sendStreaming` return a canned response derived from the last message text (word
 * count) so assertions are deterministic; `sendStreaming` tokenizes that response into words, one delta
 * per word. `init` emits two `progress` events before resolving, mirroring `onInitProgress`.
 * `loseDevice` emits `deviceLost`, mirroring the worker-proxy's GPU-loss escalation. Prebundled by
 * `prebundle_child.ts` before `fork()` (raw TS is not runnable by `child_process.fork()`).
 */
let lastMessage = ''
serveIsolated(litertShapeSpec, ({ emit }: { emit: IsolatedEmitter<typeof litertShapeSpec> }) => ({
  init: (_settings: unknown) => {
    emit.progress({ phase: 'loading', progress: 0.5 })
    emit.progress({ phase: 'loading', progress: 1 })
  },
  createConversation: (_config?: unknown) => undefined,
  send: (messages: unknown) => {
    lastMessage = String((messages as { text?: string })?.text ?? messages)
    return `fake-reply: ${lastMessage.split(/\s+/).length} words`
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
