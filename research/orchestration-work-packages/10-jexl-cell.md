# WP 10 — the jexl predicate cell

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — the *jexl cell* paragraph
in **"Predicates and the evaluator seam"**, and the cross-cutting rules for all three cells.

Depends on WP 03 (the `PredicateEvaluator` seam — implement it, do not redefine it).

**The `jexl` optional peer is already in `package.json`** (WP 01 landed all peer entries up front,
precisely so you and WP 11 never edit that file concurrently). **Do not touch `package.json`,
`pnpm-lock.yaml`, or `vite.config.mts`** — the build already externalises every peer.

## Owns

- `src/batteries/orchestration/cells/jexl.ts` — `@module .../orchestration/cells/jexl`
- `tests/unit/batteries/orchestration/cells_jexl.cross.spec.ts`

## Contract

`createJexlCell(options?): PredicateEvaluator`, with `id: 'jexl'`.

`load()` lazily `await import('jexl')` and throws `E_ORCH_CELL_UNAVAILABLE` (declared by WP 01)
naming the package and its install command; idempotent.

## Why this cell exists, so you keep its properties

jexl is a **custom lexer/parser/AST interpreter, not `eval()`**, and **expression-only by design**:
no statements, no assignment, no loops, no function definitions. It is therefore *structurally*
non-Turing-complete and cannot fail to terminate on anything but pathological data size — which is
what makes it safe without a watchdog. Preserve that: expose comparisons, ternary/elvis, collection
filtering (`employees[.age >= retireAge].first`), and the `|` transform pipe.

**Transforms are host-registered via `addTransform`, so the host decides the entire callable
surface.** Ship a closed allowlist; a predicate must not be able to reach anything you did not
register.

Use **`evalSync`** — it keeps predicate evaluation synchronous and reproducible (the outer seam
stays async, but the evaluation itself need not be).

Cross-cutting rules (from WP 03): pre-marshal the context as **plain data**, never live objects
with reachable methods; **no clock, no randomness** unless deliberately injected.

**Dialect traps are lint-able HERE, and that is the point of per-cell `validate()`:** `==` not
`===`, and bare identifiers with **no `ctx.` prefix`. Reject each **by name** with a
model-addressed message naming the correction — a model that writes `===` or `ctx.foo` must be told
which, not handed a parse error.

Honest limit for the docs: jexl was **last published 2022-06-19** — stable rather than abandoned,
but a frozen dependency. Acceptable for a closed grammar; say so plainly rather than implying
active maintenance.

This cell is **browser-safe** (unlike the Lua cell) — its tests are `*.cross.spec.ts`.

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
- `cells_jexl.cross.spec.ts` runs against **real `jexl`** (not a stub) and covers: the dialect lint
  (`===` rejected by name, a `ctx.` prefix rejected by name); the transform allowlist (a
  non-registered transform is refused); the `evalSync` path; **that no statement or assignment form
  parses**; collection filtering; and both verdict shapes including `caseLabel: null` → `default`

## Out of scope

The Lua cell and any watchdog (WP 11) — jexl needs none, and adding one would misrepresent why
this cell is safe. The structured cell and the seam (WP 03). Freeze-time refusal of an unwired
cell (WP 04).
