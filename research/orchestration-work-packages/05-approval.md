# WP 05 — approval, authority claims, the gate

**Read first:** `/Users/jak/.claude/plans/i-had-an-idea-cached-pie.md` — **"Approval"** including
**"The reachability check, stated precisely"**, plus `AuthorityClaim`/`AuthorityVerb`/
`ApprovalRecord` in **"Shared contracts"**. Normative.

Depends on WP 01 (types, `foldOps`), WP 02 (`PlanStore.transition`).

## Owns

- `src/batteries/orchestration/approval.ts`
- `tests/unit/batteries/orchestration/approval.cross.spec.ts`

## Contract

- `computeAuthoritySet(view: RawPlanView): AuthorityClaim[]` — the deduplicated,
  **lexicographically sorted** union of every **reachable** `call` node's claims. Canonicalised so
  comparison is a set comparison with no expansion step.
- `approvePlan(planId, record: ApprovalRecord): Promise<TransitionResult>`

**The gate IS the `reviewable → executable` transition.** "Approved" and "executable" are the same
fact, so there is no separate "is this approved?" check to get wrong: an `executable` plan has an
approval record for its exact digest, or it is not `executable`.

`approvePlan` recomputes the reachable authority set from the frozen content, asserts it is
**set-equal** to the record's canonicalised set, and only then calls
`transition(reviewable → executable, {approval})`. A mismatch means the operator approved a
different authority set than the plan carries, and is refused **before the store is touched**.

Five verbs — `list | read | create | update | delete` — with **no implication between them**:
`update` does not imply `read`, `create` does not imply `update`. `append`-shaped operations
classify under `update`, not `create`, which keeps `create` safe to grant liberally. `list` is
split from `read` because filenames are their own disclosure.

Activation is **all-or-nothing**: one gate covers the whole set, because the owner is authorising a
WORKFLOW, and asking them to approve its steps separately invites approving a plan that cannot run.
Keep the redundant-request short-circuit: where the consumer's authority layer reports a claim
already live, only the missing claims are gated.

**Why the store deliberately does not re-verify the set:** recomputing it means walking the graph
and knowing what an authority claim is — battery policy a BYO store has no business
reimplementing. What the store guarantees is that the record it persists belongs to the digest it
commits. The residual — a caller bypassing `approvePlan` and calling `transition` directly can
persist a record whose set does not match — is the same class of misuse as calling `appendOps`
directly instead of the authoring tools. Name it in the TSDoc; do not defend against it, because
the only defence would be duplicating the validator into every store implementation.

**Note what is NOT a check here.** "Every reachable call's claims are in the plan's authority set"
is **tautological** (the set is derived as that union), so it cannot fail and no failing test for
it can be written. The two non-vacuous checks are: reachability at FREEZE (WP 04's — an
unreachable `call` is refused, and the set is the union over reachable calls only), and
**approval-vs-content set-equality at the GATE** (yours). Do not write the tautological one.

A plan must never hold a `TurnGate`: the encoder cannot serialise one (a live pending Promise has
no serialised form), and `resolve`/`reject` no-op once settled and return `void`, so a gate gives
no winner/loser signal. A plan holds an `ApprovalRecord`, which is data. There is no pending-gate
state to persist — and no mid-run gate at all (that case is an abort).

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
- `approval.cross.spec.ts` covers: authority-set canonicalisation (dedupe + sort is stable across
  input orders); all-or-nothing activation; the set is the union over **reachable** calls only;
  **`approvePlan` refuses a record whose `authoritySet` omits one claim** — asserted against
  `approvePlan`, **never** against `transition`, which by contract checks only lifecycle state and
  digest; the redundant-request short-circuit; and the case that must **PASS**: a purely linear
  plan with a side effect and no `branch`/`select` at all

## Out of scope

The freeze-time reachability check and its double derivation (WP 04). `transition`'s
implementation (WP 02). The operator-facing render of the authority set (WP 08).
