---
name: adk-assembly
description: "Use when assembling, configuring, or reviewing an @nhtio/adk agent: TurnRunner wiring, executorCallback, LLM batteries, 25 storage callbacks, context hydration, tools, retrieval, memory, pipelines, events, RawTurnContext, ack/nack, or batteries vs BYO choices."
license: MIT
compatibility: "Requires TypeScript/JavaScript project using @nhtio/adk; examples assume Node 20+ or compatible browser/runtime."
metadata:
  package: "@nhtio/adk"
  version: "0.0.1"
  author: "Jak Giveon <jak@nht.io>"
  copyright: "© 2025-present New Horizon Technology LTD"
---

# ADK Assembly

Use this skill to help users build or review an `@nhtio/adk` assembly: the application-owned wiring around the ADK execution chassis.

## Package Metadata

- Package: `@nhtio/adk`
- Version: `0.0.1`
- License: MIT
- Author: Jak Giveon <jak@nht.io>
- Copyright: © 2025-present New Horizon Technology LTD
- Compatibility: Requires TypeScript/JavaScript project using `@nhtio/adk`; examples assume Node 20+ or compatible browser/runtime.

ADK does not ship a hidden default agent. Treat every assembly as explicit wiring of:

1. Storage/context callbacks
2. An executor callback or LLM battery
3. Optional tools, retrieval, memory, and pipelines
4. Functional and observability event listeners
5. A `RawTurnContext` passed to `runner.run()`

## First Integration Workflow

When the user asks to add ADK to a project or create their first agent, load [First integration workflow](./references/first-integration.md) before proposing files.

Prefer this order:

1. Detect package manager, TypeScript setup, runtime, and existing `@nhtio/adk` dependency.
2. Choose one executor path: mock executor for no-key local smoke test, OpenAI battery for a real Node/server model, WebLLM battery for browser-local execution, or BYO executor for custom providers.
3. Scaffold the smallest explicit assembly: `noop-storage.ts`, `hydrate-messages.ts`, and an `agent.ts` or project-local equivalent.
4. Run or provide the narrowest smoke command that proves a `message` event is observed and `turnEnd` fires.
5. Upgrade one capability at a time: real persistence, tools, retrieval, memory, iteration guards, then telemetry.

Do not start with retrieval, memory, tools, production persistence, and a real model all at once unless the user explicitly asks for a full integration.

## Assembly Procedure

1. Identify the target runtime: Node, browser, worker, CLI, server, or test harness.
2. Identify the executor path: first-party LLM battery or custom `DispatchExecutorFn`.
3. Establish the storage baseline before anything else: all 25 callbacks must exist with correct arity.
4. Add context hydration in `turnInputPipeline`; ADK does not auto-fetch messages, memories, tool calls, tools, retrievables, or standing instructions.
5. Register tools intentionally: baseline tools in `tools`, dynamic tools by explicitly calling `ctx.fetchTools()` and registering them.
6. Put retrieval and memory loading in `turnInputPipeline`; put memory extraction or analytics in `turnOutputPipeline` only when success-only behavior is acceptable.
7. Add dispatch safeguards such as iteration caps in `dispatchInputPipeline`.
8. Register functional listeners before `runner.run()` so streamed output is not missed.
9. Keep observability listeners behavior-free; telemetry must not change agent results.
10. Validate by typechecking or running the narrowest relevant tests/examples.

## Decision Rules

- Use `OpenAIChatCompletionsAdapter` or `WebLLMChatCompletionsAdapter` when the user wants a ready executor.
- Write a custom `executorCallback` only when provider protocol, prompt rendering, retry policy, tool loop, or lifecycle behavior must differ from batteries.
- Use no-op storage callbacks only for prototypes/tests; never omit callbacks.
- Implement real `Message` and `ToolCall` persistence for conversational or tool-using agents.
- Use storage batteries only for `SpooledArtifact` bytes; they do not satisfy the 25 callback contract.
- Use `ctx.stash.get()` and `ctx.stash.set()`; do not treat `ctx.stash` as a plain object.
- Use public imports from `@nhtio/adk` and documented battery entrypoints; do not deep-import from internal `src` or `lib` paths.

## Required References

Load the focused reference that matches the user's task:

- [First integration workflow](./references/first-integration.md) for adding ADK to a project, scaffolding a first runnable turn, or upgrading from mock executor to a real model.
- [Assembly contract](./references/assembly-contract.md) for the chassis model, minimal runner shape, and batteries-vs-BYO decisions.
- [Storage and context](./references/storage-and-context.md) for the 25 callbacks, callback arity, context hydration, memory, and retrieval.
- [Executors, tools, pipelines, and events](./references/executors-tools-pipelines-events.md) for `ack()`/`nack()`, tool execution, middleware placement, and event buses.

Use the canonical docs when the user needs complete examples, API-adjacent prose, or source-of-truth wording. `$CI_PAGES_URL` is a build-time placeholder and must be left unchanged in source:

- `$CI_PAGES_URL/llms.txt` — LLM-friendly documentation index.
- `$CI_PAGES_URL/llms-full.txt` — Full LLM-friendly documentation corpus.
- `$CI_PAGES_URL/api/index.md` — Generated API documentation index.
- `$CI_PAGES_URL/quickstart.md` — No-key three-file first turn with a mock executor.
- `$CI_PAGES_URL/assembly/` — Assembly overview.
- `$CI_PAGES_URL/assembly/minimal-assembly.md` — Minimal runnable assembly.
- `$CI_PAGES_URL/assembly/batteries-llm.md` — LLM batteries.
- `$CI_PAGES_URL/assembly/batteries-storage.md` — Storage batteries.
- `$CI_PAGES_URL/assembly/batteries-tools.md` — Tool batteries.
- `$CI_PAGES_URL/assembly/byo-llm.md` — Custom executor guidance.
- `$CI_PAGES_URL/assembly/byo-storage.md` — 25 callback storage contract.
- `$CI_PAGES_URL/assembly/byo-tools.md` — Custom tool definitions and registries.
- `$CI_PAGES_URL/assembly/byo-retrieval.md` — Retrieval and trust-tier guidance.
- `$CI_PAGES_URL/assembly/byo-memory.md` — Memory lifecycle guidance.
- `$CI_PAGES_URL/assembly/pipelines.md` — Pipeline placement rules.
- `$CI_PAGES_URL/assembly/events.md` — Functional and observability event buses.

## Common Failure Checks

- Missing one of the 25 callbacks or using `async () => []` where ADK requires `(ctx) => []`.
- Expecting `runner.run()` to return the assistant text; it returns `Promise<void>` and output comes through events.
- Forgetting `autoAck: true` when directly wiring an LLM battery for a simple one-shot turn.
- Putting primary model reasoning in middleware or event listeners instead of the executor.
- Loading no messages because `turnInputPipeline` never calls `ctx.fetchMessages()` and `.add()`s results into `ctx.turnMessages`.
- Treating first-party, public third-party, and private/user-supplied retrievables as equivalent trust sources.
- Relying on `turnOutputPipeline` for cleanup that must run after failures.