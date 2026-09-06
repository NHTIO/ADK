import { describe, it, expect } from 'vitest'
import { createJexlCell } from '../../../../src/batteries/orchestration/cells/jexl'
import type {
  PlanNode,
  NodeOutput,
  OutputTable,
  PredicateContext,
} from '../../../../src/batteries/orchestration/types'

/**
 * Run against REAL jexl, never a stub — a stub would test this file's beliefs about the grammar,
 * and the grammar is exactly what the cell has to get right.
 *
 * jexl is a custom lexer/parser/AST interpreter rather than `eval()`, and expression-only by
 * design: no statements, no assignment, no loops, no function definitions. That is what makes it
 * structurally non-Turing-complete and safe without a watchdog, so the cases below pin those
 * properties rather than assuming them.
 */
describe('the jexl predicate cell', () => {
  const cell = createJexlCell()

  /** One node's output on one branch, as a live frame carries it. */
  const contextOf = (json: Record<string, unknown>, key = 'n1:'): PredicateContext => {
    const outputs: OutputTable = new Map([
      [key, { items: [{ json }], branchId: { segments: [] } } as unknown as NodeOutput],
    ])
    return { outputs, frame: {} } as unknown as PredicateContext
  }

  const branchNode = (predicate: unknown): PlanNode =>
    ({ id: 'br', kind: 'branch', definition: { evaluator: 'jexl', predicate } }) as PlanNode

  const selectNode = (predicate: unknown, cases: string[]): PlanNode =>
    ({ id: 'sel', kind: 'select', definition: { evaluator: 'jexl', predicate, cases } }) as PlanNode

  const decide = async (source: string, json: Record<string, unknown>): Promise<boolean> => {
    const verdict = await cell.evaluate(branchNode(source), contextOf(json))
    return verdict.kind === 'branch' && verdict.matched
  }

  describe('the readable context is addressable at all', () => {
    it('reaches a node output by its BARE NODE ID', async () => {
      // The defect this pins: the snapshot was keyed by the raw table key `${nodeId}:${branchKey}`,
      // and jexl's grammar cannot reach a bare identifier containing a colon by ANY syntax —
      // `n1:.status` is a parse error and an unwrapped `this["n1:"]` throws because `this` is not
      // bound. Measured against real jexl 2.3.0. So every predicate silently read `undefined` and
      // every branch took `no_match`.
      expect(await decide('n1.status == "red"', { status: 'red' })).toBe(true)
      expect(await decide('n1.status == "blue"', { status: 'red' })).toBe(false)
    })

    it('reaches an exact table key through the `outputs` wrapper', async () => {
      // The escape hatch, and the only way to name WHICH execution when a node ran on several.
      expect(await decide('outputs["n1:"].status == "red"', { status: 'red' })).toBe(true)
    })

    it('drops an AMBIGUOUS bare id rather than picking a winner', async () => {
      // The same node on two branches: the bare id cannot mean both, so it means NEITHER and the
      // author must disambiguate through `outputs`. Guessing would make a predicate's meaning
      // depend on table iteration order.
      const outputs: OutputTable = new Map([
        [
          'n1:e2:e0',
          { items: [{ json: { v: 1 } }], branchId: { segments: [] } } as unknown as NodeOutput,
        ],
        [
          'n1:e2:e1',
          { items: [{ json: { v: 2 } }], branchId: { segments: [] } } as unknown as NodeOutput,
        ],
      ])
      const ctx = { outputs, frame: {} } as unknown as PredicateContext

      // Asserted as ABSENCE, not as "the wrong value did not come back". My first draft checked
      // `n1.v == 1` and was false under BOTH the correct behaviour and a last-wins guess (which
      // yields v:2), so it could not tell them apart. `exists`-style absence can.
      const absent = await cell.evaluate(branchNode('n1 == null'), ctx)
      expect(absent).toEqual({ kind: 'branch', matched: true })
      // Neither contributor's value is reachable through the bare id.
      for (const value of [1, 2]) {
        const guessed = await cell.evaluate(branchNode(`n1.v == ${value}`), ctx)
        expect(guessed).toEqual({ kind: 'branch', matched: false })
      }

      // But the exact keys still work, which is the point of keeping the wrapper.
      const exact = await cell.evaluate(branchNode('outputs["n1:e2:e1"].v == 2'), ctx)
      expect(exact).toEqual({ kind: 'branch', matched: true })
    })
  })

  describe('the dialect lint names the model’s mistake', () => {
    it('rejects `===` BY NAME, not as a parse error', async () => {
      await expect(cell.validate(branchNode('n1.v === 1'))).rejects.toThrow(/'==='/)
      await expect(cell.validate(branchNode('n1.v === 1'))).rejects.toThrow(/'=='/)
    })

    it('rejects a `ctx.` prefix BY NAME', async () => {
      await expect(cell.validate(branchNode('ctx.n1.v == 1'))).rejects.toThrow(/ctx/)
    })

    it('rejects a non-string predicate, naming what it got and the alternative', async () => {
      await expect(cell.validate(branchNode({ path: 'a', op: 'eq' }))).rejects.toThrow(/structured/)
      await expect(cell.validate(branchNode(123))).rejects.toThrow(/number/)
    })

    it('rejects a syntax error at FREEZE rather than mid-run', async () => {
      await expect(cell.validate(branchNode('n1.v =='))).rejects.toThrow(/not valid JEXL/)
    })

    it('accepts a well-formed expression', async () => {
      await expect(cell.validate(branchNode('n1.v > 3'))).resolves.toBeUndefined()
    })
  })

  describe('it is expression-only, which is WHY it needs no watchdog', () => {
    // Each of these is a statement or definition form. If any parsed, the "structurally
    // non-Turing-complete" claim would be false and the cell would need a watchdog it does not
    // have — so these are load-bearing, not decorative.
    for (const source of [
      'x = 1',
      'var x = 1',
      'if (true) { 1 }',
      'while (true) {}',
      'function f() { return 1 }',
      'for (;;) {}',
      'return 1',
    ]) {
      it(`refuses the statement form: ${source}`, async () => {
        await expect(cell.validate(branchNode(source))).rejects.toThrow()
      })
    }
  })

  describe('the transform allowlist is the callable surface', () => {
    it('refuses a transform the host did not register', async () => {
      // No transforms registered by default, so the `|` pipe resolves nothing at all.
      const bare = createJexlCell()
      await bare.load()
      const verdict = await bare.evaluate(branchNode('n1.v|upper == "A"'), contextOf({ v: 'a' }))
      // Unregistered: the evaluation faults and the safe verdict is the negative one.
      expect(verdict).toEqual({ kind: 'branch', matched: false })
    })

    it('calls a transform the host DID register', async () => {
      const withTransform = createJexlCell({
        transforms: { upper: (value: unknown) => String(value).toUpperCase() },
      })
      await withTransform.load()
      const verdict = await withTransform.evaluate(
        branchNode('n1.v|upper == "A"'),
        contextOf({ v: 'a' })
      )
      expect(verdict).toEqual({ kind: 'branch', matched: true })
    })
  })

  it('supports collection filtering, the reason to reach for this cell over structured', async () => {
    expect(
      await decide('n1.items[.age >= 30][0].age == 31', { items: [{ age: 31 }, { age: 20 }] })
    ).toBe(true)
    expect(
      await decide('n1.items[.age >= 99][0].age == 31', { items: [{ age: 31 }, { age: 20 }] })
    ).toBe(false)
  })

  it('supports the ternary and elvis forms', async () => {
    expect(await decide('(n1.v > 3 ? "big" : "small") == "big"', { v: 4 })).toBe(true)
    expect(await decide('(n1.missing ?: "fallback") == "fallback"', { v: 4 })).toBe(true)
  })

  describe('a predicate is never allowed to crash the run', () => {
    // What actually throws out of `evalSync` matters here, and I measured it rather than assumed:
    // reaching into an undefined intermediate does NOT throw (jexl returns `undefined` for
    // `missing.deep.thing`), so my first draft of these cases could not have caught an unguarded
    // call. An UNREGISTERED TRANSFORM does throw — `Transform nope is not defined.` — and that is
    // the realistic fault, since the pipe surface is exactly what a model guesses at.
    it('returns no_match when evaluation FAULTS at runtime', async () => {
      const verdict = await cell.evaluate(branchNode('n1.v|nope'), contextOf({ v: 1 }))
      expect(verdict).toEqual({ kind: 'branch', matched: false })
    })

    it('returns the `default` handle when a SELECT faults', async () => {
      const verdict = await cell.evaluate(selectNode('n1.v|nope', ['a']), contextOf({ v: 1 }))
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })

    it('treats a missing path as absent rather than as a fault', async () => {
      // The other half of the same statement: jexl resolves a missing path to `undefined`, so a
      // predicate over a branch that has not produced output is simply false, not an error.
      expect(await decide('missing.deep.thing', {})).toBe(false)
    })
  })

  describe('both verdict shapes', () => {
    it('compares the evaluated value to each case label in declared order', async () => {
      const verdict = await cell.evaluate(
        selectNode('n1.status', ['green', 'amber', 'red']),
        contextOf({ status: 'red' })
      )
      expect(verdict).toEqual({ kind: 'select', caseLabel: 'red' })
    })

    it('yields null — the `default` handle — when no case matches', async () => {
      const verdict = await cell.evaluate(
        selectNode('n1.status', ['green', 'amber']),
        contextOf({ status: 'red' })
      )
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })
  })

  it('load() is idempotent', async () => {
    await expect(cell.load()).resolves.toBeUndefined()
    await expect(cell.load()).resolves.toBeUndefined()
  })
})
