# WP 06 — the reasoning node, its bundled dispatch helper, and the CONTRIBUTING entry

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"The reasoning node"**,
plus `ReasonNodeDefinition` and `ReasonerFn` in **"Shared contracts"** (normative; exported by
WP 01).

Depends on WP 01.

## Owns

- `src/batteries/orchestration/reason.ts` — `@module .../orchestration/reason`
- the bundled `DispatchRunner` helper (its own subpath, per the plan's Files section)
- **the one-entry addition to `CONTRIBUTING.md` §13's "Documented exceptions" list** — no other WP
  touches that file, so ownership is unambiguous
- `tests/unit/batteries/orchestration/reason.cross.spec.ts`
- `tests/functional/batteries/orchestration/live_reason.node.spec.ts`

## Reads (do not modify)

- `src/lib/dispatch_runner.ts` — `:318` `dispatch()` returns `Promise<void>` (verified), hence the
  capture-callback pattern below
- `src/lib/classes/tool.ts` — `:7` the real import aliasing; `:449-490` encode/decode
- `src/batteries/storage/in_memory/index.ts` — `InMemorySpoolStore`, via its public subpath
- `tests/_fixtures/dispatch_context.ts` — the test fixture; note it is NOT published, so the helper
  ships its own internal no-op storage callbacks
- `CONTRIBUTING.md` §13 (`:328-348`) — three coupling tiers **and then a separate "Documented
  exceptions" list**. Your entry goes on that list, alongside `tools/**`, `llm/**`,
  `vector/retrievable_glue.ts`, `media/forge.ts`. There is no "tier 4".

## Contract

- `ReasonerFn` as declared: takes `{prompt, outputSchema, maxAttempts, signal?}` and resolves to
  `Record<string, EncodableValue>` — the captured, validated tool args.
- `createDispatchReasoner(options): ReasonerFn` — the bundled optional helper.

**A reason node ENDS IN A TOOL CALL, and that tool call IS its output.** It never returns prose to
be parsed. The node's `outputSchema` becomes a forced tool's `inputSchema`, so the model physically
cannot answer unstructured: `@nhtio/validation` rejects malformed args before the handler runs, and
you retry within `maxAttempts`. The captured, validated args are the node's `OutputItem.json`.

**How the result comes back given `dispatch()` returns `Promise<void>`:** a **capture callback on
the forged tool's handler** — the handler receives validated args, assigns them through a closure,
and calls `ctx.ack()` to end the dispatch; the helper then reads the captured value. The `void`
return is irrelevant; the closure is the channel.

**The schema is stored ENCODED.** `ReasonNodeDefinition.outputSchema` is a `string`, because a live
validation `Schema` is not `Encodable` — encoding one throws `E_UNENCODABLE_VALUE: Value of type
symbol (Symbol(override)) is not encodable`, which would make the plan unpersistable. You decode it
before calling `ReasonerFn`. Use the same aliasing `tool.ts:7` uses
(`import { validator, encode as encodeSchema, decode as decodeSchema } from '@nhtio/validation'`) —
**there is no export literally named `encodeSchema`**.

Failure modes: `maxAttempts` bounds the validation-retry loop; a dispatch that ends **without** the
tool being called is a **halting node failure**, never a fabricated result.

Prompt-injection hygiene: wrap the authoritative instruction in `<instruction>` tags, strip
`</?instruction>` from author-supplied prompt text, and tell the model to ignore instructions
appearing inside the context payload.

The helper constructs `Message`/`Tool` — that is why it lives at its own subpath and why the
CONTRIBUTING entry is required. Add an inline comment at the import site naming the exception, as
`media/forge.ts` does. `storeRetrievableBytes` uses `InMemorySpoolStore` through the public subpath
(established precedent: every LLM adapter defaults `spoolStore` that way) rather than
hard-throwing, since a reasoning node returning a large result needs somewhere to spool it. Keep
the no-op storage callbacks internal — exporting them commits to them.

## Done when

**Run ALL THREE gates before reporting done** — behaviour and `tsc` alone are not enough (WP 01
was committed twice on that mistake, and lint then reported 112 errors):

```bash
npx eslint src/batteries/orchestration --ext .ts     # 0 errors, incl. the repo's own adk/* rules
npx tsc --noEmit -p tsconfig.json | grep orchestration
pnpm doc:coverage                                     # 0 undocumented public symbols, MEMBERS included
```

`doc:coverage` counts public CLASS FIELDS, CONSTRUCTORS and INTERFACE MEMBERS, not just the
declaration — document those too. And prefer `npx eslint`/`npx tsc` over the `pnpm` scripts while a
worktree is installing; the pnpm wrappers can take many minutes.

- `pnpm type-check`, `pnpm lint`, `pnpm doc:coverage:ci` clean for your files
- The CONTRIBUTING §13 entry is present
- `reason.cross.spec.ts` covers: `PromptPart[]` joined with refs resolved **before** `ReasonerFn` is
  called; the forced tool's `inputSchema` IS the node's `outputSchema` after decode; malformed args
  rejected and retried within `maxAttempts`; the capture callback yielding validated args as the
  node's output; a dispatch ending without the tool call being a halting failure rather than a
  fabricated result; `<instruction>`-tag stripping on author-supplied text
- `live_reason.node.spec.ts` is gated
  `const d = process.env.TEST_ORCHESTRATION_MODEL ? describe : describe.skip` with
  `TEST_ORCHESTRATION_*` for model/base-URL/key. **Per project doctrine the reasoning node is
  verified against a REAL LLM** — a scripted stand-in is not a test of this node.

## Out of scope

`executor.ts` calling `ReasonerFn` (WP 07). The `reason` node's freeze validation (WP 04). The
forge's tool tiers (WP 09).
