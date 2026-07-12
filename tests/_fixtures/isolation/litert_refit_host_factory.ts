import { litertShapeSpec } from './litert_shape_spec'
import { forkIsolated } from '@nhtio/adk/batteries/isolation/child_process'
import type { IsolatedService } from '@nhtio/adk/batteries/isolation'
import type { CreateLiteRtLmEngine, LiteRtLmEngine } from '@nhtio/adk/batteries/llm/litert_lm'

/**
 * THE DX proof (WP5 Proof A): the entire injectable `createEngine` a consumer writes to refit the
 * isolation battery in place of a bespoke transport like `litert_lm_worker_proxy.ts`'s 313-line
 * hand-rolled Worker proxy. `services` exposes the underlying `IsolatedService` (test-only escape
 * hatch, mirrors `asWorkerEngineProxy`) so specs can drive `loseDevice`/`recycle`.
 */
export const services = new WeakMap<object, IsolatedService<typeof litertShapeSpec>>()

export const makeCreateLiteRtLmEngineIsolated =
  (modulePath: string): CreateLiteRtLmEngine =>
  async ({ engineSettings, onInitProgress }) => {
    const svc = forkIsolated(litertShapeSpec, { modulePath })
    if (onInitProgress) svc.on('progress', onInitProgress)
    await svc.api.init(engineSettings)
    const engine = {
      createConversation: async (config?: unknown) => {
        await svc.api.createConversation(config)
        return {
          sendMessage: async (m: unknown) => ({ content: await svc.api.send(m) }),
          sendMessageStreaming: (m: unknown) => svc.api.sendStreaming(m).pipeThrough(toContent()),
          cancel: () => void svc.api.cancel(),
          getHistory: () => [],
          delete: async () => undefined,
        }
      },
      delete: async () => svc.dispose(),
    }
    services.set(engine, svc)
    return engine as unknown as LiteRtLmEngine
  }

const toContent = (): TransformStream<string, { content: string }> =>
  new TransformStream({ transform: (v, c) => c.enqueue({ content: v }) })
