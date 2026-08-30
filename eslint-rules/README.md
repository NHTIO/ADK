# Project-local ESLint rules

This folder hosts custom ESLint rules that enforce policies documented in [../CONTRIBUTING.md](../CONTRIBUTING.md) and [../README.md](../README.md). Each rule corresponds to a prose policy; the rule makes the policy machine-checkable so drift fails CI instead of being caught at review.

## Rules

| Rule | Enforces |
| --- | --- |
| `adk/no-src-lib-import-from-functional-tests` | Functional tests must import from public barrels (`@nhtio/adk/*`), not from `src/lib/**`. |
| `adk/no-node-builtin-from-cross-or-browser-spec` | `*.cross.spec.ts` and `*.browser.spec.ts` must not import from `node:*`. |
| `adk/use-is-instance-of` | Bare `value instanceof Class` is cross-realm fragile; use `isInstanceOf(value, 'Class', Class)` from `src/lib/utils/guards.ts`. |
| `adk/prefer-is-object` | Inline `typeof x === 'object' && x !== null` must use `isObject(x)` from `src/lib/utils/guards.ts`. |
| `adk/prefer-is-error` | Bare `value instanceof Error` must use `isError(value)` from `src/lib/utils/guards.ts`. |
| `adk/require-string-empty-disposition` | A `validator.string()` chain that is `.optional()`/`.default(…)`-shaped must carry an explicit empty-string disposition (`.allow('')`, `.empty('')`, a `.valid(...)` enum, or `.forbidden()`) — otherwise a model sending `""` for an unwanted optional param fails schema validation instead of degrading gracefully. Scoped to `src/batteries/tools/**/*.ts`, `src/batteries/sandbox/**/*.ts`, and `src/batteries/media/**/*.ts` (the tool-schema-bearing battery families) rather than every `validator.string()` in the repo. Broader than the published plugin's sibling rule of the same name: it also traces a schema variable reassigned in a straight-line chain or through a single bounded `if`-with-no-`else` (never through a `switch`, which it does not analyze at all), and pattern-matches the `ScrapperParamSpec`-shaped `{ key, wire, type, schema, description }` object-literal convention directly — detection surfaces the published, portable copy deliberately does not claim since it can't assume this repository's own helper-function/spec-array conventions. |

All rules are report-only: no autofix, no suggestion. The dev rewrites the call by hand (and adds the `isInstanceOf` / `isObject` / `isError` import) or annotates a `// eslint-disable-next-line adk/<rule> -- <reason>` carve-out.

## Adding a new rule

1. Write the rule module under `rules/<rule-name>.mjs` as a plain ESLint rule object (`{ meta, create }`).
2. Wire it into `index.mjs` under the `rules` field.
3. Enable it in `../eslint.config.mjs` with the appropriate file scope.
