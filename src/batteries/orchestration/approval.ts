/**
 * @module @nhtio/adk/batteries/orchestration/approval
 *
 * Authority gating for a `reviewable` plan on the way to `executable`.
 *
 * The unit of authority is the {@link AuthorityClaim}: a narrow statement that one capability
 * may be exercised within one scope, with exactly one of the five verbs below. Claims are
 * independent — no verb implies any other, and a plan is never granted a hierarchy. This is
 * deliberate, and a reader new to this module should not assume otherwise.
 *
 * ## The five verbs, and why they do not nest
 *
 * - `list` — enumerate names. Kept apart from `read` because a filename is its own disclosure:
 *   learning that something exists is not the same as being able to inspect its contents.
 * - `read` — inspect the payload of a thing whose identity is already known.
 * - `create` — bring a thing into existence. Never shorthand for `update`: making a fresh empty
 *   object is materially safer than mutating existing state.
 * - `update` — modify an existing thing. Append-shaped operations classify HERE, not under
 *   `create`, which keeps `create` cheap to grant liberally (it can never silently mutate).
 * - `delete` — destroy a thing.
 *
 * There is no `update` implying `read`, and no `create` implying `update`. A reader will assume
 * a lattice that is deliberately absent; the absence is the feature, because each verb can then be
 * granted to exactly the callers that need it and nothing more.
 *
 * ## Approval is the transition
 *
 * "Approved" and "executable" are the same fact. There is no separate is-this-approved check to
 * keep in sync: a plan is executable iff a transition persists an {@link ApprovalRecord} bound to
 * its exact digest. This module therefore never answers "has it been approved?" as a question,
 * because the state machine cannot disagree with an answer that is never separately coded.
 *
 * Activation is all-or-nothing. {@link approvePlan} authorises the WHOLE reachable workflow in one
 * gate, because the owner is authorising a {@linkcode computeAuthoritySet workflow's} authority
 * set, computed over every reachable node. Approving a subset of steps would invite approving a
 * plan whose later steps can never run.
 *
 * ## The gate recomputes the set
 *
 * The store never re-derives an authority set. Recomputing it means walking the graph and knowing
 * what an {@link AuthorityClaim} is — battery policy a bring-your-own store has no business
 * reimplementing. The store guarantees only that whichever record it persists belongs to the
 * digest it commits.
 *
 * That leaves one residual misuse, named here: a caller may bypass {@link approvePlan} and call the
 * store's `transition` directly, persisting a record whose set does not match the plan. This is the
 * same class of error as calling `appendOps` directly instead of the authoring tools in the plan
 * module. It is not defended against, because the only defence would be duplicating this validator
 * into every store.
 *
 * A plan never holds a TurnGate. A live pending promise cannot be serialised by the encoder, and
 * `resolve`/`reject` no-op and return `void` once settled, so a gate produces no winner/loser
 * signal and would not survive a round-trip. A plan holds an {@link ApprovalRecord}, which is
 * plain data.
 */

import { foldOps } from './ops'
import { isObject } from '../../lib/utils/guards'
import { entryNodes, reachableFrom } from './plan'
import type { PlanStore, TransitionResult } from './store'
import type {
  AuthorityClaim,
  ApprovalRecord,
  AuthorityVerb,
  NodeId,
  PlanNode,
  RawPlanView,
} from './types'

/**
 * Computes the canonical authority set for a frozen plan.
 *
 * The set is the union of every reachable `call` node's claims, de-duplicated to exact triples and
 * sorted lexicographically by `capability`, then `scope`, then `verb`. Reachability is from the
 * entry node(s) via {@link reachableFrom}; a claim living on an unreachable node is excluded,
 * because the operator must see exactly what can actually run. Because the result is ordered and
 * de-duplicated, comparing two plans' sets is a plain set comparison with no expansion step.
 *
 * @remarks
 * The set is DERIVED as that union, so "every reachable call's claims are in the result" can never
 * fail and is not a meaningful check. The two non-vacuous gates are freeze-time reachability (a
 * separate work package) and {@link approvePlan approvePlan's} set-equality check.
 *
 * The optional `alreadyLive` predicate is the redundant-request short-circuit: a consumer whose
 * authority layer reports a claim already live can pass it so only the claims still needing a gate
 * are reported. It only shapes what THIS function returns for display/ask purposes; it does not
 * weaken {@link approvePlan approvePlan's} gate, which always compares the full reachable set.
 *
 * @param view - The frozen plan to summarise.
 * @param alreadyLive - Optional predicate; a claim it returns `true` for is omitted (already live).
 * @returns The sorted, de-duplicated, reachable-only authority claims.
 */
export function computeAuthoritySet(
  view: RawPlanView,
  alreadyLive?: (claim: AuthorityClaim) => boolean
): AuthorityClaim[] {
  const reached = new Set<NodeId>()
  for (const entry of entryNodes(view)) {
    for (const id of reachableFrom(view, entry.id)) {
      reached.add(id)
    }
  }

  const seen = new Set<string>()
  const claims: AuthorityClaim[] = []
  for (const node of view.nodes) {
    if (!reached.has(node.id)) continue
    const granted = callAuthority(node)
    if (granted === undefined) continue
    for (const claim of granted) {
      if (_isLive(claim, alreadyLive)) continue
      const key = `${claim.capability}\u0000${claim.scope}\u0000${claim.verb}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({ capability: claim.capability, scope: claim.scope, verb: claim.verb })
    }
  }

  claims.sort(compareClaims)
  return claims
}

/**
 * Approves a frozen `reviewable` plan and moves it to `executable`.
 *
 * The frozen content is rebuilt by folding the store's op log, the reachable authority set is
 * recomputed, and it is asserted SET-EQUAL to `record.authoritySet`. Only then is the store's
 * `transition` called, passing the recomputed digest as `expectedDigest` so the store refuses a
 * stale commit, and the decision as the approval payload.
 *
 * A set mismatch means the operator approved a different authority set than the plan actually
 * carries, so the request is refused BEFORE the store is touched. The refusal is a
 * `TransitionResult`-shaped failure returned rather than thrown: since `TransitionResult` has no
 * free-form reason, the failure is reported as a `digest_mismatch` (an authority-set inequality is
 * by definition a different content digest), carrying the actual digest and the assumed
 * `reviewable` state so a caller that lost can read what happened.
 *
 * @param store - The plan store holding the frozen plan.
 * @param planId - Identity of the plan to approve.
 * @param record - The operator's decision, whose `authoritySet` must match the plan's recomputed
 *   reachable set exactly (order-insensitive).
 * @returns The store's transition result, or a `digest_mismatch`-shaped refusal when the recomputed
 *   set does not match.
 */
export async function approvePlan(
  store: PlanStore,
  planId: string,
  record: ApprovalRecord
): Promise<TransitionResult> {
  const ops = await store.readOps(planId)
  const provenance = await store.readProvenance(planId)
  const { view } = foldOps(planId, ops, provenance)

  // The record must describe THIS plan at the digest the operator was actually shown. Checking
  // only the authority set is not enough: two revisions of a plan can carry identical authority
  // while differing in the staged ARGUMENTS an operator read — the path a file is written to, the
  // text of a prompt, which branch a predicate takes. Approving the set without binding the digest
  // authorises whatever the plan happens to say NOW.
  //
  // `expectedDigest` below cannot cover this. It is computed from the CURRENT fold, so it proves
  // the plan did not move between this check and the commit — it says nothing about whether the
  // operator ever saw that content.
  if (record.planId !== planId || record.digest !== view.digest) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      actual: { state: 'reviewable', digest: view.digest },
    }
  }

  const actual = computeAuthoritySet(view)
  if (!setEquals(actual, record.authoritySet)) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      actual: { state: 'reviewable', digest: view.digest },
    }
  }

  return store.transition(planId, {
    from: 'reviewable',
    to: 'executable',
    expectedDigest: view.digest,
    approval: record,
  })
}

/**
 * Order-insensitive comparison of two canonical authority claim collections.
 *
 * Both inputs are expected to be canonical (de-duplicated), so equality is determined by matching
 * multiset membership; each key is consumed once to catch a duplicate on either side.
 */
function setEquals(a: AuthorityClaim[], b: AuthorityClaim[]): boolean {
  if (a.length !== b.length) return false
  const remaining = new Map<string, void>()
  for (const claim of a) remaining.set(claimKey(claim), undefined)
  for (const claim of b) {
    const key = claimKey(claim)
    if (!remaining.has(key)) return false
    remaining.delete(key)
  }
  return remaining.size === 0
}

/** Lexicographic ordering: capability, then scope, then verb. */
function compareClaims(a: AuthorityClaim, b: AuthorityClaim): number {
  if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1
  if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1
  return a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0
}

/** NUL-joined key uniquely identifying one claim triple. */
function claimKey(claim: AuthorityClaim): string {
  return `${claim.capability}\u0000${claim.scope}\u0000${claim.verb}`
}

/** The authority claims carried by a node, if it is a `call` node; otherwise `undefined`. */
function callAuthority(node: PlanNode): AuthorityClaim[] | undefined {
  if (node.kind !== 'call') return undefined
  // Defensive, BYO-store hardening: a folded definition that is not a well-shaped object yields
  // no claim rather than a runtime crash. Claims themselves are validated field-by-field below.
  if (!isObject(node.definition)) return undefined
  const raw = (node.definition as Record<string, unknown>).authority
  if (!Array.isArray(raw)) return undefined
  return raw.filter(isClaimShape)
}

/** True when `value` is a well-shaped claim, so a malformed definition cannot crash the fold. */
function isClaimShape(value: unknown): value is AuthorityClaim {
  if (!isObject(value)) return false
  return (
    typeof value.capability === 'string' &&
    typeof value.scope === 'string' &&
    typeof value.verb === 'string' &&
    validVerb(value.verb)
  )
}

/** Type guard for the five discrete verbs. Verbs are independent; nothing nested hides here. */
function validVerb(v: string): v is AuthorityVerb {
  return v === 'list' || v === 'read' || v === 'create' || v === 'update' || v === 'delete'
}

/** The `alreadyLive` short-circuit: live claims are reported as already granted and skipped. */
function _isLive(claim: AuthorityClaim, alreadyLive?: (c: AuthorityClaim) => boolean): boolean {
  return alreadyLive !== undefined && alreadyLive(claim)
}
