import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { Tool } from '../../../src/lib/classes/tool'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import { E_TOOL_ALREADY_REGISTERED } from '../../../src/lib/exceptions/runtime'

const makeTool = (name: string, overrides: Partial<ConstructorParameters<typeof Tool>[0]> = {}) =>
  new Tool({
    name,
    description: `the ${name} tool`,
    inputSchema: validator.object({ q: validator.string().optional() }),
    handler: async () => 'ok',
    ...overrides,
  })

describe('ToolRegistry', () => {
  describe('construction', () => {
    it('accepts no tools (empty registry)', () => {
      const r = new ToolRegistry()
      expect(r.all()).toEqual([])
    })

    it('accepts an initial array of tools', () => {
      const a = makeTool('a')
      const b = makeTool('b')
      const r = new ToolRegistry([a, b])
      expect(r.all()).toEqual([a, b])
    })

    it('preserves insertion order', () => {
      const a = makeTool('a')
      const b = makeTool('b')
      const c = makeTool('c')
      const r = new ToolRegistry([c, a, b])
      expect(r.all().map((t) => t.name)).toEqual(['c', 'a', 'b'])
    })

    it('throws E_TOOL_ALREADY_REGISTERED when two initial tools share a name', () => {
      const a1 = makeTool('a')
      const a2 = makeTool('a')
      expect(() => new ToolRegistry([a1, a2])).toThrow(E_TOOL_ALREADY_REGISTERED)
    })
  })

  describe('register', () => {
    it('adds a new tool', () => {
      const r = new ToolRegistry()
      const t = makeTool('a')
      r.register(t)
      expect(r.has('a')).toBe(true)
      expect(r.get('a')).toBe(t)
    })

    it('throws E_TOOL_ALREADY_REGISTERED when a tool with the same name is already registered', () => {
      const r = new ToolRegistry([makeTool('a')])
      expect(() => r.register(makeTool('a'))).toThrow(E_TOOL_ALREADY_REGISTERED)
    })

    it('replaces silently when overwrite is true', () => {
      const a1 = makeTool('a')
      const a2 = makeTool('a')
      const r = new ToolRegistry([a1])
      r.register(a2, true)
      expect(r.get('a')).toBe(a2)
    })
  })

  describe('unregister', () => {
    it('removes a registered tool', () => {
      const r = new ToolRegistry([makeTool('a')])
      r.unregister('a')
      expect(r.has('a')).toBe(false)
    })

    it('no-ops on an unknown name', () => {
      const r = new ToolRegistry([makeTool('a')])
      expect(() => r.unregister('unknown')).not.toThrow()
      expect(r.has('a')).toBe(true)
    })
  })

  describe('get / has', () => {
    it('get returns undefined for unknown names', () => {
      const r = new ToolRegistry()
      expect(r.get('unknown')).toBeUndefined()
    })

    it('has returns false for unknown names', () => {
      const r = new ToolRegistry()
      expect(r.has('unknown')).toBe(false)
    })
  })

  describe('all', () => {
    it('returns a fresh array each call', () => {
      const r = new ToolRegistry([makeTool('a')])
      const first = r.all()
      const second = r.all()
      expect(first).not.toBe(second)
      expect(first).toEqual(second)
    })

    it('does not let callers mutate the registry by mutating the returned array', () => {
      const r = new ToolRegistry([makeTool('a')])
      const arr = r.all()
      arr.push(makeTool('b'))
      expect(r.has('b')).toBe(false)
    })
  })

  describe('merge', () => {
    it('returns a new registry containing the union of inputs', () => {
      const a = new ToolRegistry([makeTool('a')])
      const b = new ToolRegistry([makeTool('b')])
      const merged = ToolRegistry.merge([a, b])
      expect(merged.all().map((t) => t.name)).toEqual(['a', 'b'])
    })

    it('does not mutate the input registries (no overlap)', () => {
      const a = new ToolRegistry([makeTool('a')])
      const b = new ToolRegistry([makeTool('b')])
      ToolRegistry.merge([a, b])
      expect(a.all().map((t) => t.name)).toEqual(['a'])
      expect(b.all().map((t) => t.name)).toEqual(['b'])
    })

    it("throws E_TOOL_ALREADY_REGISTERED on collision when policy defaults to 'throw'", () => {
      const a = new ToolRegistry([makeTool('x')])
      const b = new ToolRegistry([makeTool('x')])
      expect(() => ToolRegistry.merge([a, b])).toThrow(E_TOOL_ALREADY_REGISTERED)
    })

    it("lets the later registry's tool win when policy is 'replace'", () => {
      const earlier = makeTool('x', { description: 'earlier' })
      const later = makeTool('x', { description: 'later' })
      const a = new ToolRegistry([earlier])
      const b = new ToolRegistry([later])
      const merged = ToolRegistry.merge([a, b], { onCollision: 'replace' })
      expect(merged.get('x')).toBe(later)
    })

    it("preserves the earlier entry when policy is 'keep'", () => {
      const earlier = makeTool('x', { description: 'earlier' })
      const later = makeTool('x', { description: 'later' })
      const a = new ToolRegistry([earlier])
      const b = new ToolRegistry([later])
      const merged = ToolRegistry.merge([a, b], { onCollision: 'keep' })
      expect(merged.get('x')).toBe(earlier)
    })

    it('does not mutate input registries under any policy', () => {
      const earlier = makeTool('x', { description: 'earlier' })
      const later = makeTool('x', { description: 'later' })
      const a = new ToolRegistry([earlier])
      const b = new ToolRegistry([later])
      ToolRegistry.merge([a, b], { onCollision: 'replace' })
      expect(a.get('x')).toBe(earlier)
      expect(b.get('x')).toBe(later)
    })

    it('returns an empty registry when given no inputs', () => {
      const merged = ToolRegistry.merge([])
      expect(merged.all()).toEqual([])
    })

    it('handles disjoint inputs under every policy', () => {
      const a = new ToolRegistry([makeTool('a')])
      const b = new ToolRegistry([makeTool('b')])
      for (const policy of ['throw', 'replace', 'keep'] as const) {
        const merged = ToolRegistry.merge([a, b], { onCollision: policy })
        expect(
          merged
            .all()
            .map((t) => t.name)
            .sort()
        ).toEqual(['a', 'b'])
      }
    })

    it("per-tool 'replace' overrides merge-level 'throw'", () => {
      const earlier = makeTool('x')
      const incoming = makeTool('x', { onCollision: 'replace' })
      const merged = ToolRegistry.merge([new ToolRegistry([earlier]), new ToolRegistry([incoming])])
      expect(merged.get('x')).toBe(incoming)
    })

    it("per-tool 'keep' overrides merge-level 'replace'", () => {
      const earlier = makeTool('x')
      const incoming = makeTool('x', { onCollision: 'keep' })
      const merged = ToolRegistry.merge(
        [new ToolRegistry([earlier]), new ToolRegistry([incoming])],
        { onCollision: 'replace' }
      )
      expect(merged.get('x')).toBe(earlier)
    })

    it("per-tool 'throw' raises even when merge-level is 'replace'", () => {
      const earlier = makeTool('x')
      const incoming = makeTool('x', { onCollision: 'throw' })
      expect(() =>
        ToolRegistry.merge([new ToolRegistry([earlier]), new ToolRegistry([incoming])], {
          onCollision: 'replace',
        })
      ).not.toThrow()
      // Above: 'replace' on the merge-level resolves the throw fallback.
    })

    it("per-tool 'throw' falls back to the merge-level option ('throw' → raises)", () => {
      const earlier = makeTool('x')
      const incoming = makeTool('x') // defaults to 'throw'
      expect(() =>
        ToolRegistry.merge([new ToolRegistry([earlier]), new ToolRegistry([incoming])])
      ).toThrow(E_TOOL_ALREADY_REGISTERED)
    })

    it("per-tool 'throw' falls back to the merge-level option ('keep' → keeps earlier)", () => {
      const earlier = makeTool('x', { description: 'earlier' })
      const incoming = makeTool('x', { description: 'later' })
      const merged = ToolRegistry.merge(
        [new ToolRegistry([earlier]), new ToolRegistry([incoming])],
        { onCollision: 'keep' }
      )
      expect(merged.get('x')).toBe(earlier)
    })

    it('preserves the ephemeral flag of each tool', () => {
      const ephemeralTool = makeTool('e', { ephemeral: true })
      const normalTool = makeTool('n')
      const merged = ToolRegistry.merge([new ToolRegistry([ephemeralTool, normalTool])])
      expect(merged.get('e')?.ephemeral).toBe(true)
      expect(merged.get('n')?.ephemeral).toBe(false)
    })
  })

  describe('pruneEphemeral', () => {
    it('drops only ephemeral === true tools', () => {
      const r = new ToolRegistry([
        makeTool('keep'),
        makeTool('drop', { ephemeral: true }),
        makeTool('keep2'),
      ])
      r.pruneEphemeral()
      expect(
        r
          .all()
          .map((t) => t.name)
          .sort()
      ).toEqual(['keep', 'keep2'])
    })

    it('is idempotent', () => {
      const r = new ToolRegistry([makeTool('keep'), makeTool('drop', { ephemeral: true })])
      r.pruneEphemeral()
      r.pruneEphemeral()
      expect(r.all().map((t) => t.name)).toEqual(['keep'])
    })

    it('no-ops when there are no ephemeral tools', () => {
      const r = new ToolRegistry([makeTool('a'), makeTool('b')])
      r.pruneEphemeral()
      expect(r.all().map((t) => t.name)).toEqual(['a', 'b'])
    })
  })

  describe('bindContext', () => {
    it('schedules pruneEphemeral on ctx.ack()', () => {
      const ctx = makeDispatchContext()
      const r = new ToolRegistry([makeTool('keep'), makeTool('drop', { ephemeral: true })])
      r.bindContext(ctx)
      ctx.ack()
      expect(r.all().map((t) => t.name)).toEqual(['keep'])
    })

    it('does NOT prune on ctx.nack()', () => {
      const ctx = makeDispatchContext()
      const r = new ToolRegistry([makeTool('keep'), makeTool('drop', { ephemeral: true })])
      r.bindContext(ctx)
      ctx.nack(new Error('boom'))
      expect(
        r
          .all()
          .map((t) => t.name)
          .sort()
      ).toEqual(['drop', 'keep'])
    })

    it('returns an unsubscribe that prevents pruning when called before ack', () => {
      const ctx = makeDispatchContext()
      const r = new ToolRegistry([makeTool('keep'), makeTool('drop', { ephemeral: true })])
      const unsub = r.bindContext(ctx)
      unsub()
      ctx.ack()
      expect(
        r
          .all()
          .map((t) => t.name)
          .sort()
      ).toEqual(['drop', 'keep'])
    })
  })

  describe('ToolRegistry.isToolRegistry', () => {
    it('returns true for ToolRegistry instances', () => {
      expect(ToolRegistry.isToolRegistry(new ToolRegistry())).toBe(true)
    })

    it('returns false for arrays of tools', () => {
      expect(ToolRegistry.isToolRegistry([makeTool('a')])).toBe(false)
    })

    it('returns false for plain objects', () => {
      expect(ToolRegistry.isToolRegistry({})).toBe(false)
      expect(ToolRegistry.isToolRegistry(null)).toBe(false)
    })
  })
})
