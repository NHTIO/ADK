# Executors, Tools, Pipelines, and Events

The executor is the only primary reasoning loop. Pipelines prepare or inspect context. Events deliver output and telemetry.

## Executor Contract

`executorCallback` implements `DispatchExecutorFn`:

```ts
const executor = async (ctx, helpers) => {
  try {
    // call model, stream output, execute tools, persist state
    ctx.ack()
  } catch (error) {
    ctx.nack(error instanceof Error ? error : new Error(String(error)))
  }
}
```

The executor must eventually call exactly one terminal signal per invocation:

- `ctx.ack()` for successful completion.
- `ctx.nack(error)` for failure.

Failing to signal can leave the dispatch loop running until an abort or middleware intervention. Double signaling throws.

For battery executors, use `autoAck: true` for simple one-shot turns that should finish after a tool-call-free response. Omit it only when the application owns a later quality gate or terminal signal.

## Executor Responsibilities

A custom executor owns:

1. Formatting ADK primitives into provider requests.
2. Calling the model/provider or custom decision runtime.
3. Streaming functional output through `helpers.reportMessage`, `helpers.reportThought`, and `helpers.reportToolCall`.
4. Executing requested tools inline with `tool.executor(ctx)(args)`.
5. Persisting messages, thoughts, and tool calls through `ctx.store*` / `ctx.mutate*`.
6. Enforcing provider retry, timeout, and loop policies.
7. Finalizing with `ack()` or `nack()`.

Reporting is not persistence. Use both `helpers.report*` for live output and `ctx.store*` for durable state.

## Tool Wiring

Define tools with `Tool`. The `inputSchema` is both runtime argument validation and the model-visible schema.

Register tools through:

- `tools: [toolA, toolB]` for baseline tools available each turn.
- `fetchToolsCallback` plus middleware registration for dynamic tools.
- `new ToolRegistry([...])` or `ToolRegistry.merge(...)` when manually combining registries.

Do not look for `ToolRegistry.fromTools`; construct a registry directly.

Trust rules:

- `trusted: false` is the safe default for inline textual/spooled tool results.
- Set `trusted: true` only for developer-controlled or explicitly user-authorized output.
- `Media.trustTier` controls media trust, not `Tool.trusted`.

Tool handler returns are raw. Executors or batteries decide whether to wrap strings/bytes in `SpooledArtifact`, spool bytes, or persist `Media` handles directly.

## Pipeline Placement

ADK has four optional middleware arrays:

- `turnInputPipeline`: once before dispatch. Use for hydration, retrieval, memory loading, rate limits, standing-instruction refresh, and stash setup.
- `turnOutputPipeline`: once after successful dispatch. Use for memory extraction, analytics, webhooks, and success-only cleanup.
- `dispatchInputPipeline`: before every executor call. Use for iteration caps, loop detection, and corrective intervention.
- `dispatchOutputPipeline`: after every executor call. Use for per-iteration logging and inspection.

Middleware must call `next()` to continue. Not calling `next()` short-circuits intentionally.

Hard rules:

- No primary reasoning models in pipelines.
- Put secondary preprocessing model calls in pipelines only as an explicit cost/security exception.
- Use `ctx.stash.get()` and `ctx.stash.set()` for cross-middleware data.
- Do not put critical failure cleanup in `turnOutputPipeline`; it does not run after input or dispatch failures.

## Iteration Guards

Core ADK does not impose iteration limits. Add a dispatch input guard for runaway loops:

```ts
const iterationCap = async (ctx, next) => {
  if (ctx.iteration >= 10) {
    ctx.nack(new Error('Max iterations exceeded'))
    return
  }
  await next()
}
```

For repeated tool calls, use the same checksum convention stored on the tool call and inspect `ctx.toolCallCount(checksum)`.

## Events

`runner.run()` returns no assistant data. Output and telemetry leave through two buses.

Functional bus:

- API: `runner.on`, `runner.off`, `runner.once`.
- Events: `message`, `thought`, `toolCall`.
- Use for product output: terminal streaming, SSE, WebSocket messages, tool progress UI.

Observability bus:

- API: `runner.observe`, `runner.unobserve`, `runner.observeOnce`.
- Events include `turnStart`, `turnEnd`, `dispatchStart`, `dispatchEnd`, `iterationStart`, `iterationEnd`, `toolExecutionStart`, `toolExecutionEnd`, `log`, and `error`.
- Use for tracing, metrics, structured logs, and error reporting only.

Register listeners before `runner.run()`. If removing a listener changes product behavior, it belongs on the functional bus; if removing it only changes telemetry, it belongs on the observability bus.