import { describe, it, expect } from 'vitest'
import { encode, decode } from '@nhtio/encoder'
import { canonicalStringify } from '../../../../src/lib/utils/canonical_json'
import {
  NodeRef,
  ParamRef,
  planDigest,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type { RawPlanView, ArgValue } from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * Every approval binds to a plan digest, so the digest is a security boundary and not a cache
 * key: if two plans with different staged arguments digest identically, an operator's approval
 * of one authorises the other — a plan they never saw.
 *
 * That makes LOSSLESSNESS the property under test, and it is asserted the only way that means
 * anything: against the rejected alternative, showing the exact inputs on which it fails.
 */
describe('the plan digest is lossless', () => {
  const viewWith = (args: Record<string, ArgValue>): RawPlanView =>
    ({
      planId: 'p',
      digest: '',
      revision: 1,
      bounds: { maxNodes: 1, maxEdges: 1, maxSteps: 1, maxConcurrentFrames: 1, maxEncodedBytes: 1 },
      edges: [],
      nodes: [{ id: 'n', kind: 'call', definition: { args } }],
    }) as unknown as RawPlanView

  // The two plans from the design note: semantically different, and provably identical under
  // `canonicalStringify` because Date/RegExp/Map/Set have no enumerable own keys.
  const planA = { pattern: /^inv-\d+$/i, when: new Date('2020-01-01'), m: new Map([['k', 1]]) }
  const planB = { pattern: /^cust-\d+$/, when: new Date('2031-05-05'), m: new Map([['z', 9]]) }

  it('separates two plans that the REJECTED strategy collapses to one string', () => {
    // The rejected strategy, run for real rather than described: both collapse to
    // `{"m":{},"pattern":{},"when":{}}`.
    expect(canonicalStringify(planA)).toBe(canonicalStringify(planB))

    // The shipped one must not. This is the whole reason `canonicalStringify` was rejected.
    expect(planDigest(viewWith(planA))).not.toBe(planDigest(viewWith(planB)))
  })

  it('is stable across plain-object key order, which is what "canonical" has to buy', () => {
    const one = viewWith({ alpha: 1, beta: 2 })
    const other = viewWith({ beta: 2, alpha: 1 })
    expect(planDigest(one)).toBe(planDigest(other))
  })

  it('is deterministic: the same view digests identically every time', () => {
    const view = viewWith({ ref: new NodeRef('n0', 'first') })
    expect(planDigest(view)).toBe(planDigest(view))
  })

  it('changes when any staged value changes — asserted per encoder-owned type', () => {
    // Each of these is a type `canonicalStringify` flattened. One case per type, so a regression
    // in the handling of any single type is attributable rather than hidden in a bundle.
    const base = planDigest(viewWith({ v: 1 as ArgValue }))
    const cases: Record<string, ArgValue> = {
      date: new Date('2020-01-01') as unknown as ArgValue,
      regexp: /a/ as unknown as ArgValue,
      map: new Map([['k', 1]]) as unknown as ArgValue,
      set: new Set([1]) as unknown as ArgValue,
      bigint: 10n as unknown as ArgValue,
      nodeRef: new NodeRef('n0', 'first') as unknown as ArgValue,
    }
    const digests = Object.values(cases).map((v) => planDigest(viewWith({ v })))

    expect(new Set([...digests, base]).size).toBe(digests.length + 1)
  })

  it('distinguishes two Dates, two RegExps and two Maps of the same shape', () => {
    // The narrower statement: not merely "a Date differs from a number", but that the VALUE
    // inside each encoder-owned type reaches the digest.
    expect(planDigest(viewWith({ v: new Date('2020-01-01') as unknown as ArgValue }))).not.toBe(
      planDigest(viewWith({ v: new Date('2031-05-05') as unknown as ArgValue }))
    )
    expect(planDigest(viewWith({ v: /a/ as unknown as ArgValue }))).not.toBe(
      planDigest(viewWith({ v: /b/ as unknown as ArgValue }))
    )
    expect(planDigest(viewWith({ v: new Map([['k', 1]]) as unknown as ArgValue }))).not.toBe(
      planDigest(viewWith({ v: new Map([['k', 2]]) as unknown as ArgValue }))
    )
  })

  it('distinguishes a real NodeRef from a look-alike record with the same fields', () => {
    // If these digested identically, a plan staging a literal record could be swapped for one
    // staging a live reference under an approval bound to either.
    const real = planDigest(viewWith({ v: new NodeRef('n0', 'first') as unknown as ArgValue }))
    const lookAlike = planDigest(viewWith({ v: { node: 'n0', select: 'first' } as ArgValue }))
    expect(real).not.toBe(lookAlike)
  })

  it('hashes the whole view INCLUDING `digest`, so the caller must clear it first', () => {
    // Stated as it really is, because my first draft of this case asserted the stronger property
    // — that `planDigest` ignores the field — and it does not. `planDigest` hashes what it is
    // given; the self-reference is avoided by its ONE caller (`foldOps`) building the view with
    // `digest: ''` and assigning the result afterwards.
    //
    // Pinning it this way documents a real precondition rather than an imagined guarantee: a
    // second caller that passes an already-digested view gets a DIFFERENT digest, which would
    // silently break approval binding. If the invariant is ever moved inside `planDigest`, this
    // case fails and says so.
    const view = viewWith({ a: 1 as ArgValue })
    expect(planDigest({ ...view, digest: '' })).not.toBe(planDigest({ ...view, digest: 'stale' }))

    // The contract as `foldOps` actually uses it: hash at `digest: ''`, then assign.
    const folded = { ...view, digest: '' }
    const computed = planDigest(folded)
    expect(planDigest({ ...folded, digest: '' })).toBe(computed)
  })

  it('respects array ORDER, which is meaningful and must not be sorted away', () => {
    expect(planDigest(viewWith({ v: [1, 2] as ArgValue }))).not.toBe(
      planDigest(viewWith({ v: [2, 1] as ArgValue }))
    )
  })
})

describe('the reference classes round-trip through the encoder', () => {
  it('rebuilds a NodeRef as a real instance, not a record', () => {
    const ref = new NodeRef('n1', { index: 2 }, 'a.b', { segments: [{ edge: 'e1' }] })
    const back = decode(encode(ref as never)) as NodeRef

    expect(NodeRef.isNodeRef(back)).toBe(true)
    expect(back.node).toBe('n1')
    expect(back.select).toEqual({ index: 2 })
    expect(back.path).toBe('a.b')
    expect(back.branchId).toEqual({ segments: [{ edge: 'e1' }] })
  })

  it('rebuilds a ParamRef as a real instance', () => {
    const back = decode(encode(new ParamRef('folder') as never)) as ParamRef
    expect(ParamRef.isParamRef(back)).toBe(true)
    expect(back.path).toBe('folder')
  })

  it('guards are instanceof-backed, so a look-alike record cannot pass', () => {
    // The entire reason these are classes rather than `{kind:'nodeRef'}` markers: a resolver
    // keying on a marker field would silently rewrite a literal that happened to wear it.
    expect(NodeRef.isNodeRef({ node: 'n1', select: 'first', kind: 'nodeRef' })).toBe(false)
    expect(ParamRef.isParamRef({ path: 'folder', kind: 'paramRef' })).toBe(false)
    expect(NodeRef.isNodeRef(new ParamRef('folder'))).toBe(false)
    expect(ParamRef.isParamRef(new NodeRef('n1', 'first'))).toBe(false)
  })

  it('survives a round trip nested inside a whole plan view', () => {
    const view = {
      planId: 'p',
      digest: '',
      revision: 1,
      bounds: { maxNodes: 1, maxEdges: 1, maxSteps: 1, maxConcurrentFrames: 1, maxEncodedBytes: 1 },
      edges: [],
      nodes: [
        {
          id: 'n',
          kind: 'call',
          definition: { args: { deep: { list: [new NodeRef('n0', 'all')] } } },
        },
      ],
    } as unknown as RawPlanView

    const back = decode(encode(view as never)) as unknown as RawPlanView
    const list = (back.nodes[0]!.definition as unknown as { args: { deep: { list: unknown[] } } })
      .args.deep.list

    expect(NodeRef.isNodeRef(list[0])).toBe(true)
    // And the round trip is digest-preserving, which is what makes a persisted plan re-approvable.
    expect(planDigest(back)).toBe(planDigest(view))
  })

  it('registerOrchestrationEncodables is idempotent', () => {
    expect(() => {
      registerOrchestrationEncodables()
      registerOrchestrationEncodables()
    }).not.toThrow()
    expect(NodeRef.isNodeRef(decode(encode(new NodeRef('n1', 'first') as never)))).toBe(true)
  })
})
