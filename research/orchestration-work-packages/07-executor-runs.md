# WP 07 — the executor, run events, the transform runtime

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"The executor"**,
**"Execution state and resumability"** including **"The commit protocol"** and **"The
indeterminate in-flight node"**, the `TransformNodeDefinition` block in **"Shared contracts"**
(especially *"How the transform actually RECEIVES the artifact"*), and `RunEvent`/`PendingFrame`/
`JoinState`/`foldRun`/`RunProjection`. All normative.

Depends on WP 01 (types, `branchKey`, `effectiveToolMethods`), WP 02 (`PlanStore`, `claimRun`,
`appendRunEvents`), WP 03 (the cell seam).

This is the largest WP. The transform runtime and the commit protocol are the two parts where
getting it subtly wrong produces a plausible-looking executor that loses work on resume.

## Owns

- `src/batteries/orchestration/executor.ts`
- `src/batteries/orchestration/runs.ts`
- `tests/unit/batteries/orchestration/executor.cross.spec.ts`
- `tests/unit/batteries/orchestration/runs.cross.spec.ts`
- `tests/unit/batteries/orchestration/transform.cross.spec.ts`
- `tests/unit/batteries/orchestration/commit_protocol.cross.spec.ts`
- `tests/unit/batteries/orchestration/entry.cross.spec.ts`

## Contract

`executePlan(planId, options: RunOptions): Promise<RunProjection>` and
`foldRun(events: RunEvent[]): RunProjection`.

A BFS work-queue over frames. Tool invocation goes through the injected `CallInvokerFn` — not for
dry-run parity (there is no dry run) but so the walker stays unit-testable with no mocks and the
consumer keeps control of how a staged call is dispatched.

**Claim before invoking.** `claimRun` — not the optional lock — enforces one-run-ever; the executor
MUST claim before invoking any node.

**The entry node is materialised first.** Validate `RunOptions.input` against the entry node's
`DeclaredField[]`, then commit it as the entry frame's `node_settled` before any other node runs —
so external input becomes a `NodeOutput` addressable by `NodeRef` like any other, and the resume
fold rebuilds it from events like any other. Invalid input aborts **before any side effect**.

A live frame is `PendingFrame` = `{frame, outputs, artifacts}`. Branches hold **cloned** tables and
cannot see each other's writes. Both tables are keyed `${nodeId}:${branchKey(branchId)}` — always
build the key with `branchKey`, never by interpolating the object.

## The transform runtime — the part with no room for improvisation

A step names the descriptor's **`name`** (`artifact_json_get`), and you invoke that descriptor's
**`method`** (`json_get`) on the instance. The two vocabularies are fully disjoint across all core
descriptors, so a step naming a `method` value is a freeze error, not something to accept leniently.

The instance comes from the frame's **`ArtifactTable`**, populated at `call` settlement when
`CallInvokerFn` returned a `SpooledArtifactLike`. It cannot come from `OutputItem.json`, which is
`EncodableValue`-only — and the instance methods are real async reader-bound methods, so they
cannot run on a plain value. `ArtifactTable` rides on `PendingFrame.artifacts`,
`edge_taken.artifacts`, and `JoinState.arrivals[].artifacts`; it persists as encoder **handles**
(`{tag, locator}`, never bytes) and rebinds on resume via `resolveSpoolReader`. A missing resolver
throws `E_NO_READER_RESOLVER` — surface it as an ordinary node failure **naming the tag**.

**Chaining passes the RAW method return value.** `serialise` returns a string, so chaining through
it would flatten exactly the structure a following `emit:{as:'rows'}` needs as an array. Consult
`serialise` at exactly one point: converting a **final** result into a string for an
`emit:{as:'value'}` field whose declared type is `string` — and where the descriptor supplies none
(which is **every** core descriptor: 7/7/8 carry none), call core's exported `defaultSerialise`
rather than reimplementing its rules.

`ToolResult` narrowing: `string` → the declared single field; `SpooledArtifactLike` → the
`ArtifactTable` entry plus whatever `NodeOutput` its declared `output` describes; bytes/media →
already refused at freeze for a field-declaring node. **A handled failure writes no output AND no
artifact entry**, so a `transform` over a failed attempt cannot read a stale instance.

## The commit protocol (ordering is contract, not implementation detail)

1. **Before invoking**: append `node_entered` and **await the durable write**. Invocation does not
   begin until it has committed.
2. **After settling**: append `node_settled` + every `edge_taken` + the new `frontier_snapshot` as
   **ONE atomic batch**.

Given that order the fold is exact: entered+settled → completed, never re-invoked;
entered-unsettled → in flight; no `node_entered` → never started.

**Only a `call` node is indeterminate.** `branch`/`select` are pure reads over the persisted table
(same inputs, same verdict — which is what the cells' no-clock/no-randomness rule buys);
`transform` is a pure read; `join` restores from the frontier; `reason` costs tokens to repeat but
performs no external effect. All are re-entered unconditionally, so `RunProjection.indeterminate`
contains **only `call` frames**.

**`foldRun` does NOT claim to detect process death.** A dead process's log after a crash mid-call
is `run_started, node_entered` — byte-identical to a healthy executor currently inside that call.
No fold over events can tell them apart, because the difference is liveness, not history. So
return `outcome: 'running'` with **no** `interruption` for that log. Process death reaches the
history only when whoever resumes appends `run_interrupted {kind:'process_death'}`.

Every `RunProjection` field derives from the events alone — no graph, no store, no side channel. A
list whose first event is not `run_started` is malformed and **throws** rather than defaulting.
The frontier comes from the last `frontier_snapshot` then advances: each later `node_settled`
removes its frame, each later `edge_taken` adds its `to` frame **with the `outputs` and
`artifacts` that event carries**. There is deliberately **no** run-wide `artifacts` field.

Edge firing: on success **every** applicable handle fires exactly once, so `always` fires alongside
`match`/`case_*`, and two `always` edges enqueue two successors. On failure **only** `error` fires
— `always` does NOT (it is a success-path edge, not a finally). `default` fires only when nothing
matched. A node that throws **with** an `error` edge is a **handled failure**: record the failure
outcome, traverse the edge, and the run's final outcome may still be `completed`. With no `error`
edge it halts.

Cycle detection at runtime is defence in depth (freeze already refused cycles): each frame carries
its own ancestor path, and re-entering a node already on **that frame's** path is a true cycle,
while a diamond fan-in is not. Deliberately **not** a global per-node visit counter — the prior
art's `MAX_NODE_VISITS = 10` trips a legitimate diamond fan-in and then reports "Cycle detected",
naming the wrong cause. A separate total-steps bound reports itself as **budget exhaustion**, not
as a cycle.

Join correlation: the barrier key is the arriving route **truncated at the statically-known fork**.
Fire when `arrivals.length === required`; a repeat of the same `(branchKey, edgeId)` is
idempotent. A `branch` inside a diamond that leaves a route unfired settles the run `halted` with
`{kind:'join_unsatisfiable', nodeId}` once no live frame can still reach it — not a hang. The
merged frame's identity **retains the correlation prefix** and appends
`{join: nodeId, of: sorted(ALL incoming edge ids)}`; a bare join segment is a graph constant and
would collide across fork executions. Emit one `OutputItem` per arrival carrying
`{via, from, branch}`, sorted by `via` then `branch`.

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
- All five spec files pass, covering everything the plan's Tests section lists for them. The
  non-obvious must-haves: `entry→a`, `entry→b`, `a→c`, `b→c` yields **two distinct outputs for
  `c`** that do not collide (an edge-ordinal scheme would key both `0`); the full join-correlation
  block; killing between `node_entered` and the settlement batch yields **exactly one**
  indeterminate node while killing after the batch yields none; a graph mixing `retry`/`halt`/
  `skip` across three interrupted calls resolves each differently **in one resume**;
  `run_started, node_entered` folding to `running` with **no** `interruption`; the artifact channel
  asserted with a **real** `SpooledJsonArtifact` over an `InMemorySpoolReader` (a plain-value
  stand-in must fail); artifact handles surviving a resume, and `E_NO_READER_RESOLVER` naming the
  tag when no resolver is registered; and the raw-chaining assertion (a two-step chain whose first
  step returns an array and second consumes it as an array)

## Out of scope

`validation.ts`/freeze (WP 04) — assume a frozen plan is valid, and keep only the defence-in-depth
runtime cycle detector. `render.ts` (WP 08). The forge (WP 09). Do not implement `ReasonerFn` or
any cell — call the injected seams.
