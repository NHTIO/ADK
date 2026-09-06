# WP 13 — documentation

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — the **"Docs"** section
lists the required pages, and the whole plan is your source material.

Depends on WP 12 (the final shape). Docs are their own WP because they depend on every other WP's
final shape and are a different kind of work from the code.

## Owns

- `docs/batteries/orchestration/index.md` — the hub
- `docs/batteries/orchestration/{lifecycle,plan-ir,predicates,execution-state,prose,approval,agent-tools,store}.md`
- `docs/assembly/batteries-orchestration.md`
- sidebar entries in `docs/.vitepress/config.mts` under **Featured Batteries**

## Reads (do not modify)

- `docs/batteries/dev-tools/index.md` — the model for a featured-battery hub: frontmatter, then the
  `<llm-only>` dense-fact block, then narrative with runnable examples
- the shipped source, for accuracy — **every claim must match the code as merged**

## The hub's shape

Frontmatter (`title`, `description`), then the `<llm-only>` block wrapped in the
`<!-- markdownlint-disable MD033 -->` / `-enable` pair as `dev-tools` does. That block carries the
dense facts: entry point (`createOrchestration`, **async**), every subpath, required vs optional
config, the seven node kinds, the six edge handles, the three-state lifecycle, what is BYO, and
every exception name.

Then narrative and runnable examples. Follow the house voice: state opinions **as** opinions
(`::: warning We are about to state an opinion`), and document honest limits rather than eliding
them.

## The limits that MUST be documented, in these words or stronger

- **The lock is coordination, not mutual exclusion.** A TTL lease without a fencing token cannot
  stop a partitioned or GC-stalled holder continuing past expiry. The residual — a double-invoked
  node — is handled by per-node `onIndeterminate` and `replaySafe`.
- **`foldRun` does not detect process death.** A crashed executor's log is byte-identical to a live
  in-flight call; the difference is liveness, not history. An abandoned run reads `running` until
  someone resumes it and appends `run_interrupted{process_death}`.
- **Convergence is not semantic merge.** Two actors rewiring one branch converge on a graph neither
  intended; the freeze refuses it loudly, but it cannot restore intent, and no CRDT can.
- **Registering a durable store's reader resolver is load-bearing for resume**, not optional
  hygiene — a `transform` over an artifact fails naming the tag without it. In-memory and fetch
  resolvers auto-register; durable ones the consumer registers, because only they hold the live
  binding a serialised locator cannot carry.
- **`registerOrchestrationEncodables()` must run before any `decode()`.** `encode()` works without
  it; `decode()` throws on every ADK primitive. Hydration without it fails loudly rather than
  silently returning a plain object.
- **Which cells a browser consumer can use**: structured and jexl **yes**, Lua **no** (Node-only —
  it needs `worker_threads` and `SIGKILL`).
- **jexl is frozen** (last published 2022-06-19) — stable, tiny, expression-only, but a dependency
  that no longer moves. A conscious choice, not an assumption.
- **wasmoon's count hook and allocator cap are undocumented at its TypeScript surface**, so the
  cell probes them against canaries at construction and falls back to watchdog-only, reporting the
  reduced guarantee.
- **No dry run.** The deterministically rendered prose is what explains a plan — which is why the
  renderer is load-bearing.
- **Arguments are STAGED at approval time**, so a `NodeRef` renders as provenance, not a value. The
  authority claim is the bound the operator actually approves.
- **A template cannot launder its own parameters** — the narrow, true invariant. It does *not* track
  a value's template origin through arbitrary later edits, because nothing in a freely-mutable
  graph can.
- **`prospective()` was considered and rejected**, and the per-node digest cut — record both as
  considered, not overlooked.

`docs/assembly/batteries-orchestration.md` shows how to wire it into a runner end to end.

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

- `pnpm doc:coverage:ci` clean, and the docs build (`pnpm docs:build`) succeeds
- Sidebar entries present under Featured Batteries
- Every code example actually runs against the merged code — no invented option names, no
  aspirational APIs. **A doc example that does not run is worse than no example**, and this repo
  has paid for that before (a prompt naming tools that did not exist cost real round-trips).

## Out of scope

Changing any source file. If the docs cannot be written accurately because the code disagrees with
the plan, report it — do not paper over it in prose or "fix" the code.
