import { event, method, resolveIsolatedServiceSpec, stream } from '@nhtio/adk/batteries/isolation'

/**
 * Shared isolated-service spec proving the battery can host a LiteRT-LM-shaped engine (WP5 Proof A).
 * Mirrors the REAL `@litert-lm/core` 0.13.1 surface the adapter drives — `Engine.create` /
 * `createConversation` / `delete` + `Conversation.sendMessage` / `sendMessageStreaming` / `cancel` (see
 * `src/batteries/llm/litert_lm/adapter.ts`) — flattened into one guest service (one engine, one live
 * conversation, all the adapter ever needs). Deliberately omits a `sizeInTokens`-style member: no such
 * method exists anywhere in the installed `.d.ts` (confirmed via `engine.d.ts`/`conversation.d.ts` + a
 * repo-wide grep). Shared by the guest fixtures and the host specs so both sides can't drift. Bypasses
 * validating `defineIsolatedService` (uses `resolveIsolatedServiceSpec`) per this suite's convention.
 */
export const litertShapeSpec = resolveIsolatedServiceSpec({
  name: 'litert-shape-fixture',
  methods: {
    /** Mirrors `Engine.create(engineSettings)`. Emits `progress` events while "loading". */
    init: method<[unknown], void>(),
    /** Mirrors `engine.createConversation(config)`. */
    createConversation: method<[unknown?], void>(),
    /** Mirrors `conversation.sendMessage(messages)` — one-shot generate. */
    send: method<[unknown], string>(),
    /** Mirrors `conversation.cancel()`. */
    cancel: method<[], void>(),
    /** Mirrors `engine.delete()`. */
    dispose: method<[], void>(),
    /** DEV/TEST ONLY: simulate a WebGPU device loss, emitting `deviceLost`. */
    loseDevice: method<[], void>(),
  },
  streams: {
    /** Mirrors `conversation.sendMessageStreaming(messages)` — deltas are the prompt's words. */
    sendStreaming: stream<[unknown], string>(),
  },
  events: {
    /** Mirrors the adapter's `onInitProgress` callback, fired during `init`. */
    progress: event<unknown>(),
    /** Mirrors the worker-proxy's `deviceLost` escalation (see `litert_lm_worker_proxy.ts`). */
    deviceLost: event<{ reason: string }>(),
  },
})
