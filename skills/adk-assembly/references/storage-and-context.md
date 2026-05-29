# Storage and Context

ADK does not persist or hydrate state by default. A complete `TurnRunner` assembly provides 25 callbacks, and the application decides when to call fetch callbacks and where to place returned primitives.

## The 25 Required Callbacks

Retrieval callbacks require exactly one declared parameter, usually `ctx`:

- `fetchMemoriesCallback`
- `fetchMessagesCallback`
- `fetchThoughtsCallback`
- `fetchToolCallsCallback`
- `fetchToolsCallback`
- `fetchRetrievablesCallback`
- `refreshStandingInstructionsCallback`

Persistence callbacks require exactly two declared parameters, usually `ctx` and the value or id:

- Store: `storeMemoryCallback`, `storeMessageCallback`, `storeThoughtCallback`, `storeToolCallCallback`, `storeRetrievableCallback`, `storeStandingInstructionCallback`
- Mutate: `mutateMemoryCallback`, `mutateMessageCallback`, `mutateThoughtCallback`, `mutateToolCallCallback`, `mutateRetrievableCallback`, `mutateStandingInstructionCallback`
- Delete: `deleteMemoryCallback`, `deleteMessageCallback`, `deleteThoughtCallback`, `deleteToolCallCallback`, `deleteRetrievableCallback`, `deleteStandingInstructionCallback`

No-ops are valid, but omissions and wrong arity are invalid:

```ts
fetchMessagesCallback: async (_ctx) => []
deleteMemoryCallback: async (_ctx, _id) => {}
```

Do not write arity-zero callbacks such as `async () => []` for fetch callbacks or `async () => {}` for write callbacks.

## Persistence Priorities

- `Message` persistence is required for real conversation continuity.
- `ToolCall` persistence is required for tool-using agents and multi-iteration loops.
- `Memory`, `Thought`, `Retrievable`, and standing-instruction callbacks can be no-op for early prototypes if the product does not use those features.
- Storage batteries do not implement these callbacks; they only store spooled artifact bytes.

## Context Hydration Pattern

New turn-scoped sets start empty. ADK exposes fetch methods, but it does not call them automatically.

Hydrate in `turnInputPipeline`:

```ts
const hydrateMessages = async (ctx, next) => {
  const messages = await ctx.fetchMessages()
  for (const message of messages) {
    ctx.turnMessages.add(message)
  }
  await next()
}
```

Use the same pattern for memories, thoughts, tool calls, retrievables, tools, and refreshed standing instructions. Put prerequisite hydration first in `turnInputPipeline` so later middleware and the executor see populated context.

## Messages

Messages represent conversation history. To seed the first user message, return a real `Message` instance from `fetchMessagesCallback` and hydrate it into `ctx.turnMessages`. `RawTurnContext` does not accept message history.

## Tools as Context

`fetchToolsCallback` is required but not automatic. Baseline tools can be supplied in `TurnRunnerConfig.tools`. Dynamic tools must be fetched manually and registered:

```ts
const dynamicToolsMiddleware = async (ctx, next) => {
  const tools = await ctx.fetchTools()
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
  await next()
}
```

## Retrieval

Use `Retrievable` for external documents and RAG chunks. Inject standard RAG results in `turnInputPipeline`, not in the executor, unless the task genuinely requires mid-loop search.

Trust tiers are security controls:

- `first-party`: controlled internal content.
- `third-party-public`: public web/API content.
- `third-party-private`: user uploads, private integrations, untrusted private content.

Never label user-supplied or public content as `first-party`. Rank, limit, and truncate retrieval results to fit the context budget.

## Memory

Memory is curated durable fact state, not conversation history and not RAG context.

Memory lifecycle:

1. Load ranked memories by explicitly calling `ctx.fetchMemories()` in `turnInputPipeline`.
2. Add returned `Memory` instances to `ctx.turnMemories`.
3. Write new memories in one audited path: executor, output middleware, or an external background process.
4. Persist lifecycle policy through `storeMemoryCallback`, `mutateMemoryCallback`, and `deleteMemoryCallback`.

Avoid storing raw user text as trusted memory. Store source/trust metadata in the application database because the ADK `Memory` primitive contains content, confidence, importance, and timestamps, not a trust tier.

## Standing Instructions

Standing instructions are `string | Tokenizable`, not instances of a `StandingInstruction` class. Refresh them explicitly with `ctx.refreshStandingInstructions()` when the assembly needs current operator or tenant instructions.