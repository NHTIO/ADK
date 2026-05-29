# Assembly Contract

ADK is an execution chassis, not a pre-assembled agent. The library owns runners, loop mechanics, primitive validation, event buses, and callback contracts. The application owns model execution, persistence, prompt policy, retrieval, memory policy, tools, deployment, and observability.

## Minimum Working Shape

A runnable turn needs:

1. A `TurnRunner` configuration with all required storage/context callbacks.
2. An `executorCallback` implementing `DispatchExecutorFn`, or a battery executor.
3. Optional `tools`, `turnInputPipeline`, `turnOutputPipeline`, `dispatchInputPipeline`, and `dispatchOutputPipeline` arrays.
4. Functional listeners registered before `runner.run()` if output should be streamed.
5. A `RawTurnContext` with `turnAbortController`, `systemPrompt`, and `standingInstructions`.

`runner.run(rawCtx)` resolves to `Promise<void>`. It does not return assistant output.

## Ownership Boundary

| Area      | ADK owns                                      | Application owns                                        |
| --------- | --------------------------------------------- | ------------------------------------------------------- |
| Execution | `TurnRunner`, `DispatchRunner`, dispatch loop | `executorCallback`, model/provider calls, retry policy  |
| State     | primitive validation, context APIs            | 25 callbacks, database writes, fetch policy             |
| Logic     | middleware structure, callback invocation     | tools, retrieval, memory lifecycle, business rules      |
| Context   | typed primitive containers                    | prompt construction, history selection, context budgets |
| Events    | functional and observability buses            | UI streaming, telemetry sinks, tracing                  |

## Batteries vs. Bring Your Own

Use batteries when the default behavior matches the product:

- `@nhtio/adk/batteries/llm/openai_chat_completions` for OpenAI-compatible Chat Completions endpoints.
- `@nhtio/adk/batteries/llm/webllm_chat_completions` for browser-local WebLLM execution.
- `@nhtio/adk/batteries` and category paths for prebuilt tool instances.
- `@nhtio/adk/batteries/storage/*` only for `SpooledArtifact` byte storage.

Bring your own implementation when you need different provider protocol, custom rendering, custom persistence, custom retrieval, custom memory policy, or product-specific tool behavior.

## Minimal Assembly Checklist

- Import public API from `@nhtio/adk` and documented battery paths.
- Create or import a 25-callback storage adapter.
- Seed user messages through `fetchMessagesCallback`, not `RawTurnContext`.
- Add message hydration middleware to `turnInputPipeline`.
- Choose an executor and ensure it terminates with `ack()`/`nack()` or battery `autoAck`.
- Register `runner.on('message', ...)` before `runner.run()`.
- Pass `standingInstructions: []` explicitly when there are no standing instructions.

## RawTurnContext Rules

`RawTurnContext` contains turn metadata, not conversation history:

- `turnAbortController`: required `AbortController`.
- `systemPrompt`: required string or tokenizable system behavior.
- `standingInstructions`: required by TypeScript; pass `[]` if empty.
- `stash`: optional turn-scoped metadata registry source.

Messages, memories, retrievables, thoughts, tool calls, and dynamic tools are loaded by callbacks that your own middleware or executor explicitly invokes.

## Validation Strategy

Prefer the narrowest validation that exercises the changed assembly:

1. Typecheck the files that import ADK APIs.
2. Run relevant unit or smoke tests if present.
3. For examples/docs, run only the relevant example unless the user asks for broader validation.
4. Do not run docs builds while a VitePress docs dev server is active unless the user explicitly approves.