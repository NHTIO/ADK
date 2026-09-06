# WP 12 — the barrel, `createOrchestration`, the integration gate

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — `CreateOrchestration` and
`Orchestration` in **"Shared contracts"**, the `RunDeps`/`RunOptions`/`FreezeInputs` precedence
rules, and **"Serialization"** for the encoder precondition.

Depends on WPs 01–11. This is a **real integration gate**, not a grab-bag: you are the assembly
point, and the one place a precondition can be enforced for every operation.

## Owns

- `src/batteries/orchestration/index.ts` — `@module @nhtio/adk/batteries/orchestration`
- `tests/functional/batteries/orchestration/end_to_end.node.spec.ts`
- `tests/smoke/public_api.node.spec.ts` additions (assert the new subpaths import)

## Contract

`createOrchestration(config): Promise<Orchestration>` — the battery's single entry point.
Everything public is reached through the object it returns.

**It is `async` for a reason.** It eagerly `await import('@nhtio/encoder')` and throws
`E_ORCH_ENCODER_REQUIRED` (naming the package and its install command) before any plan can exist.
`@nhtio/encoder` stays an **optional peer of the package** — peer metadata is package-wide, not
subpath-scoped, so making it non-optional would force it on every `@nhtio/adk` consumer including
the many who never import orchestration. So the requirement is enforced where it *can* be: at
construction. Failing there means no plan is ever created, frozen or approved in a deployment
missing the encoder — the property that actually matters. (It is genuinely required: the digest
comes from a lossless canonical encoding, digests are load-bearing in `CreateResult`, `readState`,
every transition, approval binding and `claimRun`, and the algorithm is battery-owned, so a
consumer-supplied store serializer cannot substitute. Even an in-memory store needs digests.)

Also `await load()` on every supplied evaluator cell, so a missing optional peer surfaces at
construction rather than at freeze. A cell supplied per-run is loaded at that point with the same
named error. Validate every registered template at construction (WP 09's `validateTemplate`).

**Dependency precedence, resolved HERE and stated once:** per-run wins **field by field** over
construction; anything absent from both is a named error if the plan needs it. `evaluators`
**merge by cell `id`** (a per-run cell replaces the configured one with the same id, others
survive) because a run legitimately swaps one cell while keeping the rest; everything else
replaces wholesale. `Orchestration.freezePlan` takes `Partial<FreezeInputs>` and you resolve it
before calling WP 04's internal `freezePlan(planId, inputs: FreezeInputs)`.

Assemble `Orchestration` exactly as declared: `freezePlan`, `approvePlan`, `executePlan`,
`instantiate`, `templates()`, `render`, `raw: {plan, ops, diff, outline}`,
`tools(tier: 'front' | 'authoring')`, `readonly store`.

**The barrel must stay environment-neutral: zero `node:*` anywhere in its module graph.** Do
**not** re-export the Lua cell (WP 11) — it is reachable only via its own deep subpath. Do not add
orchestration to `src/batteries/index.ts`; it is deep-import-only, like `dev_tools`, `encoding`,
`media`, `sandbox`, `storage` and `validation`. Check `@module` tags exist on every subpath, since
`bin/utils/index.ts`'s `getEntries` turns them into `package.json` exports.

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

- `pnpm type-check`, `pnpm lint`, `pnpm doc:coverage:ci` clean
- Construction-level assertions pass: `E_ORCH_ENCODER_REQUIRED` when the encoder is unresolvable
  and `E_ORCH_CELL_UNAVAILABLE` when a supplied cell's peer is missing — **both at construction,
  before any plan exists**; a freshly created plan has an **empty** `readOps`, is revision 0, and
  still folds to a complete `RawPlanView` carrying `DEFAULT_PLAN_BOUNDS` with a stable digest, and
  the first authoring op makes revision 1; and the full precedence matrix (no per-run deps uses
  configured; a per-run field overrides its counterpart; per-run `evaluators` merge by id; a
  dependency absent from both on a plan that needs it is a named error, not a silent no-op)
- **`end_to_end.node.spec.ts` is the real proof**, through **public import paths only**: author a
  plan with a branch and a gate, freeze it, render the operator prose, approve, execute, abort
  mid-run, assert the frontier reports the stopping point and classifies the interruption
  resumable, resume, complete, then clone and assert the clone lands `editable`/unapproved/cold
  with the repeats-effects warning in its prose.
  **The plan under test MUST include a `call` → `transform` pair over a real `SpooledArtifact`,
  with the abort falling between them**, so the artifact channel and its handle-based resume are
  exercised end to end — that pairing has the most moving pieces (executor, store, encoder,
  resolver registry) and the least unit-level visibility.
- `runPlanStoreConformance` passes against `in_memory`
- Cross-WP integration: every WP's exported contract matches what its consumers import, and the
  full suite is green

## Out of scope

Re-implementing anything WPs 01–11 own — if something is wrong there, it goes back to that WP's
author. Docs (WP 13).
