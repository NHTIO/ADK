# First Integration Workflow

Use this reference when the user asks to add ADK to an existing project, create a first agent, scaffold a runnable example, or get from zero to one working turn.

## Choose the Integration Path

Ask only when the answer is not inferable from the project:

1. Runtime: Node, browser, worker, CLI, server, or test harness.
2. Package manager: npm, pnpm, yarn, or bun.
3. Executor mode:
   - Mock executor: no key, no network, best first smoke test.
   - OpenAI battery: Node/server real-model path.
   - WebLLM battery: browser-local model path.
   - BYO executor: custom provider, custom prompt rendering, custom retry/tool loop.
4. Storage mode:
   - No-op callbacks for first scaffold/tests.
   - Real callbacks for production conversation continuity.

Default to the mock executor when the user wants a safe local scaffold and has not provided provider credentials.

## Scaffold Shape

For a first integration, create the smallest explicit assembly rather than hiding ADK behind an abstraction:

```text
src/
  noop-storage.ts
  hydrate-messages.ts
  agent.ts
```

If the project already has a convention such as `app/`, `lib/`, `server/`, or `packages/*/src`, adapt the directory names but keep the same separation:

- `noop-storage.ts`: all 25 callbacks with correct arity.
- `hydrate-messages.ts`: `turnInputPipeline` middleware that calls `ctx.fetchMessages()` and adds results to `ctx.turnMessages`.
- `agent.ts`: `Message`, `TurnRunner`, executor or battery, event listeners, and `runner.run(rawCtx)`.

Do not invent a `noopStorageAdapter` import from `@nhtio/adk`; it is a local snippet copied into the user's project.

## Dependency Step

Add `@nhtio/adk` only if the target project does not already depend on it. For TypeScript examples that run directly from source, add `tsx`, `typescript`, and `@types/node` as dev dependencies when absent.

Use the detected package manager. For pnpm projects:

```sh
pnpm add @nhtio/adk
pnpm add -D tsx typescript @types/node
```

## Mock Executor First

Prefer the Quickstart mock executor for a first smoke test. It should:

1. Create an assistant `Message`.
2. Stream text with `helpers.reportMessage(id, reply, { isComplete: true })`.
3. Persist the message with `ctx.storeMessage(...)`.
4. Call `ctx.ack()` exactly once.

This proves the runner, storage callbacks, hydration middleware, event listener, and raw turn context are wired before introducing provider credentials.

## Real Model Upgrade

When the user asks for a real model and the runtime supports it, replace only the executor slot:

- Use `OpenAIChatCompletionsAdapter` from `@nhtio/adk/batteries/llm` for OpenAI-compatible Chat Completions.
- Set `autoAck: true` for simple tool-call-free first turns.
- Require `OPENAI_API_KEY` or the user's configured provider secret at runtime; never hard-code credentials.
- Keep `noop-storage.ts` and `hydrate-messages.ts` unchanged from the mock scaffold unless the user is also adding persistence.

## Smoke Test Expectations

A minimal smoke run is successful when:

- `runner.on('message', ...)` is registered before `runner.run(...)`.
- The process prints at least one assistant message chunk.
- An observability listener sees `turnEnd`.
- `runner.run(...)` is awaited but not used as the source of assistant text.

If the user has tests, add the narrowest test that observes the `message` event and asserts the expected text. If no test harness exists, provide a runnable script command such as `pnpm exec tsx src/agent.ts`.

## Upgrade Sequence

After the first turn works, add production capabilities one at a time:

1. Replace no-op message and tool-call callbacks with real persistence.
2. Add tools and ensure tool calls are reported and persisted.
3. Add retrieval and memory hydration in `turnInputPipeline`.
4. Add iteration guards in `dispatchInputPipeline`.
5. Add telemetry through `runner.observe`, not business behavior.

Do not introduce retrieval, memory, tools, and production persistence in the same first scaffold unless the user explicitly asks for a full integration.
