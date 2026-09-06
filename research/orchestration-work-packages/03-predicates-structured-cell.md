# WP 03 — the predicate seam and the zero-dependency structured cell

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"Predicates and the
evaluator seam"**, plus `PredicateEvaluator`/`PredicateContext`/`PredicateVerdict` in **"Shared
contracts"** (normative; already exported by WP 01).

Depends on WP 01. You define the seam that WPs 10 (jexl) and 11 (Lua) implement, so the seam's
shape is the part to get exactly right.

## Owns

- `src/batteries/orchestration/predicates.ts` — the predicate IR + the seam
- `src/batteries/orchestration/cells/structured.ts` — `@module .../orchestration/cells/structured`
- `tests/unit/batteries/orchestration/cells_structured.cross.spec.ts`

## Reads (do not modify)

- `src/batteries/vector/contract.ts`, `src/batteries/vector/hnswlib/index.ts` — why availability
  probing is async here: a sync `isAvailable(): boolean` cannot determine whether an optional ESM
  peer resolves through a lazy `await import()` (the `Cannot find module` condition is
  asynchronous), and those batteries use a sync probe only where the question is genuinely
  environmental
- WP 01's `types.ts`

## Contract

- `PredicateEvaluator` exactly as declared: `readonly id`, `load()`, `validate(node)`,
  `evaluate(node, ctx)` — **every method async**. `validate` is async because a cell like Lua
  cannot check that a script compiles without its VM loaded.
- `load()` resolves the cell's runtime, is **idempotent**, and throws `E_ORCH_CELL_UNAVAILABLE`
  (WP 01 declares it) naming the missing package and its install command.
- `validate()` returns named, **model-addressed** errors — a cell owns its own dialect lint, so any
  dialect confusion is reported by the cell that has the dialect, never by the core IR.
- `createStructuredCell(): PredicateEvaluator`.

## The structured cell

`{path, op, value}` with a closed operator set — `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`,
`contains`, `truthy`, `exists` — composed with `all` / `any` / `not`. No parser, no runtime,
terminating by construction, and the shape a small model authors most reliably. The right default
for most plans, and it adds **no dependency**.

Reads use `dlv` with a **per-segment guard rejecting `__proto__`, `prototype`, `constructor`**
(`dset` guards writes; `dlv` does NOT guard reads — so the guard is yours).

Cross-cutting rules that apply to every cell and start here:
- **Pre-marshal the readable context as plain data**, never live objects with reachable methods. A
  predicate reads a bounded, already-materialised snapshot.
- **No clock, no randomness** unless deliberately injected. For a predicate this is a feature: it
  keeps evaluation reproducible, which is exactly what makes `branch`/`select` safe to re-enter
  unconditionally on resume.

Nothing is wired by default. A plan containing a `branch`/`select` with no wired cell is refused at
freeze by WP 04 — not silently skipped, and not a runtime surprise.

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
- `cells_structured.cross.spec.ts` covers: every operator; `all`/`any`/`not` composition; the
  guarded reads (each of `__proto__`, `prototype`, `constructor` rejected **per segment**, not just
  at the root); a shape the cell cannot use rejected by `validate()` with a model-addressed message
  naming the fix; `load()` idempotent; and both verdict shapes (`{kind:'branch',matched}` and
  `{kind:'select',caseLabel}` including `null` → the `default` handle)

## Out of scope

The jexl cell (WP 10) and the Lua cell + watchdog (WP 11) — you define the seam they implement, not
the cells. Freeze-time refusal of an unwired cell is WP 04's. Do not add any dependency.
