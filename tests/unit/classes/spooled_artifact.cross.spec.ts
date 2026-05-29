import { describe, expect, it } from 'vitest'
import { promisify } from '../../_fixtures/promisified'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { ArtifactTool } from '../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../_fixtures/primitives'
import { E_NOT_A_SPOOL_READER, E_INVALID_TOOL_ARGS } from '../../../src/lib/exceptions/runtime'

const SAMPLE = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n')

describe('SpooledArtifact', () => {
  describe('construction', () => {
    it('accepts a sync SpoolReader', () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(SpooledArtifact.isSpooledArtifact(a)).toBe(true)
    })

    it('accepts an async SpoolReader', () => {
      const a = new SpooledArtifact(promisify(new InMemorySpoolReader(SAMPLE)))
      expect(SpooledArtifact.isSpooledArtifact(a)).toBe(true)
    })

    it('throws E_NOT_A_SPOOL_READER when given a value that does not implement SpoolReader', () => {
      expect(() => new SpooledArtifact({} as unknown as InMemorySpoolReader)).toThrow(
        E_NOT_A_SPOOL_READER
      )
      expect(() => new SpooledArtifact(null as unknown as InMemorySpoolReader)).toThrow(
        E_NOT_A_SPOOL_READER
      )
    })
  })

  describe('byteLength / lineCount', () => {
    it('reports byteLength from the reader', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.byteLength()).toBe(SAMPLE.length)
    })

    it('reports lineCount from the reader', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.lineCount()).toBe(5)
    })
  })

  describe('head', () => {
    it('returns the first n lines', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.head(3)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('defaults to the first 10 lines (or fewer when available)', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.head()).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
    })

    it('caps to available line count when n exceeds total lines', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.head(100)).toHaveLength(5)
    })
  })

  describe('tail', () => {
    it('returns the last n lines', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.tail(2)).toEqual(['delta', 'epsilon'])
    })

    it('caps to available line count when n exceeds total lines', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.tail(100)).toHaveLength(5)
    })
  })

  describe('grep', () => {
    it('returns only lines that match the pattern', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.grep(/a$/)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    })

    it('returns an empty array when no lines match', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.grep(/^omega$/)).toEqual([])
    })

    it('respects regex case-sensitivity flags', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.grep(/ALPHA/i)).toEqual(['alpha'])
    })

    it('resets lastIndex per line so stateful flags (g, y) do not skip matches', async () => {
      // With the `g` flag, `RegExp.test` advances lastIndex across calls — without the per-line
      // reset, the second test against 'beta' would start from lastIndex 5 (past the string) and
      // return false. grep() must reset lastIndex so per-line matching stays stateless.
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.grep(/a/g)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    })

    it('sticky-flag (y) patterns still match line starts after reset', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.grep(/a/y)).toEqual(['alpha'])
    })
  })

  describe('cat', () => {
    it('returns all lines by default', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.cat()).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
    })

    it('respects start and end as a half-open range [start, end)', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.cat(1, 4)).toEqual(['beta', 'gamma', 'delta'])
    })

    it('clamps start below 0 to 0', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.cat(-5, 2)).toEqual(['alpha', 'beta'])
    })

    it('clamps end past the line count to lineCount', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.cat(3, 100)).toEqual(['delta', 'epsilon'])
    })
  })

  describe('estimateTokens', () => {
    it('returns a positive count under a known encoding', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      const count = await a.estimateTokens('cl100k_base')
      expect(count).toBeGreaterThan(0)
    })

    it('counts byte-faithful content (readAll), not the line-join approximation', async () => {
      // CRLF + trailing-newline payload exercises the difference: cat().join('\n') would collapse
      // '\r\n' to '\n' and drop the trailing terminator. readAll() preserves them, so the token
      // count should match Tokenizable.estimateTokens against the original bytes.
      const payload = 'alpha\r\nbeta\ngamma\n'
      const a = new SpooledArtifact(new InMemorySpoolReader(payload))
      expect(await a.estimateTokens('cl100k_base')).toBe(
        Tokenizable.estimateTokens(payload, 'cl100k_base')
      )
    })
  })

  describe('SpooledArtifact.isSpooledArtifact', () => {
    it('returns true for SpooledArtifact instances', () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(SpooledArtifact.isSpooledArtifact(a)).toBe(true)
    })

    it('returns false for plain objects and other values', () => {
      expect(SpooledArtifact.isSpooledArtifact({})).toBe(false)
      expect(SpooledArtifact.isSpooledArtifact(null)).toBe(false)
      expect(SpooledArtifact.isSpooledArtifact('not an artifact')).toBe(false)
    })
  })

  describe('asString', () => {
    it('round-trips byte content exactly', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      expect(await a.asString()).toBe(SAMPLE)
    })

    it('preserves a trailing newline (which cat() discards)', async () => {
      const body = 'a\nb\nc\n'
      const a = new SpooledArtifact(new InMemorySpoolReader(body))
      expect(await a.asString()).toBe(body)
    })

    it('returns an empty string for empty content', async () => {
      const a = new SpooledArtifact(new InMemorySpoolReader(''))
      expect(await a.asString()).toBe('')
    })

    it('preserves non-\\n line terminators (e.g. CRLF)', async () => {
      const body = 'one\r\ntwo\r\nthree'
      const a = new SpooledArtifact(new InMemorySpoolReader(body))
      expect(await a.asString()).toBe(body)
    })

    it('works against an async reader', async () => {
      const a = new SpooledArtifact(promisify(new InMemorySpoolReader(SAMPLE)))
      expect(await a.asString()).toBe(SAMPLE)
    })
  })

  describe('forgeTools', () => {
    it('returns an empty registry when ctx.turnToolCalls has no artifacts', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('emits ArtifactTool instances with ephemeral=true and onCollision=replace', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-abc')
      const tc = makeToolCall(artifact, { id: 'tc-abc' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const registry = SpooledArtifact.forgeTools(ctx)
      expect(registry.all().length).toBeGreaterThan(0)
      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
        expect(tool.ephemeral).toBe(true)
        expect(tool.onCollision).toBe('replace')
      }
    })

    it('includes the base seven artifact_* tools when a base artifact is present', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-base')
      const tc = makeToolCall(artifact, { id: 'tc-base' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const registry = SpooledArtifact.forgeTools(ctx)
      const names = registry
        .all()
        .map((t) => t.name)
        .sort()
      expect(names).toEqual(
        [
          'artifact_byte_length',
          'artifact_cat',
          'artifact_estimate_tokens',
          'artifact_grep',
          'artifact_head',
          'artifact_line_count',
          'artifact_tail',
        ].sort()
      )
    })

    it("populates each tool's callId enum from the available callIds", async () => {
      const { artifact: a1 } = await makeSpooledArtifact(SAMPLE, 'tc-1')
      const { artifact: a2 } = await makeSpooledArtifact(SAMPLE, 'tc-2')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(a1, { id: 'tc-1' }), makeToolCall(a2, { id: 'tc-2' })],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const head = registry.get('artifact_head')!
      const description = head.describe().inputSchema as Record<string, unknown>
      // Schema `.valid(...)` values surface as `allow` in joi's describe output.
      // Walk the structure pragmatically — we only need to confirm both ids appear somewhere.
      const dump = JSON.stringify(description)
      expect(dump).toContain('tc-1')
      expect(dump).toContain('tc-2')
    })

    it('rejects an unknown callId at args-validation time (E_INVALID_TOOL_ARGS)', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-only')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(artifact, { id: 'tc-only' })],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const head = registry.get('artifact_head')!
      await expect(head.validate({ callId: 'tc-nope', n: 1 })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('rejects grep flags g and y at args-validation time', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-flags')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(artifact, { id: 'tc-flags' })],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const grep = registry.get('artifact_grep')!
      await expect(
        grep.validate({ callId: 'tc-flags', pattern: 'a', flags: 'g' })
      ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
      await expect(
        grep.validate({ callId: 'tc-flags', pattern: 'a', flags: 'y' })
      ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
      await expect(
        grep.validate({ callId: 'tc-flags', pattern: 'a', flags: 'gi' })
      ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('serialises an empty-array method result to "(empty list)" instead of ""', async () => {
      // Empty result vs absent result must be distinguishable for the model. defaultSerialise
      // returns a sentinel string for empty arrays so a forged tool's output is never ''.
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-empty')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(artifact, { id: 'tc-empty' })],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const grep = registry.get('artifact_grep')!
      // Pattern '^zzzzz$' matches nothing in SAMPLE.
      const result = await grep.executor(ctx)({
        callId: 'tc-empty',
        pattern: '^zzzzz$',
      })
      expect(result).toBe('(empty list)')
    })

    it('accepts grep flags i, m, s, u', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-flags-ok')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(artifact, { id: 'tc-flags-ok' })],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const grep = registry.get('artifact_grep')!
      await expect(
        grep.validate({ callId: 'tc-flags-ok', pattern: 'a', flags: 'imsu' })
      ).resolves.toBeDefined()
    })

    it('excludes ToolCalls with fromArtifactTool=true from the callId enum', async () => {
      const { artifact } = await makeSpooledArtifact(SAMPLE, 'tc-real')
      const { artifact: aFromArtifact } = await makeSpooledArtifact(SAMPLE, 'tc-fromArtifact')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(artifact, { id: 'tc-real' }),
          makeToolCall(aFromArtifact, { id: 'tc-fromArtifact', fromArtifactTool: true }),
        ],
      })
      const registry = SpooledArtifact.forgeTools(ctx)
      const head = registry.get('artifact_head')!
      const dump = JSON.stringify(head.describe().inputSchema)
      expect(dump).toContain('tc-real')
      expect(dump).not.toContain('tc-fromArtifact')
    })
  })

  describe('async reader support', () => {
    it('produces identical results to a sync reader for the same content', async () => {
      const syncA = new SpooledArtifact(new InMemorySpoolReader(SAMPLE))
      const asyncA = new SpooledArtifact(promisify(new InMemorySpoolReader(SAMPLE)))
      expect(await asyncA.head(2)).toEqual(await syncA.head(2))
      expect(await asyncA.grep(/a$/)).toEqual(await syncA.grep(/a$/))
      expect(await asyncA.byteLength()).toEqual(await syncA.byteLength())
    })
  })
})
