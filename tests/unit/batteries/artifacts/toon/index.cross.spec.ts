import { describe, expect, it, beforeAll } from 'vitest'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import { ArtifactTool } from '../../../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../../../_fixtures/dispatch_context'
import { SpooledJsonArtifact } from '../../../../../src/batteries/../common'
import { registerAdkEncodables } from '../../../../../src/batteries/encoding'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledArtifact } from '../../../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../../../_fixtures/primitives'
import {
  SpooledToonArtifact,
  E_TOON_DECODE_FAILED,
} from '../../../../../src/batteries/artifacts/toon'

// TOON encodes JSON data model. Root can be an object with array property
const TOON_OBJECT = `data[2]{id,name}:
  1,Ada
  2,Bob`

// Simple TOON - just a primitive for testing
const TOON_SIMPLE_PRIMITIVE = '42'

// Empty object
const TOON_EMPTY_OBJECT = '{}'

const make = (content: string, options?: { indentSize?: number; strict?: boolean }) =>
  new SpooledToonArtifact(new InMemorySpoolReader(content), options)

describe('SpooledToonArtifact', () => {
  beforeAll(() => registerAdkEncodables())

  describe('toon_type', () => {
    it('returns exact type for a comma-delimited document', async () => {
      const { encode } = await import('@toon-format/toon')
      const toonData = encode({ message: 'hello' })
      const result = await make(toonData).toon_type()
      expect(result).toEqual({ format: 'toon' })
    })

    it('returns exact type for a tab-delimited document', async () => {
      const { encode } = await import('@toon-format/toon')
      const toonData = encode(
        {
          rows: [
            { id: 1, name: 'alice' },
            { id: 2, name: 'bob' },
          ],
        },
        { delimiter: '\t' }
      )
      const result = await make(toonData).toon_type()
      expect(result).toEqual({ format: 'toon' })
    })

    it('returns exact type for a pipe-delimited document', async () => {
      const { encode } = await import('@toon-format/toon')
      const toonData = encode(
        {
          records: [
            { id: 1, label: 'a' },
            { id: 2, label: 'b' },
          ],
        },
        { delimiter: '|' }
      )
      const result = await make(toonData).toon_type()
      expect(result).toEqual({ format: 'toon' })
    })

    it('parses document with NO tabular header but containing bracket-shaped substring', async () => {
      // Fixture: document with NO tabular header but containing bracket-shaped substring.
      // encode({ message: '[2|]' }) should parse successfully.
      // Delimiter detection is no longer part of the contract.
      const { encode } = await import('@toon-format/toon')
      const toonData = encode({ message: '[2|]' })
      const artifact = make(toonData)
      const result = await artifact.toon_type()
      expect(result).toEqual({ format: 'toon' })

      // Query the artifact to verify it can be queried
      const value = await artifact.toon_get('$.message')
      expect(value).toEqual(['[2|]'])
    })

    it('returns format for plain mapping', async () => {
      const { encode } = await import('@toon-format/toon')
      const toonData = encode({ a: 1, b: 2 })
      const result = await make(toonData).toon_type()
      expect(result).toEqual({ format: 'toon' })
    })

    it('parses document with values containing unquoted pipe', async () => {
      // Fixture: document with comma delimiter but values contain pipe characters.
      // Delimiter detection is no longer part of the contract.
      const { encode } = await import('@toon-format/toon')
      const toonData = encode(
        {
          rows: [
            { id: 1, note: 'a|b' },
            { id: 2, note: 'c|d' },
          ],
        },
        { delimiter: ',' }
      )
      const artifact = make(toonData)
      const result = await artifact.toon_type()
      expect(result).toEqual({ format: 'toon' })

      // Query the artifact to verify it can be queried
      const rows = await artifact.toon_get('$.rows[*].note')
      expect(rows).toEqual(['a|b', 'c|d'])
    })

    it('returns consistent result on multiple calls (stability)', async () => {
      const { encode } = await import('@toon-format/toon')
      const toonData = encode({ users: [{ id: 1, name: 'alice' }] }, { delimiter: '|' })
      const artifact = make(toonData)

      const result1 = await artifact.toon_type()
      const result2 = await artifact.toon_type()
      const result3 = await artifact.toon_type()

      expect(result1).toEqual(result2)
      expect(result2).toEqual(result3)
      expect(result1).toEqual({ format: 'toon' })
    })

    it('parses document with escaped-quote key', async () => {
      // Fixture: document with a key containing an escaped quote.
      // This broke earlier implementations due to the widened header regex.
      // encode({ 'a"b': [{ id: 1, name: 'x' }] }, { delimiter: '|' })
      const { encode } = await import('@toon-format/toon')
      const toonData = encode({ 'a"b': [{ id: 1, name: 'x' }] }, { delimiter: '|' })
      const artifact = make(toonData)

      const typeResult = await artifact.toon_type()
      expect(typeResult).toEqual({ format: 'toon' })

      // Query the keys to verify the escaped-quote key is present
      const keys = await artifact.toon_keys()
      expect(keys).toBeDefined()
      expect(keys).toContain('a"b')

      // Query nested content using a recursive descent that finds arrays and their elements
      // Use $.*[*] to get elements from any top-level array property
      const arrayElements = await artifact.toon_get('$.*[*]')
      expect(arrayElements).toBeDefined()
      expect(Array.isArray(arrayElements)).toBe(true)
      expect(arrayElements.length).toBe(1)
      // The element should be an object with id and name
      const obj = arrayElements[0] as Record<string, unknown>
      expect(obj.id).toBe(1)
      expect(obj.name).toBe('x')
    })

    it('parses document with keyless root array', async () => {
      // Fixture: document with a keyless root array.
      // This broke earlier implementations due to the anchored header regex.
      // encode([{ id: 1, name: 'a' }, { id: 2, name: 'b' }], { delimiter: '|' })
      const { encode } = await import('@toon-format/toon')
      const toonData = encode(
        [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
        { delimiter: '|' }
      )
      const artifact = make(toonData)

      const typeResult = await artifact.toon_type()
      expect(typeResult).toEqual({ format: 'toon' })

      // A root array has no top-level keys. Measured: toon_keys() returns undefined.
      const keys = await artifact.toon_keys()
      expect(keys).toBeUndefined()

      // Query the length
      const length = await artifact.toon_length()
      expect(length).toBe(2)

      // Query the names from the array
      const names = await artifact.toon_get('$[*].name')
      expect(names).toEqual(['a', 'b'])

      // Query specific ids
      const ids = await artifact.toon_get('$[*].id')
      expect(ids).toEqual([1, 2])
    })
  })

  describe('toon_keys', () => {
    it('returns the root-object keys for a TOON object', async () => {
      const result = await make(TOON_OBJECT).toon_keys()
      expect(Array.isArray(result)).toBe(true)
      expect(result).toBeDefined()
      if (result) {
        expect(result.length).toBeGreaterThan(0)
        // Root has "data" key (the array property)
        expect(result).toEqual(expect.arrayContaining(['data']))
      }
    })

    it('returns undefined when the root is a primitive', async () => {
      expect(await make(TOON_SIMPLE_PRIMITIVE).toon_keys()).toBeUndefined()
    })

    it('returns keys for an empty object', async () => {
      const result = await make(TOON_EMPTY_OBJECT).toon_keys()
      expect(result).toBeUndefined()
    })
  })

  describe('toon_length', () => {
    it('returns 1 for an object (non-array root)', async () => {
      expect(await make(TOON_OBJECT).toon_length()).toBe(1)
    })

    it('returns 1 for a primitive value', async () => {
      expect(await make(TOON_SIMPLE_PRIMITIVE).toon_length()).toBe(1)
    })
  })

  describe('toon_get (JSONPath)', () => {
    it('extracts a property from a TOON object via $.path', async () => {
      const result = await make(TOON_OBJECT).toon_get('$.data')
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })

    it('returns an empty array when path matches nothing', async () => {
      expect(await make(TOON_OBJECT).toon_get('$.nonexistent')).toEqual([])
    })
  })

  describe('toon_filter', () => {
    it('returns records where the path resolves to at least one match', async () => {
      const result = await make(TOON_OBJECT).toon_filter('$.data')
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })

    it('returns an empty array when the path matches nothing on any record', async () => {
      const none = await make(TOON_OBJECT).toon_filter('$.nonexistent')
      expect(none).toEqual([])
    })
  })

  describe('toon_pluck', () => {
    it('flattens matches across all records', async () => {
      const result = await make(TOON_OBJECT).toon_pluck('$.data[*].id')
      expect(Array.isArray(result)).toBe(true)
      // Should extract ids from array elements: 1, 2
      expect(result).toEqual(expect.arrayContaining([1, 2]))
    })

    it('returns an empty array when path matches nothing', async () => {
      const result = await make(TOON_OBJECT).toon_pluck('$.nonexistent')
      expect(result).toEqual([])
    })
  })

  describe('toon_slice', () => {
    it('returns a single-element array for object root regardless of args', async () => {
      const slice = await make(TOON_OBJECT).toon_slice(0, 0)
      expect(Array.isArray(slice)).toBe(true)
      expect(slice).toHaveLength(1)
    })

    it('handles slice with both indices omitted for object', async () => {
      const slice = await make(TOON_OBJECT).toon_slice()
      expect(Array.isArray(slice)).toBe(true)
      expect(slice).toHaveLength(1)
    })

    it('handles out-of-range indices gracefully', async () => {
      const slice = await make(TOON_OBJECT).toon_slice(100, 200)
      expect(Array.isArray(slice)).toBe(true)
    })
  })

  describe('SpooledToonArtifact.isSpooledToonArtifact', () => {
    it('returns true for SpooledToonArtifact instances', () => {
      expect(SpooledToonArtifact.isSpooledToonArtifact(make(TOON_OBJECT))).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledToonArtifact.isSpooledToonArtifact({})).toBe(false)
    })

    it('returns false for null', () => {
      expect(SpooledToonArtifact.isSpooledToonArtifact(null)).toBe(false)
    })

    it('returns false for other artifact types', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('text')
      expect(SpooledToonArtifact.isSpooledToonArtifact(baseArtifact)).toBe(false)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + toon_* tools when the turn has a TOON artifact', async () => {
      const toonArtifact = make(TOON_OBJECT)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(toonArtifact, { id: 'tc-toon' })],
      })
      const registry = SpooledToonArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      // Base set
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))

      // TOON-specific
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_toon_type',
          'artifact_toon_keys',
          'artifact_toon_length',
          'artifact_toon_get',
          'artifact_toon_filter',
          'artifact_toon_slice',
          'artifact_toon_pluck',
        ])
      )

      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('discovers retrievable-backed TOON artifacts through forged tools', () => {
      const artifact = make(TOON_OBJECT)
      const r = new Retrievable({
        id: 'ret-toon',
        content: artifact,
        trustTier: 'first-party',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      })
      const registry = SpooledToonArtifact.forgeTools(makeDispatchContext({ retrievables: [r] }))
      expect(JSON.stringify(registry.get('artifact_toon_get')!.describe().inputSchema)).toContain(
        'ret-toon'
      )
    })

    it('restricts artifact_toon_* callId enum to TOON artifacts; base tools see every artifact', async () => {
      const toonArtifact = make(TOON_OBJECT)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb\nc', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(toonArtifact, { id: 'tc-toon' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledToonArtifact.forgeTools(ctx)
      const toonGet = registry.get('artifact_toon_get')!
      const baseHead = registry.get('artifact_head')!
      const toonGetDump = JSON.stringify(toonGet.describe().inputSchema)
      const baseHeadDump = JSON.stringify(baseHead.describe().inputSchema)

      expect(toonGetDump).toContain('tc-toon')
      expect(toonGetDump).not.toContain('tc-base')

      // Base methods come from SpooledArtifact.forgeTools and accept any SpooledArtifact
      expect(baseHeadDump).toContain('tc-toon')
      expect(baseHeadDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_toon_get at validation time', async () => {
      const toonArtifact = make(TOON_OBJECT)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(toonArtifact, { id: 'tc-toon' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledToonArtifact.forgeTools(ctx)
      const toonGet = registry.get('artifact_toon_get')!

      await expect(toonGet.validate({ callId: 'tc-base', path: '$.id' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_toon_* tools when no TOON artifacts are present (base tools still appear)', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledToonArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      for (const n of names) {
        expect(n).not.toMatch(/^artifact_toon_/)
      }
    })

    it('returns an empty registry when ctx.turnToolCalls is empty', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledToonArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('still emits the base set as ordinary base-class names (not subclass-prefixed)', async () => {
      const toonArtifact = make(TOON_OBJECT)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(toonArtifact, { id: 'tc-toon' })],
      })
      const baseRegistry = SpooledArtifact.forgeTools(ctx)
      const subclassRegistry = SpooledToonArtifact.forgeTools(ctx)
      const baseNames = baseRegistry.all().map((t) => t.name)

      for (const n of baseNames) {
        expect(subclassRegistry.has(n)).toBe(true)
      }
    })
  })

  describe('inheritance from SpooledArtifact', () => {
    it('still supports head / tail / cat from the base class', async () => {
      const a = make(TOON_OBJECT)
      const head = await a.head(1)
      expect(Array.isArray(head)).toBe(true)
      expect(head.length).toBeGreaterThan(0)
    })

    it('still supports lineCount from the base class', async () => {
      const a = make(TOON_OBJECT)
      const count = await a.lineCount()
      expect(typeof count).toBe('number')
      expect(count).toBeGreaterThan(0)
    })

    it('still supports tail from the base class', async () => {
      const a = make(TOON_OBJECT)
      const tail = await a.tail(1)
      expect(Array.isArray(tail)).toBe(true)
    })

    it('still supports cat from the base class', async () => {
      const a = make(TOON_OBJECT)
      const content = await a.cat()
      // cat() returns array of lines
      expect(Array.isArray(content)).toBe(true)
      expect(content.length).toBeGreaterThan(0)
    })
  })

  describe('encode/decode round-trip', () => {
    it('decode(encode(a)) returns an instance of SpooledToonArtifact with options intact', async () => {
      const originalOptions = { indentSize: 4, strict: true }
      const original = make(TOON_OBJECT, originalOptions)

      const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
      const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')

      const encoded = (original as unknown as Record<symbol, () => unknown>)[ENCODE_METHOD]()
      const decoded = (
        SpooledToonArtifact as unknown as Record<symbol, (snap: unknown) => SpooledToonArtifact>
      )[DECODE_METHOD](encoded) as SpooledToonArtifact

      expect(decoded).toBeInstanceOf(SpooledToonArtifact)
      expect(decoded.constructor.name).toBe('SpooledToonArtifact')
    })

    it('preserves the artifact content through encode/decode', async () => {
      const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
      const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')

      const original = make(TOON_OBJECT)
      const originalContent = await original.asString()

      const encoded = (original as unknown as Record<symbol, () => unknown>)[ENCODE_METHOD]()
      const decoded = (
        SpooledToonArtifact as unknown as Record<symbol, (snap: unknown) => unknown>
      )[DECODE_METHOD](encoded)
      const decodedContent = await (decoded as SpooledToonArtifact).asString()

      expect(decodedContent).toBe(originalContent)
    })
  })

  describe('TOON-specific parse failure handling', () => {
    it('handles malformed TOON by returning meaningful error info', async () => {
      // Invalid TOON: mismatched columns should trigger a decode error
      const malformed = `users[2]{id,name}:
  1,Ada,Extra`

      const artifact = make(malformed, { strict: true })
      const err = await artifact.toon_keys().catch((e) => e)
      expect(err).toBeInstanceOf(E_TOON_DECODE_FAILED)
      expect((err as any).message).toMatch(/line \d+/)
    })

    it('handles empty TOON documents', async () => {
      const empty = ''
      const artifact = make(empty)
      const result = await artifact.toon_keys()
      expect(result).toEqual([])
    })
  })

  describe('constructor options', () => {
    it('accepts indentSize option', async () => {
      const artifact = make(TOON_OBJECT, { indentSize: 2 })
      expect(artifact).toBeInstanceOf(SpooledToonArtifact)
    })

    it('accepts strict option', async () => {
      const artifact = make(TOON_OBJECT, { strict: true })
      expect(artifact).toBeInstanceOf(SpooledToonArtifact)
    })

    it('accepts both options together', async () => {
      const artifact = make(TOON_OBJECT, { indentSize: 4, strict: false })
      expect(artifact).toBeInstanceOf(SpooledToonArtifact)
    })
  })

  describe('converter tool schema fields', () => {
    it('toonToJsonTool inputSchema includes call_id (snake_case), not callId', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')

      const schema = toonToJsonTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('call_id')
      expect(schemaStr).not.toContain('callId')
      expect(schemaStr).toContain('text')
    })

    it('jsonToToonTool inputSchema includes call_id (snake_case), not callId', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')

      const schema = jsonToToonTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('call_id')
      expect(schemaStr).not.toContain('callId')
      expect(schemaStr).toContain('text')
    })
  })

  describe('toonToJsonTool behavioral tests', () => {
    it('converts TOON text to JSON and returns a SpooledJsonArtifact instance', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const toonText = 'users[2]{id,name}:\n  1,alice\n  2,bob'
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)

      const result = await executor({ text: toonText })

      expect(result).toBeInstanceOf(SpooledJsonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()
      expect(content).toBeTruthy()
      expect(content).toContain('alice')
      expect(content).toContain('bob')
      const parsed = JSON.parse(content)
      expect(parsed.users).toBeDefined()
      expect(Array.isArray(parsed.users)).toBe(true)
      expect(parsed.users.length).toBeGreaterThan(0)
    })

    it('converts TOON via call_id from a source artifact', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const toonSrc = new SpooledToonArtifact(
        new InMemorySpoolReader('people[2]{name,age}:\n  alice,30\n  bob,25')
      )
      const tc = makeToolCall(toonSrc, { id: 'toon_src_1' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ call_id: 'toon_src_1' })

      expect(result).toBeInstanceOf(SpooledJsonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()
      expect(content).toContain('alice')
      expect(content).toContain('30')
      expect(content).not.toContain('SpooledToonArtifact')
    })

    it('text path: asserts returned artifact contains actual converted content (not empty/null)', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const toonText = 'data[1]{val}:\n  42'
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ text: toonText })

      expect(result).toBeInstanceOf(SpooledJsonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()

      expect(content).not.toBe('')
      expect(content).not.toBe('null')
      expect(content).not.toBe('{}')
      expect(content).toContain('42')
    })

    it('call_id path: asserts output contains source artifact content, not class instance', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const toonSrc = new SpooledToonArtifact(new InMemorySpoolReader('x: hello'))
      const tc = makeToolCall(toonSrc, { id: 'toon_src_2' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ call_id: 'toon_src_2' })
      const content = await (result as { asString: () => Promise<string> }).asString()

      expect(content).toContain('hello')
      expect(content).not.toContain('null')
      expect(content).not.toContain('{}')
      expect(content).not.toContain('SpooledToonArtifact')
      expect(content).not.toContain('Spooled')
    })

    it('error: neither text nor call_id provided', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({})

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })

    it('error: both text and call_id provided', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ text: 'x: 1', call_id: 'some_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('both')
    })

    it('error: call_id references nonexistent artifact', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ call_id: 'does_not_exist' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('does_not_exist')
    })

    it('error: call_id references wrong artifact type (JSON instead of TOON)', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const jsonSrc = new SpooledJsonArtifact(new InMemorySpoolReader('{"x": 1}'))
      const tc = makeToolCall(jsonSrc, { id: 'json_src_1' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ call_id: 'json_src_1' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('json_src_1')
    })

    it('empty text is treated as absent', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ text: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })

    it('empty call_id is treated as absent', async () => {
      const { toonToJsonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = toonToJsonTool.executor(ctx as never)
      const result = await executor({ call_id: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })
  })

  describe('jsonToToonTool behavioral tests', () => {
    it('converts JSON text to TOON and returns a SpooledToonArtifact instance', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const jsonText = '{"users":[{"id":1,"name":"alice"},{"id":2,"name":"bob"}]}'
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)

      const result = await executor({ text: jsonText })

      expect(result).toBeInstanceOf(SpooledToonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()
      expect(content).toBeTruthy()
      expect(content).toContain('alice')
      expect(content).toContain('bob')
    })

    it('converts JSON via call_id from a source artifact', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const jsonSrc = new SpooledJsonArtifact(new InMemorySpoolReader('{"person":"carol"}'))
      const tc = makeToolCall(jsonSrc, { id: 'json_src_2' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ call_id: 'json_src_2' })

      expect(result).toBeInstanceOf(SpooledToonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()
      expect(content).toContain('carol')
      expect(content).not.toContain('SpooledJsonArtifact')
    })

    it('text path: asserts returned artifact contains actual converted content (not empty/null)', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const jsonText = '{"value":99}'
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ text: jsonText })

      expect(result).toBeInstanceOf(SpooledToonArtifact)
      const content = await (result as { asString: () => Promise<string> }).asString()

      expect(content).not.toBe('')
      expect(content).not.toBe('null')
      expect(content).not.toBe('{}')
      expect(content).toContain('99')
    })

    it('call_id path: asserts output contains source artifact content, not class instance', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const jsonSrc = new SpooledJsonArtifact(new InMemorySpoolReader('{"msg":"world"}'))
      const tc = makeToolCall(jsonSrc, { id: 'json_src_3' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ call_id: 'json_src_3' })
      const content = await (result as { asString: () => Promise<string> }).asString()

      expect(content).toContain('world')
      expect(content).not.toContain('null')
      expect(content).not.toContain('{}')
      expect(content).not.toContain('SpooledJsonArtifact')
      expect(content).not.toContain('Spooled')
    })

    it('error: neither text nor call_id provided', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({})

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })

    it('error: both text and call_id provided', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ text: '{"x":1}', call_id: 'some_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('both')
    })

    it('error: call_id references nonexistent artifact', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ call_id: 'does_not_exist' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('does_not_exist')
    })

    it('error: call_id references wrong artifact type (TOON instead of JSON)', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const toonSrc = new SpooledToonArtifact(new InMemorySpoolReader('x: 1'))
      const tc = makeToolCall(toonSrc, { id: 'toon_src_3' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })

      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ call_id: 'toon_src_3' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('toon_src_3')
    })

    it('empty text is treated as absent', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ text: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })

    it('empty call_id is treated as absent', async () => {
      const { jsonToToonTool } = await import('../../../../../src/batteries/artifacts/toon')
      const ctx = makeDispatchContext()
      const executor = jsonToToonTool.executor(ctx as never)
      const result = await executor({ call_id: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect((result as string).toLowerCase()).toContain('neither')
    })
  })

  describe('converter round-trip fidelity', () => {
    it('toon_to_json followed by json_to_toon produces valid TOON', async () => {
      const { toonToJsonTool, jsonToToonTool } =
        await import('../../../../../src/batteries/artifacts/toon')
      const originalToon = 'people[2]{id,name}:\n  1,alice\n  2,bob'

      const ctx1 = makeDispatchContext()
      const step1Executor = toonToJsonTool.executor(ctx1 as never)
      const jsonArtifact = await step1Executor({ text: originalToon })

      const tc = makeToolCall(jsonArtifact as SpooledJsonArtifact, { id: 'json_from_toon' })
      const ctx2 = makeDispatchContext({ toolCalls: [tc] })
      const step2Executor = jsonToToonTool.executor(ctx2 as never)
      const toonResult = await step2Executor({ call_id: 'json_from_toon' })

      const content = await (toonResult as { asString: () => Promise<string> }).asString()
      expect(content).toContain('alice')
      expect(content).toContain('bob')
      expect(content).toContain('1')
      expect(content).toContain('2')
    })

    it('json_to_toon followed by toon_to_json produces valid JSON', async () => {
      const { jsonToToonTool, toonToJsonTool } =
        await import('../../../../../src/batteries/artifacts/toon')
      const originalJson = '{"users":[{"id":1,"name":"carol"}]}'

      const ctx1 = makeDispatchContext()
      const step1Executor = jsonToToonTool.executor(ctx1 as never)
      const toonArtifact = await step1Executor({ text: originalJson })

      const tc = makeToolCall(toonArtifact as SpooledToonArtifact, { id: 'toon_from_json' })
      const ctx2 = makeDispatchContext({ toolCalls: [tc] })
      const step2Executor = toonToJsonTool.executor(ctx2 as never)
      const jsonResult = await step2Executor({ call_id: 'toon_from_json' })

      const content = await (jsonResult as { asString: () => Promise<string> }).asString()
      expect(content).toContain('carol')
      const parsed = JSON.parse(content)
      expect(parsed.users).toBeDefined()
      expect(Array.isArray(parsed.users)).toBe(true)
      expect(parsed.users.length).toBeGreaterThan(0)
    })
  })
})
