import { validator } from '@nhtio/validation'
import { describe, expect, it } from 'vitest'
import { Tool } from '../../../src/lib/classes/tool'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { ArtifactTool } from '../../../src/lib/classes/artifact_tool'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { E_INVALID_INITIAL_TOOL_VALUE } from '../../../src/lib/exceptions/runtime'
import type { ArtifactToolHandler, RawArtifactTool } from '../../../src/lib/classes/artifact_tool'

const validRaw = () => ({
  name: 'artifact_head',
  description: 'reads the first N lines of an artifact',
  inputSchema: validator.object({ callId: validator.string().required() }),
  handler: (async () => 'first line\nsecond line') as ArtifactToolHandler,
})

describe('ArtifactTool', () => {
  describe('construction', () => {
    it('accepts a valid raw input and produces a Tool instance', () => {
      const t = new ArtifactTool(validRaw())
      expect(Tool.isTool(t)).toBe(true)
      expect(ArtifactTool.isArtifactTool(t)).toBe(true)
      expect(t.name).toBe('artifact_head')
    })

    it('defaults ephemeral to false', () => {
      const t = new ArtifactTool(validRaw())
      expect(t.ephemeral).toBe(false)
    })

    it("defaults onCollision to 'throw'", () => {
      const t = new ArtifactTool(validRaw())
      expect(t.onCollision).toBe('throw')
    })

    it('round-trips ephemeral: true', () => {
      const t = new ArtifactTool({ ...validRaw(), ephemeral: true })
      expect(t.ephemeral).toBe(true)
    })

    it.each(['throw', 'replace', 'keep'] as const)('round-trips onCollision: %s', (policy) => {
      const t = new ArtifactTool({ ...validRaw(), onCollision: policy })
      expect(t.onCollision).toBe(policy)
    })

    it('defaults trusted to false when not provided', () => {
      const t = new ArtifactTool(validRaw())
      expect(t.trusted).toBe(false)
    })

    it('round-trips trusted: true through rawArtifactToolSchema', () => {
      const t = new ArtifactTool({ ...validRaw(), trusted: true })
      expect(t.trusted).toBe(true)
    })

    it('round-trips trusted: false explicitly', () => {
      const t = new ArtifactTool({ ...validRaw(), trusted: false })
      expect(t.trusted).toBe(false)
    })

    it('rejects a non-boolean trusted at validation time', () => {
      expect(
        () =>
          new ArtifactTool({
            ...validRaw(),
            trusted: 'yes' as unknown as boolean,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })
  })

  describe('schema', () => {
    it('rejects an artifactConstructor field at construction time', () => {
      expect(
        () =>
          new ArtifactTool({
            ...validRaw(),
            // ArtifactTool explicitly forbids artifactConstructor — the whole point of the class.
            artifactConstructor: () => SpooledArtifact,
          } as unknown as RawArtifactTool)
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })

    it('rejects when handler is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.handler
      expect(() => new ArtifactTool(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TOOL_VALUE
      )
    })

    it('rejects an invalid onCollision value', () => {
      expect(
        () =>
          new ArtifactTool({
            ...validRaw(),
            onCollision: 'sometimes' as unknown as 'throw',
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_VALUE)
    })
  })

  describe('handler return types', () => {
    it('accepts a handler that returns a plain string', () => {
      const handler: ArtifactToolHandler = () => 'plain'
      const t = new ArtifactTool({ ...validRaw(), handler })
      expect(t).toBeInstanceOf(ArtifactTool)
    })

    it('accepts a handler that returns a Tokenizable directly', () => {
      const handler: ArtifactToolHandler = () => new Tokenizable('hi')
      const t = new ArtifactTool({ ...validRaw(), handler })
      expect(t).toBeInstanceOf(ArtifactTool)
    })

    it('accepts an async handler that returns either', async () => {
      const handler: ArtifactToolHandler = async () => new Tokenizable('async')
      const t = new ArtifactTool({ ...validRaw(), handler })
      expect(t).toBeInstanceOf(ArtifactTool)
    })
  })

  describe('ArtifactTool.isArtifactTool', () => {
    it('returns true for ArtifactTool instances', () => {
      expect(ArtifactTool.isArtifactTool(new ArtifactTool(validRaw()))).toBe(true)
    })

    it('returns false for plain Tool instances', () => {
      const plain = new Tool({
        name: 't',
        description: 'd',
        inputSchema: validator.object({}),
        handler: async () => 'x',
      })
      expect(ArtifactTool.isArtifactTool(plain)).toBe(false)
    })

    it('returns false for plain objects', () => {
      expect(ArtifactTool.isArtifactTool({ name: 'x' })).toBe(false)
      expect(ArtifactTool.isArtifactTool(null)).toBe(false)
      expect(ArtifactTool.isArtifactTool(undefined)).toBe(false)
    })
  })
})
