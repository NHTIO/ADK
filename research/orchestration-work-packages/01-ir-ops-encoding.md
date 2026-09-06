# WP 01 — IR, ops, encoding, digest, artifact-method union

**Read first:** `research/orchestration-work-packages/shared-contracts.md` — the ONLY normative source for
every type here, extracted verbatim from the approved design plan. Do not restate or redesign a
type it fixes; where any other prose disagrees with it, it wins.

**Do NOT open `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md`.** It is 225KB and reading it
will exhaust your context before you write any code. Everything you need is this spec plus
`shared-contracts.md`. If something seems missing, implement what these two files state and say so
in your report rather than going looking.

You are wave 1. Every other work package depends on you, so getting the exported surface exactly
as the plan states it matters more than anything else you do.

## Owns

- `src/batteries/orchestration/types.ts`
- `src/batteries/orchestration/plan.ts`
- `src/batteries/orchestration/exceptions.ts`
- `src/batteries/orchestration/ops.ts`
- `src/batteries/orchestration/encoding.ts`
- `src/batteries/orchestration/artifact_methods.ts`
- `package.json`, `pnpm-lock.yaml` (peer entries only — see "Peers")
- `tests/unit/batteries/orchestration/ops.cross.spec.ts`
- `tests/unit/batteries/orchestration/plan_ir.cross.spec.ts`
- `tests/unit/batteries/orchestration/encoding.cross.spec.ts`
- `tests/unit/batteries/orchestration/artifact_methods.cross.spec.ts`
- `tests/unit/batteries/orchestration/branch_key.cross.spec.ts`

## Reads (do not modify)

- `src/lib/classes/tool.ts` — `:449-490` is the encode/decode pattern to copy; `:7` shows the
  real import aliasing (`encode as encodeSchema`) — `@nhtio/validation` exports `encode`/`decode`,
  there is NO export named `encodeSchema`
- `src/lib/classes/spooled_artifact.ts` — `:56-70` `ToolMethodDescriptor`; `:232-250` the
  shadowing rule; `:129` the exported `defaultSerialise`
- `src/lib/classes/spooled_json_artifact.ts`, `src/lib/classes/spooled_markdown_artifact.ts`
- `src/lib/utils/canonical_json.ts` — **do not use it for the digest**; read it to understand why
- `src/batteries/encoding/index.ts` — `registerAdkEncodables()` is the pattern for
  `registerOrchestrationEncodables()`
- `src/batteries/dev_tools/exceptions.ts` — the exact `createException` shape to copy

## Contract (what other WPs import)

Everything the plan's **"Shared contracts"** section declares, exported from `types.ts` and
re-exported where natural. Each type is defined EXACTLY ONCE. In particular:

- Identity/lifecycle: `PlanState`, `PlanId`, `NodeId`
- Values: `EncodableValue`, `ArgValue`, `NodeRef` (a registered encoder **class**), `ParamRef`
- Routes: `RouteSegment`, `BranchId`, `branchKey` (length-prefixed, injective)
- Outputs: `OutputItem`, `NodeOutput`, `OutputTable`, `ArtifactTable`
- Nodes: `PlanNodeKind`, `EdgeHandle`, `PlanEdge`, `DeclaredField`, all seven `*NodeDefinition`s,
  `PlanNode`
- Ops: `PlanOp`, `PlanBounds`, `DEFAULT_PLAN_BOUNDS`
- Artifact seam: `ArtifactMethodDescriptor`, `ArtifactClassLike`, `SpooledArtifactLike`,
  `MediaLike`, `ToolResult`, **`effectiveToolMethods`**
- Views: `RawPlanView`, `PlanSummary`, `PlanIssue`, `PlanDiff`, `PlanProvenance`, `ClonedFrom`,
  `InstantiatedFrom`
- Run events: `FrameRef`, `NodeOutcome`, `RunEvent`, `PendingFrame`, `JoinState`, `RunProjection`,
  `InterruptionCause`
- Seams (types only — implementations belong to other WPs): `CallInvokerFn`, `ReasonerFn`,
  `PredicateEvaluator`, `PredicateContext`, `PredicateVerdict`, `InvocableTools`, `FreezeInputs`,
  `RunDeps`, `RunOptions`, `ExecutePlanFn`, `AuthorityClaim`, `AuthorityVerb`, `ApprovalRecord`,
  `PlanTemplate`, `TemplateNode`, `TemplateArgValue`, `TemplateDefinitionOf`, `InstantiateResult`,
  `CreateOrchestration`, `Orchestration`

Plus your own implementations:

- `foldOps(ops: PlanOp[]): RawPlanView` — deterministic fold, seeded from `DEFAULT_PLAN_BOUNDS`
  (bounds are the fold SEED, never an op; a fresh plan has an EMPTY log, is revision 0, and still
  folds to a complete view with a stable digest)
- `planDigest(view: RawPlanView): string` — see "The digest" below
- `registerOrchestrationEncodables(): void`
- `effectiveToolMethods(ctor: ArtifactClassLike): readonly ArtifactMethodDescriptor[]`
- `branchKey(b: BranchId): string`
- battery-scoped exceptions via `createException` from `@nhtio/adk/factories`, including
  `E_ORCH_ENCODER_REQUIRED` and `E_ORCH_CELL_UNAVAILABLE` (thrown by WP 12/03 — you declare them)

## The digest (the sharpest requirement — get this right first)

Every approval binds to it, so it MUST be lossless over the whole `EncodableValue` domain.

**Do NOT use `canonicalStringify`.** It walks objects with `Object.keys`, and `Date`, `RegExp`,
`Map`, `Set` have no enumerable own keys, so it collapses each to `{}`. Verified:
`{pattern: /^inv-\d+$/i, when: 2025-01-01, m: Map{k→1}}` and
`{pattern: /^cust-\d+$/, when: 2099-12-31, m: Map{z→9}}` both canonicalise to
`{"m":{},"pattern":{},"when":{}}` — byte-identical. An approval bound to that would authorise a
plan the operator never saw.

Instead: `sha256` (`js-sha256`, already a dependency) over a canonical **encoding**.
1. First determine empirically whether `@nhtio/encoder`'s `encode()` is key-order deterministic —
   `encoding.cross.spec.ts` settles it: build one plan two ways with keys inserted in different
   orders and compare. If it is, hash `encode(view)` directly; it is lossless by construction.
2. If it is not, recursively sort **plain-object keys** first and then `encode()` — sorting the
   plain skeleton only, never replacing the encoder's representation of `RegExp`/`Date`/`Map`/
   `Set`/typed arrays.

Invariant to test both ways: two plans differing only in a non-JSON-representable staged argument
MUST differ in digest; two differing only in key insertion order MUST NOT.

## `effectiveToolMethods` — the shadowing trap

`static toolMethods` **shadows**; subclasses do NOT concatenate. Verified against the real classes:
`SpooledJsonArtifact.toolMethods.length === 7` and does **not** contain `artifact_head`; the
static-prototype-chain union is 14 (Markdown 15). There is no core helper that unions the chain.

So walk it: for each class from the leaf up via `Object.getPrototypeOf`, take its OWN
`toolMethods` (`Object.getOwnPropertyDescriptor`, so an inherited static is not counted twice),
collect leaf-first, dedupe by `name` with **nearest class wins** (matching the documented
`Tool.onCollision = 'replace'`). A class with no `toolMethods` anywhere yields `[]`.

Note the two disjoint vocabularies: `name` is the absolute LLM-facing tool name
(`artifact_json_get`, always snake_case), `method` is the instance method (`json_get`; three base
ones are camelCase — `byteLength`, `lineCount`, `estimateTokens`). Verified fully disjoint across
all 22 core descriptors. A `transform` step names the **`name`**.

## Peers

Add to `package.json` `peerDependencies` with `peerDependenciesMeta.<dep>.optional: true`:
`jexl ^2.3.0`, `wasmoon ^1.16.0`, and `fengari ^0.1.5`. All three land HERE, up front, because
WPs 10 and 11 run concurrently and must not both edit `package.json`. Confirmed absent today.
`@nhtio/encoder` stays an optional peer (package-wide metadata; the requirement is enforced at
construction by WP 12, not by the peer map). **No `vite.config.mts` edit** — it already
externalises every peer.

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

- Every type in the plan's Shared contracts is exported and defined exactly once
- `pnpm type-check`, `pnpm lint`, `pnpm doc:coverage:ci` clean for the files you own
  (`doc:coverage:ci` fails on ANY undocumented public symbol — full TSDoc as you go)
- Your five spec files pass. They must include, from the plan's Tests section: `branchKey`
  injectivity (an edge id containing `>`, one shaped like a join rendering, one equal to two
  others concatenated — all distinct); fold determinism and every structural collision including
  **two ops from ONE actor at the SAME lamport** (the `opId` tiebreak, arrival-order independent);
  the taint rules incl. the echo-node non-laundering case; the digest invariant both directions;
  a whole plan with a `reason` node round-tripping (the schema STRING survives); decode without
  `registerOrchestrationEncodables()` failing loudly; a cyclic staged value refused
  (`E_CIRCULAR_REFERENCE`) as well as out-of-subset values; and `effectiveToolMethods` asserted
  against the **real** core classes (so a core shadowing change fails here), incl. that
  `SpooledJsonArtifact`'s effective set contains `artifact_head` while its own `toolMethods`
  does not

## Out of scope (other WPs own these — do not create them)

`store.ts`/`in_memory.ts`/`conformance.ts` (WP 02) · `predicates.ts`/`cells/**` (03, 10, 11) ·
`validation.ts` and freeze (04) · `approval.ts` (05) · `reason.ts` (06) ·
`executor.ts`/`runs.ts`/`transform.cross.spec.ts` (07) · `render.ts`/`raw.ts`/`outline.ts` (08) ·
`forge.ts`/`templates.ts` (09) · `index.ts` and `createOrchestration` (12) · docs (13).
Declare the exceptions other WPs throw, but do not implement their throw sites.
