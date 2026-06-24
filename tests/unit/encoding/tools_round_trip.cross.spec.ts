import { validator } from '@nhtio/validation'
import { encode, decode } from '@nhtio/encoder'
import { Tool } from '../../../src/lib/classes/tool'
import { describe, expect, it, beforeAll } from 'vitest'
import { ArtifactTool } from '../../../src/lib/classes/artifact_tool'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { registerAdkEncodables } from '../../../src/batteries/encoding'
import type { DispatchContext } from '../../../src/lib/contracts/dispatch_context'

beforeAll(() => {
  registerAdkEncodables()
})

const roundTrip = <T>(value: T): T => decode(encode(value as never)) as T

// Minimal duck-typed ctx satisfying the parts Tool.executor touches.
const ctxStub = () =>
  ({
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
  }) as unknown as DispatchContext

describe('encoding round-trip — Tool', () => {
  it('round-trips name/description/flags and rebuilds inputSchema via @nhtio/validation', () => {
    const tool = new Tool({
      name: 'search',
      description: 'searches the web',
      inputSchema: validator.object({ query: validator.string().required() }),
      // PURE handler: closes over nothing. Source-text serialisation is sufficient.
      handler: (args: unknown) => `searched: ${(args as { query: string }).query}`,
      meta: { scope: 'read' },
      trusted: true,
    })
    const decoded = roundTrip(tool)
    expect(Tool.isTool(decoded)).toBe(true)
    expect(decoded.name).toBe('search')
    expect(decoded.description).toBe('searches the web')
    expect(decoded.trusted).toBe(true)
    expect(decoded.meta.get('scope')).toBe('read')
    // Schema survived the validation encode/decode delegation: its describe() is intact.
    expect(decoded.inputSchema.describe()).toBeDefined()
  })

  it('a pure handler still executes after round-trip', async () => {
    const tool = new Tool({
      name: 'adder',
      description: 'adds one',
      inputSchema: validator.object({ n: validator.number().required() }),
      handler: (args: unknown) => String((args as { n: number }).n + 1),
    })
    const decoded = roundTrip(tool)
    const result = await decoded.executor(ctxStub())({ n: 41 })
    expect(result).toBe('42')
  })

  it('documents the closure caveat: captured scope is undefined after round-trip', async () => {
    const captured = 'only-in-original-scope'
    const tool = new Tool({
      name: 'leaky',
      description: 'closes over a variable',
      inputSchema: validator.object({}),
      // CLOSURE handler: `captured` lives in lexical scope, not in the source text. After
      // round-trip the rehydrated function body references a `captured` that no longer exists.
      handler: () => captured,
    })
    // Original works.
    await expect(tool.executor(ctxStub())({})).resolves.toBe('only-in-original-scope')
    // Rehydrated handler's free variable is gone — calling it throws a ReferenceError, surfaced by
    // the executor as a downstream tool error. This is the documented, accepted limitation.
    const decoded = roundTrip(tool)
    await expect(decoded.executor(ctxStub())({})).rejects.toThrow()
  })
})

describe('encoding round-trip — ArtifactTool', () => {
  it('round-trips to an ArtifactTool (not a bare Tool)', () => {
    const tool = new ArtifactTool({
      name: 'artifact_answer',
      description: 'answers from an artifact',
      inputSchema: validator.object({ q: validator.string().required() }),
      handler: (args: unknown) => `answer: ${(args as { q: string }).q}`,
    })
    const decoded = roundTrip(tool)
    expect(ArtifactTool.isArtifactTool(decoded)).toBe(true)
    expect(Tool.isTool(decoded)).toBe(true)
    expect(decoded.name).toBe('artifact_answer')
  })
})

describe('encoding round-trip — ToolRegistry', () => {
  it('round-trips tools and the hidden set', () => {
    const mk = (name: string) =>
      new Tool({
        name,
        description: name,
        inputSchema: validator.object({}),
        handler: () => name,
      })
    const registry = new ToolRegistry([mk('alpha'), mk('beta'), mk('gamma')])
    registry.setHidden('beta')

    const decoded = roundTrip(registry)
    expect(ToolRegistry.isToolRegistry(decoded)).toBe(true)
    expect(
      decoded
        .all()
        .map((t) => t.name)
        .sort()
    ).toEqual(['alpha', 'beta', 'gamma'])
    expect(decoded.hidden().map((t) => t.name)).toEqual(['beta'])
    expect(
      decoded
        .visible()
        .map((t) => t.name)
        .sort()
    ).toEqual(['alpha', 'gamma'])
  })
})
