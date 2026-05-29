import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { Tool } from '../../../src/lib/classes/tool'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { SpooledJsonArtifact } from '../../../src/lib/classes/spooled_json_artifact'
import { SpooledMarkdownArtifact } from '../../../src/lib/classes/spooled_markdown_artifact'
import {
  E_INVALID_INITIAL_TOOL_VALUE,
  E_INVALID_TOOL_ARGS,
  E_TOOL_DOWNSTREAM_ERROR,
} from '../../../src/lib/exceptions/runtime'
import type { ToolHandler } from '../../../src/lib/classes/tool'
import type { DispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from '../../../src/lib/types/turn_runner'

/**
 * Builds a minimal duck-typed stub satisfying the parts of DispatchContext that
 * Tool.executor needs: `id`, `emitToolExecutionStart`, `emitToolExecutionEnd`. Real
 * DispatchContext construction is out of scope for a unit test on Tool.
 */
const makeCtxStub = () => {
  const starts: ToolExecutionStartEvent[] = []
  const ends: ToolExecutionEndEvent[] = []
  const ctx = {
    id: 'turn-1',
    emitToolExecutionStart: (e: ToolExecutionStartEvent) => starts.push(e),
    emitToolExecutionEnd: (e: ToolExecutionEndEvent) => ends.push(e),
  } as unknown as DispatchContext
  return { ctx, starts, ends }
}

const validRaw = () => ({
  name: 'search',
  description: 'searches the web',
  inputSchema: validator.object({ query: validator.string().required() }),
  handler: async () => 'results',
})

describe('Tool', () => {
  describe('construction', () => {
    it('accepts valid raw input', () => {
      const t = new Tool(validRaw())
      expect(t.name).toBe('search')
      expect(t.description).toBe('searches the web')
      expect(t.inputSchema).toBeDefined()
    })

    it('defaults meta to an empty Registry when not provided', () => {
      const t = new Tool(validRaw())
      expect(t.meta).toBeDefined()
      expect(t.meta.all()).toEqual({})
    })

    it('accepts arbitrary meta and exposes it via dot-path access', () => {
      const t = new Tool({ ...validRaw(), meta: { scopes: ['read'], feature: 'beta' } })
      expect(t.meta.get('scopes')).toEqual(['read'])
      expect(t.meta.get('feature')).toBe('beta')
    })

    it('leaves artifactConstructor undefined when not provided', () => {
      // Intentional: tool.ts cannot eagerly reference SpooledArtifact (module-load cycle), so
      // the field has no default. Wrap-sites supply `?? SpooledArtifact` themselves.
      const t = new Tool(validRaw())
      expect(t.artifactConstructor).toBeUndefined()
    })

    it('accepts a resolver returning SpooledJsonArtifact', () => {
      const t = new Tool({ ...validRaw(), artifactConstructor: () => SpooledJsonArtifact })
      expect(t.artifactConstructor?.()).toBe(SpooledJsonArtifact)
    })

    it('accepts a resolver returning SpooledMarkdownArtifact', () => {
      const t = new Tool({ ...validRaw(), artifactConstructor: () => SpooledMarkdownArtifact })
      expect(t.artifactConstructor?.()).toBe(SpooledMarkdownArtifact)
    })

    it('accepts a resolver returning a user-defined SpooledArtifact subclass', () => {
      class CustomArtifact extends SpooledArtifact {}
      const t = new Tool({ ...validRaw(), artifactConstructor: () => CustomArtifact })
      expect(t.artifactConstructor?.()).toBe(CustomArtifact)
    })

    it('defaults ephemeral to false when not provided', () => {
      const t = new Tool(validRaw())
      expect(t.ephemeral).toBe(false)
    })

    it('round-trips ephemeral: true through rawToolSchema', () => {
      const t = new Tool({ ...validRaw(), ephemeral: true })
      expect(t.ephemeral).toBe(true)
    })

    it('round-trips ephemeral: false explicitly', () => {
      const t = new Tool({ ...validRaw(), ephemeral: false })
      expect(t.ephemeral).toBe(false)
    })

    it("defaults onCollision to 'throw' when not provided", () => {
      const t = new Tool(validRaw())
      expect(t.onCollision).toBe('throw')
    })

    it.each(['throw', 'replace', 'keep'] as const)(
      'round-trips onCollision: %s through rawToolSchema',
      (policy) => {
        const t = new Tool({ ...validRaw(), onCollision: policy })
        expect(t.onCollision).toBe(policy)
      }
    )

    it('rejects an invalid onCollision string at validation time', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            onCollision: 'sometimes' as unknown as 'throw',
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('defaults trusted to false when not provided', () => {
      const t = new Tool(validRaw())
      expect(t.trusted).toBe(false)
    })

    it('round-trips trusted: true through rawToolSchema', () => {
      const t = new Tool({ ...validRaw(), trusted: true })
      expect(t.trusted).toBe(true)
    })

    it('round-trips trusted: false explicitly', () => {
      const t = new Tool({ ...validRaw(), trusted: false })
      expect(t.trusted).toBe(false)
    })

    it('rejects a non-boolean trusted at validation time', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            trusted: 'yes' as unknown as boolean,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })
  })

  describe('validation', () => {
    it('throws when name is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.name
      expect(() => new Tool(r as ReturnType<typeof validRaw>)).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when description is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.description
      expect(() => new Tool(r as ReturnType<typeof validRaw>)).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when inputSchema is not a validation Schema', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            inputSchema: { type: 'object' } as unknown as ReturnType<typeof validator.object>,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when inputSchema is not an object-typed schema', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            inputSchema: validator.string() as unknown as ReturnType<typeof validator.object>,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when handler is not a function', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            handler: 'not a function' as unknown as ReturnType<typeof validRaw>['handler'],
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when artifactConstructor is not a function', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            artifactConstructor: 42 as unknown as () => typeof SpooledArtifact,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when the resolver returns a non-SpooledArtifact constructor', () => {
      class NotAnArtifact {}
      expect(
        () =>
          new Tool({
            ...validRaw(),
            artifactConstructor: (() => NotAnArtifact) as unknown as () => typeof SpooledArtifact,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when the resolver returns a plain Object reference', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            artifactConstructor: (() => Object) as unknown as () => typeof SpooledArtifact,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('throws when the resolver itself throws', () => {
      expect(
        () =>
          new Tool({
            ...validRaw(),
            artifactConstructor: (() => {
              throw new Error('boom')
            }) as unknown as () => typeof SpooledArtifact,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })
  })

  describe('validate', () => {
    it('returns the validated args on success', async () => {
      const t = new Tool(validRaw())
      const result = await t.validate({ query: 'hello' })
      expect(result).toEqual({ query: 'hello' })
    })

    it('throws E_INVALID_TOOL_ARGS when args fail validation', async () => {
      const t = new Tool(validRaw())
      await expect(t.validate({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
  })

  describe('executor', () => {
    it('runs the handler and returns its raw bytes', async () => {
      const t = new Tool(validRaw())
      const { ctx } = makeCtxStub()
      const result = await t.executor(ctx)({ query: 'hello' })
      expect(result).toBe('results')
    })

    it('returns a Uint8Array when the handler produces binary output', async () => {
      const bytes = new Uint8Array([0x68, 0x69])
      const t = new Tool({ ...validRaw(), handler: async () => bytes })
      const { ctx } = makeCtxStub()
      const result = await t.executor(ctx)({ query: 'hello' })
      expect(result).toBe(bytes)
    })

    it('emits toolExecutionStart before invoking the handler', async () => {
      const handler = vi.fn<ToolHandler>(async () => 'ok')
      const t = new Tool({ ...validRaw(), handler })
      const { ctx, starts } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      expect(starts).toHaveLength(1)
      expect(starts[0].toolName).toBe('search')
      expect(starts[0].turnId).toBe('turn-1')
      expect(starts[0].args).toEqual({ query: 'hello' })
    })

    it('populates callId on toolExecutionStart as a non-empty SHA-256 hex string', async () => {
      const t = new Tool(validRaw())
      const { ctx, starts } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      expect(starts[0].callId).toMatch(/^[0-9a-f]{64}$/)
    })

    it('populates the same callId on toolExecutionEnd as on toolExecutionStart', async () => {
      const t = new Tool(validRaw())
      const { ctx, starts, ends } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      expect(ends[0].callId).toBe(starts[0].callId)
    })

    it('produces the same callId for two invocations with identical args', async () => {
      const t = new Tool(validRaw())
      const { ctx: ctx1, starts: starts1 } = makeCtxStub()
      const { ctx: ctx2, starts: starts2 } = makeCtxStub()
      await t.executor(ctx1)({ query: 'hello' })
      await t.executor(ctx2)({ query: 'hello' })
      expect(starts1[0].callId).toBe(starts2[0].callId)
    })

    it('produces different callIds for two invocations with different args', async () => {
      const t = new Tool(validRaw())
      const { ctx: ctx1, starts: starts1 } = makeCtxStub()
      const { ctx: ctx2, starts: starts2 } = makeCtxStub()
      await t.executor(ctx1)({ query: 'hello' })
      await t.executor(ctx2)({ query: 'world' })
      expect(starts1[0].callId).not.toBe(starts2[0].callId)
    })

    it('produces the same callId regardless of argument key order (canonical hashing)', async () => {
      const schema = validator.object({
        a: validator.string().required(),
        b: validator.string().required(),
      })
      const t = new Tool({ ...validRaw(), inputSchema: schema })
      const { ctx: ctx1, starts: starts1 } = makeCtxStub()
      const { ctx: ctx2, starts: starts2 } = makeCtxStub()
      await t.executor(ctx1)({ a: '1', b: '2' })
      await t.executor(ctx2)({ b: '2', a: '1' })
      expect(starts1[0].callId).toBe(starts2[0].callId)
    })

    it('emits toolExecutionEnd with isError: false on success', async () => {
      const t = new Tool(validRaw())
      const { ctx, ends } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      expect(ends).toHaveLength(1)
      expect(ends[0].isError).toBe(false)
      expect(ends[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits toolExecutionEnd with isError: true and wraps the error in E_TOOL_DOWNSTREAM_ERROR when the handler throws', async () => {
      const t = new Tool({
        ...validRaw(),
        handler: async () => {
          throw new Error('downstream failure')
        },
      })
      const { ctx, ends } = makeCtxStub()
      await expect(t.executor(ctx)({ query: 'hello' })).rejects.toBeInstanceOf(
        E_TOOL_DOWNSTREAM_ERROR
      )
      expect(ends).toHaveLength(1)
      expect(ends[0].isError).toBe(true)
    })

    it('rejects with E_INVALID_TOOL_ARGS when args fail validation (handler never runs)', async () => {
      const handler = vi.fn<ToolHandler>(async () => 'ok')
      const t = new Tool({ ...validRaw(), handler })
      const { ctx, starts, ends } = makeCtxStub()
      await expect(t.executor(ctx)({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
      expect(handler).not.toHaveBeenCalled()
      expect(starts).toHaveLength(0)
      expect(ends).toHaveLength(0)
    })

    it('passes the active DispatchContext to the handler', async () => {
      const handler = vi.fn<ToolHandler>(async () => 'ok')
      const t = new Tool({ ...validRaw(), handler })
      const { ctx } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      expect(handler).toHaveBeenCalledOnce()
      const [args, passedCtx] = handler.mock.calls[0]
      expect(args).toEqual({ query: 'hello' })
      expect(passedCtx).toBe(ctx)
    })

    it('passes the tool meta Registry to the handler', async () => {
      const handler = vi.fn<ToolHandler>(async () => 'ok')
      const t = new Tool({ ...validRaw(), handler, meta: { scope: 'read' } })
      const { ctx } = makeCtxStub()
      await t.executor(ctx)({ query: 'hello' })
      const [, , meta] = handler.mock.calls[0]
      expect((meta as { get: (k: string) => unknown }).get('scope')).toBe('read')
    })
  })

  describe('describe', () => {
    it('returns name, description, and the schema description', () => {
      const t = new Tool(validRaw())
      const d = t.describe()
      expect(d.name).toBe('search')
      expect(d.description).toBe('searches the web')
      expect(d.inputSchema).toBeDefined()
      expect(typeof d.inputSchema).toBe('object')
    })
  })

  describe('Tool.isTool', () => {
    it('returns true for Tool instances', () => {
      expect(Tool.isTool(new Tool(validRaw()))).toBe(true)
    })

    it('returns false for plain objects of the same shape', () => {
      expect(Tool.isTool(validRaw())).toBe(false)
    })
  })
})
