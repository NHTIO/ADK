import { describe, it, expect } from 'vitest'
import { createLuaCell } from '../../../../src/batteries/orchestration/cells/lua/index'
import type {
  PlanNode,
  NodeOutput,
  OutputTable,
  PredicateContext,
} from '../../../../src/batteries/orchestration/types'

/**
 * NODE-ONLY: this cell needs `worker_threads` and `SIGKILL`, which is why it is reachable only
 * through its own deep subpath and is never re-exported from the environment-neutral barrel.
 *
 * A SANDBOX YOU HAVE NOT TESTED IS A SANDBOX YOU WILL BREAK BY ACCIDENT. The prior art's Lua
 * evaluator shipped twice with zero isolation tests and was disabled both times, so a cell's
 * tests must FAIL when its isolation is broken — that is the entry criterion for shipping it, and
 * these run against real wasmoon rather than a stub.
 */
describe('the Lua predicate cell', () => {
  const cell = createLuaCell()

  const contextOf = (json: Record<string, unknown>): PredicateContext => {
    const outputs: OutputTable = new Map([
      ['n1:', { items: [{ json }], branchId: { segments: [] } } as unknown as NodeOutput],
    ])
    return { outputs, frame: {} } as unknown as PredicateContext
  }

  const branchNode = (predicate: unknown): PlanNode =>
    ({ id: 'br', kind: 'branch', definition: { evaluator: 'lua', predicate } }) as PlanNode

  const selectNode = (predicate: unknown, cases: string[]): PlanNode =>
    ({ id: 'sel', kind: 'select', definition: { evaluator: 'lua', predicate, cases } }) as PlanNode

  const decide = async (source: string, json: Record<string, unknown> = {}): Promise<boolean> => {
    const verdict = await cell.evaluate(branchNode(source), contextOf(json))
    return verdict.kind === 'branch' && verdict.matched
  }

  it('reads the marshalled context by table key', async () => {
    // `ctx['nodeId:branchKey'][i].json.field` — Lua indexes a string key directly, so unlike the
    // jexl cell it needs no bare-identifier alias.
    expect(await decide("return ctx['n1:'][1].json.status == 'red'", { status: 'red' })).toBe(true)
    expect(await decide("return ctx['n1:'][1].json.status == 'blue'", { status: 'red' })).toBe(
      false
    )
  })

  describe('the sandbox is built by ALLOWLIST, so these are absent by construction', () => {
    // `openStandardLibs: false`, and nothing is injected unless named. A predicate reaching for
    // any of these must not find it — asserted one per global so a regression names which.
    for (const global of [
      '_G',
      'os',
      'io',
      'load',
      'dofile',
      'getfenv',
      'getmetatable',
      'require',
    ]) {
      it(`does not expose \`${global}\``, async () => {
        expect(await decide(`return ${global} ~= nil`)).toBe(false)
      })
    }

    it('exposes no clock and no randomness, so a verdict is reproducible', async () => {
      // This is what makes `branch`/`select` safe to re-enter unconditionally on resume.
      expect(await decide('return os ~= nil and os.time ~= nil')).toBe(false)
      expect(await decide('return math ~= nil and math.random ~= nil')).toBe(false)
    })
  })

  describe('resource limits actually fire', () => {
    it('completes BOUNDED work, so the limits are not simply refusing everything', async () => {
      // The control. Without it, every case below would pass against a cell that rejected all
      // input, and the suite would prove nothing about enforcement.
      expect(await decide('local i = 0 for x = 1, 100 do i = i + 1 end return i == 100')).toBe(true)
    })

    it('stops a runaway loop rather than hanging the run', async () => {
      const verdict = await cell.evaluate(
        branchNode('local i = 0 for x = 1, 1e8 do i = i + 1 end return i > 0'),
        contextOf({})
      )
      expect(verdict).toEqual({ kind: 'branch', matched: false })
    }, 60_000)

    it('stops an allocation bomb', async () => {
      const verdict = await cell.evaluate(
        branchNode("local s = string.rep('x', 1000000) return #s > 0"),
        contextOf({})
      )
      expect(verdict).toEqual({ kind: 'branch', matched: false })
    }, 60_000)

    it('reports the guarantee it is actually delivering', async () => {
      // wasmoon's count hook and allocator cap are undocumented at its TypeScript surface, so the
      // cell probes them against canaries at construction and falls back to watchdog-only. What
      // matters is that it REPORTS the reduced guarantee rather than claiming the full one.
      await cell.load()
      const status = cell.status()
      expect(typeof status.guarantee).toBe('string')
      expect(status.timeoutMs).toBeGreaterThan(0)
    })
  })

  describe('a predicate is never allowed to crash the run', () => {
    it('turns a Lua runtime error into a verdict', async () => {
      const verdict = await cell.evaluate(branchNode("error('boom')"), contextOf({}))
      expect(verdict).toEqual({ kind: 'branch', matched: false })
    })

    it('turns an unknown-global reach into the `default` handle for a select', async () => {
      const verdict = await cell.evaluate(selectNode('return os.time()', ['a']), contextOf({}))
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })
  })

  describe('validate refuses at freeze rather than mid-run', () => {
    it('refuses a non-string predicate', async () => {
      await expect(cell.validate(branchNode(123))).rejects.toThrow(/SOURCE STRING/)
    })

    it('refuses a syntax error, loading the chunk to find it', async () => {
      await expect(cell.validate(branchNode('this is not lua (('))).rejects.toThrow(/syntax error/)
    })

    it('accepts a well-formed chunk', async () => {
      await expect(cell.validate(branchNode('return ctx ~= nil'))).resolves.toBeUndefined()
    })
  })

  describe('both verdict shapes', () => {
    it('returns the case label the chunk RETURNS', async () => {
      // This cell's select contract: the predicate is a dispatcher returning a label or nil.
      const verdict = await cell.evaluate(
        selectNode("return ctx['n1:'][1].json.status", ['green', 'amber', 'red']),
        contextOf({ status: 'red' })
      )
      expect(verdict).toEqual({ kind: 'select', caseLabel: 'red' })
    })

    it('falls to `default` when the returned label is not a declared case', async () => {
      const verdict = await cell.evaluate(
        selectNode("return 'not-a-case'", ['green']),
        contextOf({})
      )
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })

    it('falls to `default` on nil', async () => {
      const verdict = await cell.evaluate(selectNode('return nil', ['green']), contextOf({}))
      expect(verdict).toEqual({ kind: 'select', caseLabel: null })
    })
  })

  it('load() is idempotent', async () => {
    await expect(cell.load()).resolves.toBeUndefined()
    await expect(cell.load()).resolves.toBeUndefined()
  })
})
