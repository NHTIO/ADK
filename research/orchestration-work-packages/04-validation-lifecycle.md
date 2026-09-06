# WP 04 — submit-time validation and the lifecycle machine

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"The lifecycle, which
carries the design"**, **"The submit gate"** (inside "The tool surface"), the topology invariants
beside `PlanEdge`/`EntryNodeDefinition`/`JoinNodeDefinition` in **"Shared contracts"**, and the
taint rules in **"Dataflow"**. All normative.

Depends on WP 01 (types, `foldOps`, `planDigest`, `effectiveToolMethods`), WP 02 (`PlanStore`,
`transition`), WP 03 (the `PredicateEvaluator` seam).

**You do NOT depend on WP 09.** You take the Tier-C allowlist as an injected `InvocableTools` —
that TYPE is WP 01's, and WP 09 supplies an instance at call time. Never import from `forge.ts`.

## Owns

- `src/batteries/orchestration/validation.ts`
- the lifecycle machine (freeze / unfreeze orchestration over `PlanStore.transition`)
- `tests/unit/batteries/orchestration/lifecycle.cross.spec.ts`

## Reads (do not modify)

WP 01's `types.ts`/`ops.ts`/`artifact_methods.ts`; WP 02's `store.ts`; WP 03's `predicates.ts`.

## Contract

- `freezePlan(planId, inputs: FreezeInputs): Promise<{ok: boolean; issues: PlanIssue[]}>` — the
  INTERNAL entry point, taking **fully-resolved** inputs. (The public
  `Orchestration.freezePlan` takes `Partial<FreezeInputs>`; WP 12 resolves against construction
  config and calls you. Resolution happens once, at the assembly point — not here.)
- `unfreezePlan(planId): Promise<TransitionResult>` — free, no checks.

**The battery validates; the store commits.** Run the submit checks, and only on a clean pass call
`transition(editable → reviewable, {expectedDigest})`. The digest is what makes that safe rather
than racy: you validate content at digest D, the store commits only if the plan is still at D, so
a concurrent edit invalidates the transition instead of slipping past an already-passed check.

Every refusal is a `PlanIssue` with a **stable `code`**, a **model-addressed `message` naming the
fix**, the `nodeId`/`edgeId` where applicable, and `severity: 'blocking' | 'advisory'`. Blocking
issues refuse the freeze. Never a silent no-op — that is the giveon lesson this closes.

## The submit checks (all over the folded graph)

Topology:
- **exactly one `entry` node** (zero means nothing can start; two means `executePlan` cannot tell
  which to materialise, and it takes no entry argument by design), with **no incoming edges**
- every other node **reachable** from entry
- **acyclic over EVERY handle**, `error` and `default` included — an `error` edge back to an
  ancestor is still a cycle because it can still execute. Topological sort; the refusal names the
  closing edge. A diamond fan-in must PASS.
- **every `join` is a diamond**: its fork is its **immediate dominator**; there must be **more than
  one distinct fork→join route**; the fork→join region must contain **no node with in-degree > 1
  other than the join** (no reconvergence) and **no nested join**. `required` is DERIVED as the
  route count, never authored. Two degenerate shapes must be refused: `entry→a→join` (one route)
  and `fork→left|right→shared→join` (reconverged, so the dominator slides to `shared`).
- **every edge id matches `/^[A-Za-z0-9_-]{1,64}$/`** so `branchKey` cannot be forged; edge-id
  **uniqueness** is a freeze-time invariant (NOT append-time — the fold resolves a collision by
  LWW so it stays convergent, and the loser surfaces here as an issue naming both)
- **node ids are validated snake_case, no `/`, no leading `.`** — the re-cite-loop guard: a
  path-shaped id gets copied by a small model as a citation
- **handle applicability** per source kind, exactly as the plan tabulates; a `select` node **must**
  have a `default` edge (a `branch` need not — `match`/`no_match` already exhaust it)

References and dataflow:
- a `NodeRef` naming a missing node, or a field the target does not declare
- a `first`/`last` selection resolved **across a `join`** (we ship no automatic pairing, so we
  cannot ship its failure mode — n8n's "can't determine which item to use")
- an **omitted `branchId`** where the graph admits more than one path to the referenced node
  (decidable statically — count paths); clean when only one path reaches it
- **taint**: external input at `entry` is tainted and propagates transitively; a tainted reference
  may reach a `reason` prompt but **not** a `call` node's `args`. Declassification is **only** via
  a `call` node's `declassifies` field — type validation is NOT sanitisation, so an echo node that
  reproduces an entry string unchanged must NOT launder it. A `reason` node cannot declassify at
  all. Taint is computed HERE, at freeze — it is a static property of the graph.
- a staged value outside the `EncodableValue` subset (a `Function`, an `Error`, an unregistered
  custom class), **and a CYCLIC value inside it** — type membership does not imply encodability;
  either walk with a seen-set or simply attempt the encode you are about to need and surface a
  thrown `E_CIRCULAR_REFERENCE` as the issue

Nodes:
- a `call` naming a tool absent from tier C (`invocable.has`), refused **naming what IS available**
  (`invocable.names()`)
- a `call` with `replaySafe` or `onIndeterminate` unset (both required, no defaults)
- **`onIndeterminate: 'retry'` together with `replaySafe: false`** — a contradiction: asserted
  unsafe to repeat *and* to be repeated. This is the check that makes two fields worth having.
- a `branch`/`select` with **no wired evaluator cell**; also `await load()` on every wired cell
  here, so a missing optional peer surfaces at the freeze boundary rather than mid-run. Delegate
  predicate shape checks to the cell's own `validate(node)`.
- a `transform` whose `steps[].name` is absent from
  `effectiveToolMethods(returns(tool).artifactClass)` — refused **naming the legal set**; whose
  `args` fail that descriptor's own `argsSchema`; or whose source tool's `returns()` is
  `undefined` (refuse naming the tool — never guess a class). **Call WP 01's
  `effectiveToolMethods`; do not re-derive the chain union** — `toolMethods` shadows, so the leaf
  static alone would wrongly exclude the base seven.
- a `Media`/`Uint8Array`-returning tool feeding a field-declaring node
- an **unedited scaffold placeholder** (exact string match — cheap and effective against a model
  that filled in structure but not intent)
- an **unreachable `call` node** (the reachability check; the authority set is the union over
  **reachable** calls only). Implement this **twice, in independent derivations**, with a comment
  saying why that is not dead code: the bug this family guards shipped **twice** in the prior art.

There is **no** "or passes through a gate/condition" clause anywhere — a linear write plan with no
`branch` at all must PASS. And there is no approved-set comparison here: approval is created only
by the later `reviewable → executable` transition, so the set-equality check is WP 05's.

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
- `lifecycle.cross.spec.ts` covers every legal transition; an illegal pair as a **type** error
  (`@ts-expect-error` on a `TransitionRequest` the union forbids) and a BYO store answering
  `illegal_transition` over a wire; a cycle closed by an `error` edge refused while a diamond
  fan-in passes; `select`-without-`default` refused while `branch`-without-`default` passes; zero
  and two `entry` nodes refused, and an incoming edge to entry; a handle illegal for its source
  kind (`case_x` out of a `branch`); the taint suite (tainted ref into `call.args` refused while
  the same ref in a `reason` prompt passes; the **echo node does not launder**; a `declassifies`
  field clears taint and its siblings do not; a `reason` node cannot declassify); out-of-subset AND
  cyclic staged values refused; both join degenerate shapes refused and the canonical diamond
  accepted; digest invalidation across unfreeze→edit→refreeze; a clone landing
  `editable`/unapproved/cold; and the A/B stale-approval interleaving

## Out of scope

`approval.ts` and the authority set-equality check (WP 05). The executor's runtime cycle detector
(WP 07). The forge and the allowlist's contents (WP 09) — you consume the `InvocableTools` type
only. Do not touch `store.ts`.
