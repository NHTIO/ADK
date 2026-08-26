import { describe, expect, it } from 'vitest'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { ArtifactTool } from '../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import { E_INVALID_TOOL_ARGS } from '../../../src/lib/exceptions/runtime'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../_fixtures/primitives'
import { SpooledJsonArtifact } from '../../../src/lib/classes/spooled_json_artifact'

const JSON_OBJECT = '{"name":"alice","age":30,"tags":["dev","admin"]}'
const JSON_ARRAY = '[1,2,3,4,5]'
const JSONL = ['{"id":1,"role":"user"}', '{"id":2,"role":"admin"}', '{"id":3,"role":"user"}'].join(
  '\n'
)
const JSON5_CONTENT = `{
  // a comment
  name: 'alice',
  age: 30,
  trailing: 'comma allowed',
}`

const make = (content: string, format?: 'json' | 'json5' | 'jsonl' | 'ndjson') =>
  new SpooledJsonArtifact(new InMemorySpoolReader(content), format)

describe('SpooledJsonArtifact', () => {
  describe('json_type (format detection)', () => {
    it('infers strict JSON when not specified', async () => {
      expect(await make(JSON_OBJECT).json_type()).toBe('json')
    })

    it('infers jsonl when content is newline-delimited JSON', async () => {
      expect(await make(JSONL).json_type()).toBe('jsonl')
    })

    it('infers json5 when content needs JSON5 to parse', async () => {
      expect(await make(JSON5_CONTENT).json_type()).toBe('json5')
    })

    it('respects an explicit format hint over inference', async () => {
      expect(await make(JSONL, 'jsonl').json_type()).toBe('jsonl')
    })
  })

  describe('json_length', () => {
    it('returns 1 for a single JSON value', async () => {
      expect(await make(JSON_OBJECT).json_length()).toBe(1)
    })

    it('returns the number of non-empty lines for jsonl', async () => {
      expect(await make(JSONL).json_length()).toBe(3)
    })
  })

  describe('json_keys', () => {
    it('returns the root-object keys for a plain JSON object', async () => {
      expect(await make(JSON_OBJECT).json_keys()).toEqual(['name', 'age', 'tags'])
    })

    it('returns undefined when the root is an array (not an object)', async () => {
      expect(await make(JSON_ARRAY).json_keys()).toBeUndefined()
    })

    it('returns the union of keys across all records for jsonl', async () => {
      const keys = await make(JSONL).json_keys()
      expect(keys).toEqual(expect.arrayContaining(['id', 'role']))
    })
  })

  describe('json_get (JSONPath)', () => {
    it('extracts a property from a JSON object via $.path', async () => {
      const result = await make(JSON_OBJECT).json_get('$.name')
      expect(result).toEqual(['alice'])
    })

    it('returns an empty array when path matches nothing', async () => {
      expect(await make(JSON_OBJECT).json_get('$.nonexistent')).toEqual([])
    })

    it('flattens matches across jsonl records', async () => {
      const ids = await make(JSONL).json_get('$.id')
      expect(ids).toEqual([1, 2, 3])
    })
  })

  describe('json_slice', () => {
    it('returns a single-element array for json format regardless of args', async () => {
      const slice = await make(JSON_OBJECT).json_slice(0, 0)
      expect(slice).toHaveLength(1)
    })

    it('slices jsonl records like Array.prototype.slice', async () => {
      const slice = await make(JSONL).json_slice(1, 3)
      expect(slice).toHaveLength(2)
      expect((slice[0] as { id: number }).id).toBe(2)
    })
  })

  describe('json_filter', () => {
    it('returns records where the path resolves to at least one match', async () => {
      // $.role matches every record that has a role property (all three)
      const withRole = await make(JSONL).json_filter('$.role')
      expect(withRole).toHaveLength(3)
    })

    it('returns an empty array when the path matches nothing on any record', async () => {
      const none = await make(JSONL).json_filter('$.nonexistent')
      expect(none).toHaveLength(0)
    })
  })

  describe('json_pluck', () => {
    it('flattens matches across all records', async () => {
      const roles = await make(JSONL).json_pluck('$.role')
      expect(roles).toEqual(['user', 'admin', 'user'])
    })
  })

  describe('SpooledJsonArtifact.isSpooledJsonArtifact', () => {
    it('returns true for SpooledJsonArtifact instances', () => {
      expect(SpooledJsonArtifact.isSpooledJsonArtifact(make(JSON_OBJECT))).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledJsonArtifact.isSpooledJsonArtifact({})).toBe(false)
      expect(SpooledJsonArtifact.isSpooledJsonArtifact(null)).toBe(false)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + json_* tools when the turn has a JSON artifact', async () => {
      const jsonArtifact = new SpooledJsonArtifact(new InMemorySpoolReader(JSON_OBJECT))
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(jsonArtifact, { id: 'tc-json' })],
      })
      const registry = SpooledJsonArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)
      // Base set
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      // JSON-specific
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_json_type',
          'artifact_json_keys',
          'artifact_json_length',
          'artifact_json_get',
          'artifact_json_filter',
          'artifact_json_slice',
          'artifact_json_pluck',
        ])
      )
      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('discovers retrievable-backed JSON artifacts through JSON forged tools', () => {
      const artifact = make(JSON_OBJECT)
      const r = new Retrievable({
        id: 'ret-json',
        content: artifact,
        trustTier: 'first-party',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      })
      const registry = SpooledJsonArtifact.forgeTools(makeDispatchContext({ retrievables: [r] }))
      expect(JSON.stringify(registry.get('artifact_json_get')!.describe().inputSchema)).toContain(
        'ret-json'
      )
    })

    it('restricts artifact_json_* callId enum to JSON artifacts; base tools see every artifact', async () => {
      const jsonArtifact = new SpooledJsonArtifact(new InMemorySpoolReader(JSON_OBJECT))
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb\nc', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(jsonArtifact, { id: 'tc-json' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledJsonArtifact.forgeTools(ctx)
      const jsonGet = registry.get('artifact_json_get')!
      const baseHead = registry.get('artifact_head')!
      const jsonGetDump = JSON.stringify(jsonGet.describe().inputSchema)
      const baseHeadDump = JSON.stringify(baseHead.describe().inputSchema)
      expect(jsonGetDump).toContain('tc-json')
      expect(jsonGetDump).not.toContain('tc-base')
      // Base methods come from SpooledArtifact.forgeTools and accept any SpooledArtifact
      // (including subclasses) — that's the whole point of inheritance.
      expect(baseHeadDump).toContain('tc-json')
      expect(baseHeadDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_json_get at validation time', async () => {
      const jsonArtifact = new SpooledJsonArtifact(new InMemorySpoolReader(JSON_OBJECT))
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(jsonArtifact, { id: 'tc-json' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledJsonArtifact.forgeTools(ctx)
      const jsonGet = registry.get('artifact_json_get')!
      await expect(jsonGet.validate({ callId: 'tc-base', path: '$.name' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_json_* tools when no JSON artifacts are present (base tools still appear)', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledJsonArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      for (const n of names) {
        expect(n).not.toMatch(/^artifact_json_/)
      }
    })

    it('returns an empty registry when ctx.turnToolCalls is empty', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledJsonArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('still emits the base set as ordinary base-class names (not subclass-prefixed)', async () => {
      // The plan-level guidance is that subclass forgeTools inherits the base names verbatim.
      const jsonArtifact = new SpooledJsonArtifact(new InMemorySpoolReader(JSON_OBJECT))
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(jsonArtifact, { id: 'tc-json' })],
      })
      const baseRegistry = SpooledArtifact.forgeTools(ctx)
      const subclassRegistry = SpooledJsonArtifact.forgeTools(ctx)
      const baseNames = baseRegistry.all().map((t) => t.name)
      for (const n of baseNames) {
        expect(subclassRegistry.has(n)).toBe(true)
      }
    })
  })

  describe('inheritance from SpooledArtifact', () => {
    it('still supports head / tail / cat from the base class', async () => {
      const a = make(JSONL)
      expect(await a.lineCount()).toBe(3)
      const head = await a.head(1)
      expect(head[0]).toBe('{"id":1,"role":"user"}')
    })
  })
})
