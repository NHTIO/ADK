# WP 02 — PlanStore, lock seam, in-memory reference store, conformance suite

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — the **"`PlanStore`"**
section is normative for every signature here, and **"Shared contracts"** for every type you
consume. Do not redesign a type either section fixes.

Depends on WP 01. Import its types; do not redeclare them.

## Owns

- `src/batteries/orchestration/store.ts` — the `PlanStore` contract + result unions
- `src/batteries/orchestration/locks.ts` — `PlanLock` / `PlanLockFactory` seam (BYO, optional)
- `src/batteries/orchestration/in_memory.ts` — the reference store
- `src/batteries/orchestration/conformance.ts` — `@module .../orchestration/conformance`
- `tests/unit/batteries/orchestration/store_conformance.node.spec.ts` — runs the suite against
  `in_memory`

## Reads (do not modify)

- `src/batteries/vector/conformance/index.ts` — the precedent for a shipped conformance suite with
  `vitest` as an optional peer (already `^4.1.5` optional; do not add it)
- `src/batteries/storage/in_memory/index.ts` — deep-import conventions
- WP 01's `types.ts`, `ops.ts` (`foldOps`, `planDigest`), `encoding.ts`

## Contract

Exactly the `PlanStore` interface the plan declares, plus `CreateResult`, `AppendResult`,
`TransitionRequest`, `TransitionResult`, `ClaimRunResult`, `PlanLock`, `PlanLockFactory`,
`InMemoryPlanStore`, and `runPlanStoreConformance(makeStore)`.

**Every method is async.** No sync-or-async unions anywhere.

Four properties that are the whole point of this WP:

1. **`appendOps` rejects unless the plan is `editable`, checked in the SAME commit as the append.**
   `transition()` cannot enforce this — it is not on the append path. Without the check, ops could
   change a frozen plan's content and digest while its stored state stayed frozen, and in the
   `executable` case the `ApprovalRecord` would remain bound to the PRIOR digest — making the plan
   executable with content never approved. Return `not_editable` with the actual state rather than
   throwing, so a stale writer learns what happened.
2. **`transition()` is the ONE atomic lifecycle operation**, deliberately narrow: it proves the
   plan is in `expected.state` at `expectedDigest`, checks the target is a legal successor, and
   applies it — persisting `approval` in the SAME commit for `reviewable → executable`. It returns
   the losing outcome rather than throwing. It does **not** evaluate policy: deciding "is an
   evaluator wired", "is this tool on the allowlist", "does this reference taint a call arg" is
   battery knowledge a BYO store has no access to. The battery validates; the store commits.
   `TransitionRequest` is a discriminated union over the legal pairs so an illegal target is a type
   error at the call site — but a BYO store handed a malformed request over a wire still answers
   `illegal_transition` at runtime.
3. **`claimRun`** — not the lock — enforces "one plan, at most one run, ever". Without
   `resumeRunId` it succeeds only if no run was ever claimed; with one it re-enters that specific
   run and succeeds only if that run exists and is not settled. That contractual difference
   between a permitted re-entry and a prohibited second run is why a start-only operation is
   insufficient.
4. **`appendRunEvents` takes an ARRAY and commits it atomically as a batch.** The commit protocol
   depends on it: `node_settled` + every `edge_taken` + the new `frontier_snapshot` are ONE commit.
   A backend that cannot do this is not conforming.

`readOps` supports `throughRevision` (a REVISION PREFIX — a Lamport value is not a revision
selector; without it a conforming store could not serve `rawPlan({revision})` or `rawDiff` at all)
and rejects a revision the log never reached. `createPlan` mints at revision 0 with a genuinely
**empty** op log — bounds are the fold seed, not an implied op, so `readOps` on a fresh plan
returns `[]` and the first authoring op makes revision 1.

## The lock seam — state its strength honestly

Verrou-shaped (`https://verrou.dev/docs/api`), BYO and **optional**, and for **execution only**:
editing is deliberately multi-writer (the op log converges), so editing takes no lock.

It is **coordination, not mutual exclusion**, and neither the TSDoc nor the docs may claim
otherwise. A TTL lease without a fencing token cannot stop a partitioned or GC-stalled holder
continuing past expiry while a second executor legitimately acquires it. Do **not** add a fencing
token — that would change every `PlanStore` implementation. The residual (a double-invoked node)
is handled by the per-node `onIndeterminate` and `replaySafe` fields.

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
- `runPlanStoreConformance` passes against `in_memory` and asserts ALL of:
  - an append refused in `reviewable` AND in `executable` (`not_editable`)
  - the settlement batch commits atomically, asserted by killing between the two appends
  - **the stale-approval interleaving is refused**: actor A reads `reviewable`@D1 → actor B
    unfreezes, edits, refreezes to D2 → A's approval for D1 is refused by `transition`
  - `createPlan` refuses a duplicate id
  - `clonePlan` yields `editable`/unapproved/no-run with parent provenance, atomically
  - **`claimRun` succeeds exactly once** — two concurrent claimants, one `ok`, one
    `run_already_claimed` carrying the existing `runId`
  - a round-tripped `frontier_snapshot`/`edge_taken` **preserves artifact HANDLES** — the frame
    returns with an `artifacts` entry whose reader rebinds and re-reads (assert the property, not
    the representation; the encoding is the store's business)
  - `readOps({throughRevision})` serves a historical prefix and rejects an unreached revision

## Out of scope

`validation.ts` and the freeze checks (WP 04) — you commit, you do not validate. `approval.ts` and
the authority-set recomputation (WP 05). The executor (WP 07). Everything else per the plan's WP
table.
