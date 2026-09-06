import { describe, it, expect } from 'vitest'
import { readPath } from '../../../../src/batteries/orchestration/plan'
import { createStructuredCell } from '../../../../src/batteries/orchestration/cells/structured'
import {
  MAX_PREDICATE_DEPTH,
  parseStructuredPredicate,
} from '../../../../src/batteries/orchestration/predicates'
import type {
  PlanNode,
  NodeOutput,
  OutputTable,
  PredicateContext,
} from '../../../../src/batteries/orchestration/types'

/**
 * The structured cell is the default evaluator: no parser, no runtime, terminating by
 * construction, and the shape a small model authors most reliably. It is also the only cell a
 * plan can rely on unconditionally, since the other two need an optional peer.
 *
 * Two cross-cutting rules start here and apply to every cell — the predicate reads a
 * PRE-MARSHALLED plain-data snapshot rather than live objects, and it uses no clock and no
 * randomness, which is what makes `branch`/`select` safe to re-enter unconditionally on resume.
 */
describe('the structured predicate cell', () => {
  const cell = createStructuredCell()

  /** A one-node output table, as a live frame would carry it. */
  const contextOf = (json: Record<string, unknown>): PredicateContext => {
    const outputs: OutputTable = new Map([
      ['n1:', { items: [{ json }], branchId: { segments: [] } } as unknown as NodeOutput],
    ])
    return { outputs, frame: {} } as unknown as PredicateContext
  }

  const branchNode = (predicate: unknown): PlanNode =>
    ({ id: 'br', kind: 'branch', definition: { evaluator: 'structured', predicate } }) as PlanNode

  const selectNode = (predicate: unknown, cases: string[]): PlanNode =>
    ({
      id: 'sel',
      kind: 'select',
      definition: { evaluator: 'structured', predicate, cases },
    }) as PlanNode

  const decide = async (predicate: unknown, json: Record<string, unknown>): Promise<boolean> => {
    const verdict = await cell.evaluate(branchNode(predicate), contextOf(json))
    return verdict.kind === 'branch' && verdict.matched
  }

  it('reads the MARSHALLED outputs, not the raw table', async () => {
    // `ctx.outputs` is a ReadonlyMap and the path walk uses property access, so handing the Map
    // over directly reads nothing: every path misses and every predicate silently evaluates
    // false, taking `no_match` on a branch that should have matched. That was a real defect —
    // silent, and in the direction that skips work rather than failing loudly.
    expect(await decide({ path: 'n1:.status', op: 'eq', value: 'red' }, { status: 'red' })).toBe(
      true
    )
  })

  describe('every operator in the closed set', () => {
    it('compares with eq and ne', async () => {
      expect(await decide({ path: 'n1:.v', op: 'eq', value: 1 }, { v: 1 })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'eq', value: 2 }, { v: 1 })).toBe(false)
      expect(await decide({ path: 'n1:.v', op: 'ne', value: 2 }, { v: 1 })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'ne', value: 1 }, { v: 1 })).toBe(false)
    })

    it('orders with lt, lte, gt and gte', async () => {
      expect(await decide({ path: 'n1:.v', op: 'lt', value: 5 }, { v: 4 })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'lt', value: 4 }, { v: 4 })).toBe(false)
      expect(await decide({ path: 'n1:.v', op: 'lte', value: 4 }, { v: 4 })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'gt', value: 3 }, { v: 4 })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'gt', value: 4 }, { v: 4 })).toBe(false)
      expect(await decide({ path: 'n1:.v', op: 'gte', value: 4 }, { v: 4 })).toBe(true)
    })

    it('tests membership with in and contains', async () => {
      expect(await decide({ path: 'n1:.v', op: 'in', value: ['a', 'b'] }, { v: 'a' })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'in', value: ['a', 'b'] }, { v: 'z' })).toBe(false)
      expect(await decide({ path: 'n1:.v', op: 'contains', value: 'b' }, { v: ['a', 'b'] })).toBe(
        true
      )
      expect(await decide({ path: 'n1:.v', op: 'contains', value: 'z' }, { v: ['a', 'b'] })).toBe(
        false
      )
    })

    it('takes truthy and exists without a value', async () => {
      expect(await decide({ path: 'n1:.v', op: 'truthy' }, { v: 'x' })).toBe(true)
      expect(await decide({ path: 'n1:.v', op: 'truthy' }, { v: '' })).toBe(false)
      expect(await decide({ path: 'n1:.v', op: 'exists' }, { v: null })).toBe(true)
      expect(await decide({ path: 'n1:.missing', op: 'exists' }, { v: 1 })).toBe(false)
    })
  })

  describe('composition', () => {
    const json = { a: 1, b: 2 }

    it('requires every member of `all`', async () => {
      const both = {
        all: [
          { path: 'n1:.a', op: 'eq', value: 1 },
          { path: 'n1:.b', op: 'eq', value: 2 },
        ],
      }
      const one = {
        all: [
          { path: 'n1:.a', op: 'eq', value: 1 },
          { path: 'n1:.b', op: 'eq', value: 9 },
        ],
      }
      expect(await decide(both, json)).toBe(true)
      expect(await decide(one, json)).toBe(false)
    })

    it('requires at least one member of `any`', async () => {
      const one = {
        any: [
          { path: 'n1:.a', op: 'eq', value: 9 },
          { path: 'n1:.b', op: 'eq', value: 2 },
        ],
      }
      const none = {
        any: [
          { path: 'n1:.a', op: 'eq', value: 9 },
          { path: 'n1:.b', op: 'eq', value: 9 },
        ],
      }
      expect(await decide(one, json)).toBe(true)
      expect(await decide(none, json)).toBe(false)
    })

    it('negates with `not`, and nests combinators', async () => {
      expect(await decide({ not: { path: 'n1:.a', op: 'eq', value: 9 } }, json)).toBe(true)
      const nested = {
        all: [
          {
            any: [
              { path: 'n1:.a', op: 'eq', value: 1 },
              { path: 'n1:.a', op: 'eq', value: 2 },
            ],
          },
          { not: { path: 'n1:.b', op: 'eq', value: 9 } },
        ],
      }
      expect(await decide(nested, json)).toBe(true)
    })
  })

  describe('reads are guarded PER SEGMENT against prototype pollution', () => {
    // `dlv` does not guard reads, so the guard is the battery's — and it must apply at every
    // segment, not merely at the root, or a nested reach walks straight through it.
    //
    // These assert through `readPath` directly rather than only through a predicate verdict, and
    // the reason is worth recording: my first draft asserted `{op:'exists'} === false` for each
    // forbidden path, and it PASSED EVEN WITH THE GUARD REMOVED. Unguarded, `n1:.constructor`
    // returns the `Object` constructor FUNCTION and `n1:.__proto__` returns the prototype — but
    // the predicate then failed to match for unrelated reasons, so the verdict looked identical
    // either way. A case that cannot distinguish the guarded implementation from the unguarded
    // one is not a test of the guard.
    for (const segment of ['__proto__', 'prototype', 'constructor']) {
      it(`refuses "${segment}" at the root, reaching nothing at all`, () => {
        expect(readPath({ 'n1:': { status: 'red' } }, segment)).toBeUndefined()
      })

      it(`refuses "${segment}" NESTED mid-path`, () => {
        const value = readPath({ 'n1:': { status: 'red' } }, `n1:.${segment}`)
        // `toBeUndefined` is the assertion that sees it: unguarded, this is a function or an
        // object, and both stringify to nothing useful.
        expect(value).toBeUndefined()
        expect(typeof value).toBe('undefined')
      })

      it(`refuses "${segment}" through a predicate too`, async () => {
        expect(await decide({ path: `n1:.${segment}.polluted`, op: 'exists' }, { v: 1 })).toBe(
          false
        )
      })
    }
  })

  describe('validate refuses what the cell cannot use, with a model-addressed message', () => {
    it('names the legal operator set for an unknown operator', async () => {
      await expect(
        cell.validate(branchNode({ path: 'a', op: 'regex', value: 'x' }))
      ).rejects.toThrow(/eq/)
    })

    it('refuses a predicate that is not a predicate at all', async () => {
      await expect(cell.validate(branchNode('a > 5'))).rejects.toThrow()
      await expect(cell.validate(branchNode(undefined))).rejects.toThrow()
    })

    it('refuses a select whose predicate is not a per-case map', async () => {
      await expect(
        cell.validate(selectNode({ path: 'n1:.v', op: 'truthy' }, ['a', 'b']))
      ).rejects.toThrow(/predicate/)
    })

    it('refuses a select declaring a case with no predicate for it', async () => {
      await expect(
        cell.validate(selectNode({ a: { path: 'n1:.v', op: 'eq', value: 'a' } }, ['a', 'unmapped']))
      ).rejects.toThrow(/unmapped/)
    })

    it('accepts a well-formed select', async () => {
      await expect(
        cell.validate(
          selectNode(
            {
              a: { path: 'n1:.v', op: 'eq', value: 'a' },
              b: { path: 'n1:.v', op: 'eq', value: 'b' },
            },
            ['a', 'b']
          )
        )
      ).resolves.toBeUndefined()
    })
  })

  describe('both verdict shapes', () => {
    const CASES = ['green', 'amber', 'red']
    const byCase = {
      green: { path: 'n1:.status', op: 'eq', value: 'green' },
      amber: { path: 'n1:.status', op: 'eq', value: 'amber' },
      red: { path: 'n1:.status', op: 'eq', value: 'red' },
    }

    it('reaches a LATER case, not only the first', async () => {
      // The regression: an earlier version looped the case labels while re-evaluating ONE boolean
      // predicate, so it returned the FIRST label whenever that predicate held. Every case after
      // the first was unreachable, and an n-way select silently behaved as a two-way branch.
      const verdict = await cell.evaluate(selectNode(byCase, CASES), contextOf({ status: 'red' }))
      expect(verdict).toEqual({ kind: 'select', caseLabel: 'red' })
    })

    it('picks the middle case too', async () => {
      const verdict = await cell.evaluate(selectNode(byCase, CASES), contextOf({ status: 'amber' }))
      expect(verdict).toEqual({ kind: 'select', caseLabel: 'amber' })
    })

    it('yields null — the `default` handle — when nothing matches', async () => {
      const verdict = await cell.evaluate(selectNode(byCase, CASES), contextOf({ status: 'blue' }))
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })

    it('resolves overlapping predicates by the order `cases` declares', async () => {
      const overlapping = {
        first: { path: 'n1:.v', op: 'exists' },
        second: { path: 'n1:.v', op: 'exists' },
      }
      const verdict = await cell.evaluate(
        selectNode(overlapping, ['second', 'first']),
        contextOf({ v: 1 })
      )
      // `second` is declared first, so it wins — precedence is the author's, not object key order.
      expect(verdict).toEqual({ kind: 'select', caseLabel: 'second' })
    })

    it('never crashes a run: a malformed predicate is a verdict, not a throw', async () => {
      await expect(
        cell.evaluate(branchNode({ path: 'a', op: 'nonsense' }), contextOf({ v: 1 }))
      ).resolves.toEqual({ kind: 'branch', matched: false })
      await expect(
        cell.evaluate(selectNode('not a map', ['a']), contextOf({ v: 1 }))
      ).resolves.toEqual({ kind: 'select', caseLabel: null })
    })
  })

  describe('nesting depth is bounded, so a predicate cannot overflow the stack', () => {
    // Found by the AI review panel. Measured before fixing: evaluation threw `RangeError` at
    // ~5,000 nested combinators and parsing itself threw at ~20,000 — a stack overflow escaping
    // as an uncaught error, which breaks the cell's promise that a predicate never crashes a run.
    //
    // Plan bounds did NOT cover it: a crashing 20,000-deep predicate encodes to roughly 180KB
    // against a 1 MiB `maxEncodedBytes`, so it passed freeze on size and detonated at run time.
    const nest = (depth: number): unknown => {
      let predicate: unknown = { path: 'n1:.v', op: 'truthy' }
      for (let i = 0; i < depth; i++) predicate = { not: predicate }
      return predicate
    }

    it('accepts nesting a real author would write', async () => {
      expect(await decide(nest(200), { v: 1 })).toBe(true)
    })

    it('REFUSES nesting past the cap, naming the fix', () => {
      const parsed = parseStructuredPredicate(nest(MAX_PREDICATE_DEPTH + 44))
      expect(parsed.ok).toBe(false)
      // The message must tell an author what to do — `all`/`any` take lists, so the answer is to
      // flatten, not to nest one condition per level.
      expect((parsed as { reason: string }).reason).toMatch(/flatten/i)
    })

    it('never THROWS, at any depth — the verdict stays a verdict', async () => {
      for (const depth of [MAX_PREDICATE_DEPTH + 1, 5_000, 20_000]) {
        await expect(cell.evaluate(branchNode(nest(depth)), contextOf({ v: 1 }))).resolves.toEqual({
          kind: 'branch',
          matched: false,
        })
      }
    })
  })

  it('load() is idempotent and needs no peer', async () => {
    await expect(cell.load()).resolves.toBeUndefined()
    await expect(cell.load()).resolves.toBeUndefined()
  })

  it('is deterministic: the same predicate and snapshot always agree', async () => {
    const predicate = { path: 'n1:.v', op: 'gt', value: 3 }
    const first = await decide(predicate, { v: 4 })
    for (let i = 0; i < 5; i++) expect(await decide(predicate, { v: 4 })).toBe(first)
  })
})
