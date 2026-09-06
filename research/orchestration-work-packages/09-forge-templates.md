# WP 09 — the three-tier tool surface, the submit gate wiring, plan templates

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"The tool surface"**,
**"Plan templates — the strongest version of the small-model story"**, and `PlanTemplate`/
`TemplateNode`/`ParamRef`/`InstantiateResult` in **"Shared contracts"**.

Depends on WPs 01–08.

## Owns

- `src/batteries/orchestration/forge.ts` — `@module .../orchestration/forge`
- `src/batteries/orchestration/templates.ts` — template validation and instantiation sit with the
  tool surface that exposes them
- `tests/unit/batteries/orchestration/templates.cross.spec.ts`
- `tests/unit/batteries/orchestration/wire_refs.cross.spec.ts`

## Reads (do not modify)

- `src/batteries/dev_tools/forge.ts` — the `forgeXTools(runtime, {tier, overrides?, gate?})` shape
  to match
- `src/batteries/tools/_shared/index.ts` — `ToolGateFn` (`:282`) and `runToolGate` (`:296`)
- WPs 01–08's modules

## Contract

`forgeOrchestrationTools(runtime, {tier, overrides?, gate?}): Record<string, Tool>`, plus
`validateTemplate` / `instantiateTemplate` backing `Orchestration.instantiate`.

### Three tiers, three threat models

**Tier A — front door** (what a conversational agent sees): `list_templates()`,
`instantiate_plan({template, args})`, `author_plan({request, detail?})`. The request is passed
**verbatim, unparsed** — pre-parsing the owner's words into categories is exactly what discarded
"at the Holly Springs Walgreens" in the prior art. Tier A returns **rendered prose**, never raw
JSON.

**Tier B — graph mechanics**, exposed only inside the authoring sub-dispatch: `create_plan`,
`add_node`, `set_node_config`, `connect_nodes`, `remove_node`, `disconnect_edge`, `clone_plan`,
`get_plan`, `validate_plan`, `freeze_plan`, `unfreeze_plan`, `submit_plan`, `plan_status`,
`raw_plan`, `raw_diff`, plus the scoped reading pair `plan_outline()` and
`plan_read({phase})`/`plan_read({node})` — both closed enums over the live plan.

**Tier C — the invocable allowlist**: what a staged `call` may invoke, deliberately separate from
the agent's tool surface ("adding an agent tool never adds it here"). **The allowlist and the
registry are the SAME object** — the prior art's worst wart inverted: theirs listed ten names
against a registry with zero callers, so author-time validation passed and fire-time threw "not
registered". One object, or registration asserted at construction. You supply the
`InvocableTools` instance that WP 04's freeze consumes.

### The wire↔IR conversion is yours, and it is the ONLY one

A tool call cannot transmit a class instance, so the wire form differs from the IR:
- **WIRE** (tool inputs only): `{$ref: {node, select, path?, branchId?}}` and `{$param: {path}}` —
  single-key wrappers whose keys are **reserved**
- **IR**: real `NodeRef`/`ParamRef` instances
- **CONVERSION**: `hydrateRefs` on the way in, and the inverse on the way out, so a model reading a
  plan back sees the same `$ref` shape it writes. Nothing else in the battery sees the wire form.

### Mutation returns are SCOPED PROSE

Not the whole projected plan — that rule was written for a large window and is precisely the
context problem here (40 nodes echoed on every edit). Return what changed, what it now connects to,
and any new `issues[]`, **bounded regardless of plan size**. Prose, not JSON, because a model that
re-reads its own JSON echo tends to re-plan rather than continue.

Two conventions to keep: every mutation tool still surfaces a non-fatal `issues[]` so the model
always sees what is still wrong without being blocked mid-rewire; and a `NODE_VOCABULARY` constant
is appended to the relevant descriptions so the graph grammar is never guessed. `set_node_config`
takes a **closed alternatives schema** — one of the seven exact shapes, unknown keys per kind
rejected.

Two hygiene rules: the read-verb list in any handle directions is **generated from the registry
that produced the tool schemas**, never hand-written (a prompt naming tools that do not exist cost
real round-trips — CONTRIBUTING records Solace #1261); and `prospective()` is **not needed** — it
guarded mutation of *live* rules, which the lifecycle forbids outright. Record that, do not build it.

### Templates

Code-defined and registered at construction, so a template versions with the consuming
application, needs no store seeding, and is **validated once at boot** — a misconfigured
deployment fails with a named error rather than at first instantiation months later.

A template holds **op INPUTS without identity**: `PlanOp` requires `opId`/`actorId`/`lamport`/`at`,
which no static literal can carry. So `instantiate` validates `args` against `params`, substitutes
each `ParamRef`, mints a plan, and appends ops with **fresh identity under the instantiating
actor**. The result is an ordinary `editable` plan — no inherited approval, no special state.
Persist `InstantiatedFrom` through `createPlan(planId, {provenance})`.

**A template cannot launder its own parameters — checked at CONSTRUCTION, over the template.** A
`ParamRef` reaching a `call` node's `args` is refused unless a node on every route to it declares
that field in `declassifies`. This is decidable and total precisely because a registered template
is **immutable**: the graph cannot change after the check, so the answer cannot go stale. Do **not**
attempt to track a substituted value's origin through later edits — nothing in a freely-mutable
graph can, and the plan states that narrower invariant deliberately.

A template is **not** a plan: no lifecycle, no digest, no run, cannot be approved. Only its
instantiations are plans, which keeps "one plan id, at most one run" intact.

### The submit gate

Wire `freeze_plan`/`submit_plan` to WP 04's `freezePlan`, supplying the tier-C allowlist and wired
evaluators. Every refusal carries an **actionable message addressed to the model**. Note the prior
art's "the dry run produced no finding" refusal is **absent** — there is no dry run — and the
reachability and unedited-placeholder checks carry the weight it used to.

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
- `wire_refs.cross.spec.ts`: `{$ref}` in a tool input becomes a real `NodeRef` and `isNodeRef`
  passes; reading back yields `$ref` again (round-trip stable); a staged record whose sole key is
  `$ref`/`$param` reaching the IR **unconverted** is refused at freeze; an ordinary record merely
  *containing* a `$ref` key among others is untouched
- `templates.cross.spec.ts`: construction refuses a `ParamRef` reaching a `call` arg without a
  declaring node on every route; refuses a `ParamRef` naming an undeclared param, and a `call`
  naming a tool outside tier C — **at boot**, with a named error; `instantiate` validates args and
  returns `invalid_args` with a detail rather than minting a broken plan; provenance persists and
  `readProvenance` returns it; the minted plan is `editable` with no approval and no run; its ops
  carry fresh identity; two instantiations yield **independent** plans with different ids and
  digests; a substituted arg is tainted and refused into a `call` arg unless declassified; and a
  look-alike record `{path: 'x'}` is **not** treated as a `ParamRef`

## Out of scope

`validation.ts`'s checks themselves (WP 04) — you supply inputs and wire the call. `createOrchestration`
and the barrel (WP 12). Docs (WP 13).
