# WP 08 — the prose renderer, the raw view, the scoped reading surface

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"The prose renderer"**
(including **"The raw view"**), **"Phases, and how a small model works on a plan it cannot hold"**,
and `PlanOutline`/`PhaseEntry`/`PlanSlice`/`PlanDiff`/`RawPlanView` in **"Shared contracts"**.

Depends on WP 01 (types, `foldOps`), WP 02 (`PlanStore` — `raw.ts`/`outline.ts` read through it),
WP 07 (`RunProjection` for the `as_executed` view).

**The renderer is load-bearing: there is no dry run.** This is what the operator reads at the
approval gate and what a model reads to re-consume a plan it did not author. Brevity is not a
virtue here — an operator approving a plan they cannot fully see is the failure this replaces.

## Owns

- `src/batteries/orchestration/render.ts` — `@module .../orchestration/render`
- `src/batteries/orchestration/raw.ts` — `@module .../orchestration/raw`
- `src/batteries/orchestration/outline.ts` — `@module .../orchestration/outline`
- `tests/unit/batteries/orchestration/render.cross.spec.ts`
- `tests/unit/batteries/orchestration/raw.cross.spec.ts`
- `tests/unit/batteries/orchestration/outline.cross.spec.ts`

## Reads (do not modify)

- `src/lib/classes/spooled_markdown_artifact.ts` — `artifact_md_sections` is the closest existing
  analogue and shows the two-call shape to copy AND the mistake to avoid (it returns a semantic
  label then requires the body by **line arithmetic**)
- `bin/build_ask_adk_index.ts` — `:117` records the re-cite loop; the `headingPath` breadcrumb is
  the model for a self-locating slice

## Contract

- `renderPlan(plan, options): string` where options is
  `{audience: 'operator' | 'model', view: 'as_planned'}` or `{audience, view: 'as_executed', run}`
  — **one renderer, the run as an argument**. A pure function of its arguments: no store access.
- `rawPlan(planId, opts?: {revision?})`, `rawOps(planId, opts?)`,
  `rawDiff(planId, a, b)`, `planOutline(planId)`, `planRead({phase})` / `planRead({node})`

## The renderer

Two audiences × two views. Operator + `as_planned` is what the approval gate shows: **every** side
effect with its tool and arguments, **every** authority claim, **every** condition with the exact
predicate, in traversal order, with branch structure legible.

**Arguments at approval time are STAGED, not resolved — and the renderer must say which.** A
`NodeRef` resolves from the `OutputTable`, which only exists during a run; approval happens before
any run and there is no dry run to populate it. So a literal renders as its value and a `NodeRef`
renders as its **provenance** — never as a fabricated value, never silently as though known:

```text
  3. CHANGE — move_drive_file(
                from: ← every file found by step 1 (list_drive_files)
                to:   "Archive/2024")
```

That is a real property, not a limitation to apologise for: the operator is approving what the plan
will do with whatever step 1 finds, and the **authority claim** is the bound on that — which IS
fully known at approval time.

Render each `call`'s recovery behaviour, since it is inside the approved digest: "if interrupted
mid-call, this step will be retried" / "…will stop and wait for you". **`skip` must render its
consequence** — downstream nodes proceed against a step whose effect is unknown — rather than
reading as a clean recovery.

For a **clone**, state that the parent already completed nodes X, Y, Z and that approving will
perform them **again**. Read that list from `PlanProvenance.completedAtClone` (snapshotted by
`clonePlan`), which is what keeps the renderer pure.

An **abort point renders as an abort**, never as a confirmation prompt — there is no mid-run gate.

The operator view is a **separate display projection**, not the execution payload: no model-written
free text rendered as fact, no raw machine identifiers, and exhaustiveness-checked with
`const exhaustive: never` so a new node kind cannot silently render as nothing.

Properties: **deterministic** (same plan + options ⇒ byte-identical output) and **total** (every
node kind renders). It is **not reversible** — there is no prose parser, and `render(parse(s)) === s`
is not promised because `parse` does not exist.

## The raw view

Data, not prose, for a UI showing an IDE-like diff. Three properties the prose views deliberately
lack: **not audience-adapted**, **stable** (a given revision folds to the same bytes forever —
which is what makes a digest meaningful), and reachable both as a tool and as a plain exported
function for a UI that talks to `PlanStore` directly.

`RawPlanView` carries **no lifecycle `state`**: state is not a `PlanOp`, so it cannot be folded
from the log, and a historical revision has none to report. That lives in `readState()`. A view at
revision 7 answers "what did the content look like then", not "what state was it in then". Serve a
historical view from `readOps({throughRevision: N})`; `provenance` comes from `readProvenance`.

## The scoped reading surface

**ONE flat outline level. Never two.** Not a style preference: the controlled study
(arXiv 2607.17598) found one routing level helps and a second *"never helps and sometimes breaks
accuracy outright"* (0.9126 → 0.6398 on one cell), because in a two-level pack every child
description sits in context before the router commits.

**Entries carry exact surface forms, not paraphrase** — per the same study, a short summary *plus* a
key-element list, because the element list supplies *"exact surface forms that a one-sentence
summary would paraphrase away."* Decisive here: a model writing `NodeRef{node: 'archive_files'}`
needs the **exact node id**. So each entry carries verbatim: phase name, node count, **node ids**,
each `call`'s **tool name**, open-issue count, and a one-line summary.

**The outline's key IS the reader's key.** `planRead({phase})` / `planRead({node})` take **the same
identifiers the outline printed**. **No line numbers anywhere** in the plan-reading surface — every
translation the model performs between index and reader is a place it can be wrong.

**Each slice is self-locating**: it carries its phase and its immediate predecessors/successors, so
the model can keep linking without re-fetching the outline.

**Scoped reading is available, not mandatory.** The study's own conclusion is that progressive
disclosure *"buys context, not intelligence"* — redundant when the agent can navigate directly. So
`get_plan()` with no argument still returns everything; the outline is what a model reaches for
when that stops fitting.

`phase` and `node` in any reader schema are a **closed enum** over the live plan
(`validator.string().valid(...ids)`), so a stale or invented id is a schema error naming the valid
set rather than an empty result the model might surface as an answer.

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
- The three spec files cover what the plan's Tests section lists, notably: snapshots of both
  audiences × both views; exhaustiveness over node kinds; the clone-repeats-effects warning;
  determinism; an abort rendering as an abort; a `NodeRef` arg showing **provenance** in
  `as_planned` and a **resolved value** in `as_executed`; the outline being ONE flat level asserted
  **structurally**; node ids byte-equal to what a `NodeRef` must cite; `planRead` accepting exactly
  the printed identifiers; a stale id being a schema error naming the valid set; a slice's
  `boundary` sufficing to link without a second read; **a mutation's prose return bounded — its
  size does not grow with plan size**; `rawPlan` carrying no `state`; a revision the log never
  reached rejected; and `rawDiff` across an unfreeze→edit→refreeze round matching the applied ops

## Out of scope

The forge tools that expose these (WP 09) — you export the functions, WP 09 wraps them. The
executor (WP 07). Docs prose (WP 13).
