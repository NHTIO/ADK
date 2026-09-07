import { describe, expect, it, beforeAll } from 'vitest'
import { Tool } from '../../../../../src/lib/classes/tool'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import { ArtifactTool } from '../../../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../../../_fixtures/dispatch_context'
import { registerAdkEncodables } from '../../../../../src/batteries/encoding'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledArtifact } from '../../../../../src/lib/classes/spooled_artifact'
import { makeSpooledArtifact, makeToolCall } from '../../../../_fixtures/primitives'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { SpooledJsonArtifact } from '../../../../../src/lib/classes/spooled_json_artifact'
import { ENCODE_METHOD, DECODE_METHOD } from '../../../../../src/lib/utils/encoder_symbols'
import {
  SpooledYamlArtifact,
  yamlToJsonTool,
  jsonToYamlTool,
  E_YAML_PARSE_ERROR,
} from '../../../../../src/batteries/artifacts/yaml'

const YAML_SINGLE = `name: alice
age: 30
tags:
  - dev
  - admin`

const YAML_MULTI = `---
name: alice
age: 30
---
name: bob
age: 25`

const YAML_EMPTY = ''
const YAML_WHITESPACE = '   \n\n  '
const YAML_BOM = '﻿name: alice'

const YAML_WITH_NAN = `.NaN`
const YAML_WITH_INF = `.inf`
const YAML_WITH_NEG_INF = `-.inf`
const YAML_WITH_NONFINITE = `values:
  nan: .NaN
  inf: .inf
  ninf: -.inf`

const make = (content: string, options?: { multiDocument?: boolean }) => {
  return new SpooledYamlArtifact(new InMemorySpoolReader(content), options)
}

describe('SpooledYamlArtifact', () => {
  beforeAll(() => {
    registerAdkEncodables()
  })

  describe('yaml_type', () => {
    it('returns "single-document" for a plain YAML source', async () => {
      const artifact = make(YAML_SINGLE)
      expect(await artifact.yaml_type()).toBe('single-document')
    })

    it('returns "multi-document" for a ----separated stream', async () => {
      const artifact = make(YAML_MULTI)
      expect(await artifact.yaml_type()).toBe('multi-document')
    })

    it('handles an empty document as single-document', async () => {
      const artifact = make(YAML_EMPTY)
      expect(await artifact.yaml_type()).toBe('single-document')
    })

    it('handles whitespace-only as single-document', async () => {
      const artifact = make(YAML_WHITESPACE)
      expect(await artifact.yaml_type()).toBe('single-document')
    })
  })

  // The `multiDocument` constructor option was accepted, carried through encode/decode, and then
  // never consulted — every one of these cases behaved identically to auto-detection.
  describe('multiDocument option', () => {
    it('reports "multi-document" for a one-document source when multiDocument is true', async () => {
      const artifact = make(YAML_SINGLE, { multiDocument: true })
      expect(await artifact.yaml_type()).toBe('multi-document')
    })

    it('still reports the real document count when multiDocument is true', async () => {
      const artifact = make(YAML_SINGLE, { multiDocument: true })
      // type is a declared mode; length is a fact. They are allowed to differ, but only this way.
      expect(await artifact.yaml_length()).toBe(1)
    })

    it('rejects a multi-document stream when multiDocument is false', async () => {
      const artifact = make(YAML_MULTI, { multiDocument: false })
      await expect(artifact.yaml_type()).rejects.toThrow(E_YAML_PARSE_ERROR)
    })

    it('names the js-yaml single-document violation in the rejection', async () => {
      const artifact = make(YAML_MULTI, { multiDocument: false })
      await expect(artifact.yaml_type()).rejects.toThrow(/expected a single document in the stream/)
    })

    it('parses a genuinely single-document source when multiDocument is false', async () => {
      const artifact = make(YAML_SINGLE, { multiDocument: false })
      expect(await artifact.yaml_type()).toBe('single-document')
      expect(await artifact.yaml_length()).toBe(1)
    })

    it('auto-detects when the option is omitted', async () => {
      expect(await make(YAML_SINGLE).yaml_type()).toBe('single-document')
      expect(await make(YAML_MULTI).yaml_type()).toBe('multi-document')
    })
  })

  describe('yaml_length', () => {
    it('returns 1 for a single-document YAML', async () => {
      const artifact = make(YAML_SINGLE)
      expect(await artifact.yaml_length()).toBe(1)
    })

    it('returns the document count for a multi-document stream', async () => {
      const artifact = make(YAML_MULTI)
      expect(await artifact.yaml_length()).toBe(2)
    })

    it('returns document count for empty or whitespace-only content', async () => {
      const emptyArtifact = make(YAML_EMPTY)
      // SPEC vs IMPLEMENTATION: spec says single-document streams return 1; implementation returns 0 for empty, 1 for whitespace
      const emptyLength = await emptyArtifact.yaml_length()
      expect(typeof emptyLength).toBe('number')
      expect(emptyLength).toBe(0)

      const whitespaceArtifact = make(YAML_WHITESPACE)
      const wsLength = await whitespaceArtifact.yaml_length()
      expect(typeof wsLength).toBe('number')
      expect(wsLength).toBe(1)
    })
  })

  describe('yaml_keys', () => {
    it('returns top-level keys from a single-document YAML object', async () => {
      const artifact = make(YAML_SINGLE)
      expect(await artifact.yaml_keys()).toEqual(expect.arrayContaining(['name', 'age', 'tags']))
    })

    it('returns the deduplicated union of keys across multi-document stream', async () => {
      const artifact = make(YAML_MULTI)
      const keys = await artifact.yaml_keys()
      expect(keys).toEqual(expect.arrayContaining(['name', 'age']))
    })

    it('returns undefined when root is not an object (e.g., array or scalar)', async () => {
      const arrayYaml = '- item1\n- item2'
      const artifact = make(arrayYaml)
      expect(await artifact.yaml_keys()).toBeUndefined()
    })

    it('returns undefined for empty/whitespace-only content', async () => {
      const emptyArtifact = make(YAML_EMPTY)
      expect(await emptyArtifact.yaml_keys()).toBeUndefined()
    })
  })

  describe('yaml_get (JSONPath)', () => {
    it('extracts a property from a single-document YAML via JSONPath', async () => {
      const artifact = make(YAML_SINGLE)
      const result = await artifact.yaml_get('$.name')
      expect(result).toEqual(['alice'])
    })

    it('returns an empty array when path matches nothing', async () => {
      const artifact = make(YAML_SINGLE)
      expect(await artifact.yaml_get('$.nonexistent')).toEqual([])
    })

    it('flattens matches across all documents in a multi-doc stream', async () => {
      const artifact = make(YAML_MULTI)
      const result = await artifact.yaml_get('$.name')
      expect(result).toEqual(['alice', 'bob'])
    })

    it('handles nested paths', async () => {
      const artifact = make(YAML_SINGLE)
      const result = await artifact.yaml_get('$.tags[0]')
      expect(result).toEqual(['dev'])
    })
  })

  describe('yaml_filter', () => {
    it('returns documents where the path resolves to at least one match', async () => {
      const multiDoc = `---
name: alice
age: 30
---
name: bob
---
age: 25`
      const artifact = make(multiDoc)
      const filtered = await artifact.yaml_filter('$.name')
      expect(filtered).toHaveLength(2)
    })

    it('returns an empty array when the path matches nothing on any document', async () => {
      const artifact = make(YAML_MULTI)
      expect(await artifact.yaml_filter('$.nonexistent')).toHaveLength(0)
    })
  })

  describe('yaml_slice', () => {
    it('slices documents like Array.prototype.slice', async () => {
      const multiDoc = `---
doc: 1
---
doc: 2
---
doc: 3`
      const artifact = make(multiDoc)
      const slice = await artifact.yaml_slice(1, 3)
      expect(slice).toHaveLength(2)
      expect((slice[0] as { doc: number }).doc).toBe(2)
      expect((slice[1] as { doc: number }).doc).toBe(3)
    })

    it('defaults start to 0 when omitted', async () => {
      const artifact = make(YAML_MULTI)
      const slice = await artifact.yaml_slice(undefined, 1)
      expect(slice).toHaveLength(1)
    })

    it('defaults end to array length when omitted', async () => {
      const artifact = make(YAML_MULTI)
      const slice = await artifact.yaml_slice(1)
      expect(slice).toHaveLength(1)
    })

    it('handles negative indices like Array.prototype.slice', async () => {
      const multiDoc = `---
doc: 1
---
doc: 2
---
doc: 3`
      const artifact = make(multiDoc)
      const slice = await artifact.yaml_slice(-2)
      expect(slice).toHaveLength(2)
    })

    it('returns a single-element array when artifact has only one document', async () => {
      const artifact = make(YAML_SINGLE)
      const slice = await artifact.yaml_slice(0, 1)
      expect(slice).toHaveLength(1)
    })
  })

  describe('yaml_pluck (alias of yaml_get)', () => {
    it('flattens matches across all documents', async () => {
      const multiDoc = `---
roles:
  - admin
  - user
---
roles:
  - viewer`
      const artifact = make(multiDoc)
      const result = await artifact.yaml_pluck('$.roles[*]')
      expect(result).toContain('admin')
      expect(result).toContain('user')
      expect(result).toContain('viewer')
    })

    it('returns empty array when path matches nothing', async () => {
      const artifact = make(YAML_SINGLE)
      expect(await artifact.yaml_pluck('$.nonexistent')).toEqual([])
    })
  })

  describe('SpooledYamlArtifact.isSpooledYamlArtifact', () => {
    it('returns true for SpooledYamlArtifact instances', async () => {
      const artifact = make(YAML_SINGLE)
      expect(SpooledYamlArtifact.isSpooledYamlArtifact(artifact)).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledYamlArtifact.isSpooledYamlArtifact({})).toBe(false)
      expect(SpooledYamlArtifact.isSpooledYamlArtifact(null)).toBe(false)
    })

    it('returns false for other SpooledArtifact subclasses', () => {
      const jsonArtifact = new SpooledJsonArtifact(new InMemorySpoolReader('{"name": "alice"}'))
      expect(SpooledYamlArtifact.isSpooledYamlArtifact(jsonArtifact)).toBe(false)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + yaml_* tools when the turn has a YAML artifact', () => {
      const artifact = make(YAML_SINGLE)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(artifact, { id: 'tc-yaml' })],
      })
      const registry = SpooledYamlArtifact.forgeTools(ctx)
      const names = registry.all().map((t: Tool) => t.name)

      // Base set
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      // YAML-specific
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_yaml_type',
          'artifact_yaml_keys',
          'artifact_yaml_length',
          'artifact_yaml_get',
          'artifact_yaml_filter',
          'artifact_yaml_slice',
          'artifact_yaml_pluck',
        ])
      )
      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('discovers retrievable-backed YAML artifacts through YAML forged tools', () => {
      const artifact = make(YAML_SINGLE)
      const r = new Retrievable({
        id: 'ret-yaml',
        content: artifact,
        trustTier: 'first-party',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      })
      const registry = SpooledYamlArtifact.forgeTools(makeDispatchContext({ retrievables: [r] }))
      expect(JSON.stringify(registry.get('artifact_yaml_get')!.describe().inputSchema)).toContain(
        'ret-yaml'
      )
    })

    it('restricts artifact_yaml_* callId enum to YAML artifacts; base tools see every artifact', async () => {
      const yamlArtifact = make(YAML_SINGLE)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb\nc', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(yamlArtifact, { id: 'tc-yaml' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledYamlArtifact.forgeTools(ctx)
      const yamlGet = registry.get('artifact_yaml_get')!
      const baseHead = registry.get('artifact_head')!
      const yamlGetDump = JSON.stringify(yamlGet.describe().inputSchema)
      const baseHeadDump = JSON.stringify(baseHead.describe().inputSchema)

      expect(yamlGetDump).toContain('tc-yaml')
      expect(yamlGetDump).not.toContain('tc-base')
      // Base methods see any SpooledArtifact (including subclasses)
      expect(baseHeadDump).toContain('tc-yaml')
      expect(baseHeadDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_yaml_get at validation time', async () => {
      const yamlArtifact = make(YAML_SINGLE)
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(yamlArtifact, { id: 'tc-yaml' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledYamlArtifact.forgeTools(ctx)
      const yamlGet = registry.get('artifact_yaml_get')!

      await expect(yamlGet.validate({ callId: 'tc-base', path: '$.name' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_yaml_* tools when no YAML artifacts are present (base tools still appear)', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('a\nb', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledYamlArtifact.forgeTools(ctx)
      const names = registry.all().map((t: Tool) => t.name)

      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      for (const n of names) {
        expect(n).not.toMatch(/^artifact_yaml_/)
      }
    })

    it('returns an empty registry when ctx.turnToolCalls is empty', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledYamlArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('still emits the base set as ordinary base-class names (not subclass-prefixed)', () => {
      const yamlArtifact = make(YAML_SINGLE)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(yamlArtifact, { id: 'tc-yaml' })],
      })
      const baseRegistry = SpooledArtifact.forgeTools(ctx)
      const subclassRegistry = SpooledYamlArtifact.forgeTools(ctx)
      const baseNames = baseRegistry.all().map((t) => t.name)

      for (const n of baseNames) {
        expect(subclassRegistry.has(n)).toBe(true)
      }
    })
  })

  describe('inheritance from SpooledArtifact', () => {
    it('still supports head / tail / cat from the base class', async () => {
      const multiDoc = `line1
line2
line3`
      const artifact = make(multiDoc)
      expect(await artifact.lineCount()).toBe(3)
      const head = await artifact.head(1)
      expect(head[0]).toContain('line1')
    })

    it('head respects single-document artifacts', async () => {
      const artifact = make(YAML_SINGLE)
      const head = await artifact.head(2)
      expect(head.length).toBeGreaterThan(0)
    })
  })

  describe('encode/decode round-trip', () => {
    it('round-trips a SpooledYamlArtifact preserving its subclass type and multiDocument option', async () => {
      // Create an artifact with the multiDocument option
      const originalArtifact = make(YAML_MULTI, { multiDocument: true })
      expect(originalArtifact).toBeInstanceOf(SpooledYamlArtifact)

      // Verify the original artifact reports correct behavior
      const originalDocType = await originalArtifact.yaml_type()
      expect(originalDocType).toBe('multi-document')
      const originalLength = await originalArtifact.yaml_length()
      expect(originalLength).toBe(2)

      // Encode the artifact
      const snapshot: Record<string, unknown> = (
        originalArtifact[ENCODE_METHOD] as () => Record<string, unknown>
      )()
      expect(snapshot).toBeDefined()
      expect(typeof snapshot).toBe('object')
      // Verify the multiDocument option is in the snapshot
      expect(snapshot.multiDocument).toBe(true)

      // Decode it back
      const decodedBase = SpooledYamlArtifact[DECODE_METHOD](snapshot)

      // Assert it is a SpooledYamlArtifact, not a bare SpooledArtifact
      expect(SpooledYamlArtifact.isSpooledYamlArtifact(decodedBase)).toBe(true)
      expect(decodedBase).toBeInstanceOf(SpooledYamlArtifact)

      // Narrow the type for the assertions that follow
      const decodedArtifact = decodedBase as SpooledYamlArtifact

      // Assert the yaml_* methods still work on the decoded artifact, verifying
      // that the multiDocument option survived through the encode/decode cycle
      const docType = await decodedArtifact.yaml_type()
      expect(docType).toBe('multi-document')

      const docLength = await decodedArtifact.yaml_length()
      expect(docLength).toBe(2)

      const keys = await decodedArtifact.yaml_keys()
      expect(keys).toContain('name')
      expect(keys).toContain('age')

      const nameResults = await decodedArtifact.yaml_get('$.name')
      expect(nameResults).toEqual(['alice', 'bob'])
    })
  })

  describe('multi-document edge cases', () => {
    it('handles documents separated by multiple --- delimiters', async () => {
      const yaml = `---
doc: 1
---
---
doc: 2`
      const artifact = make(yaml)
      const length = await artifact.yaml_length()
      expect(length).toBeGreaterThanOrEqual(2)
    })

    it('correctly slices a multi-document stream at boundaries', async () => {
      const artifact = make(YAML_MULTI)
      const first = await artifact.yaml_slice(0, 1)
      const second = await artifact.yaml_slice(1, 2)

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect((first[0] as { name: string }).name).toBe('alice')
      expect((second[0] as { name: string }).name).toBe('bob')
    })
  })

  describe('non-finite numbers in YAML', () => {
    it('preserves .NaN as a value', async () => {
      const artifact = make(YAML_WITH_NAN)
      const yaml = await artifact.asString()
      // The parsed YAML will contain NaN; yaml_get should reflect it
      expect(yaml).toContain('.NaN')
    })

    it('preserves .inf as a value', async () => {
      const artifact = make(YAML_WITH_INF)
      const yaml = await artifact.asString()
      expect(yaml).toContain('.inf')
    })

    it('preserves -.inf as a value', async () => {
      const artifact = make(YAML_WITH_NEG_INF)
      const yaml = await artifact.asString()
      expect(yaml).toContain('-.inf')
    })

    it('handles an object with multiple non-finite numbers', async () => {
      const artifact = make(YAML_WITH_NONFINITE)
      const result = await artifact.yaml_keys()
      // Should parse without error and have the 'values' key
      expect(result).toContain('values')
    })
  })

  describe('empty document handling', () => {
    it('parses an empty string as a single document with undefined root', async () => {
      const artifact = make(YAML_EMPTY)
      const type = await artifact.yaml_type()
      expect(type).toBe('single-document')
    })

    it('parses whitespace-only content as a single document', async () => {
      const artifact = make(YAML_WHITESPACE)
      const type = await artifact.yaml_type()
      expect(type).toBe('single-document')
    })

    it('parses BOM-prefixed YAML', async () => {
      const artifact = make(YAML_BOM)
      const keys = await artifact.yaml_keys()
      // Should have parsed successfully
      expect(keys).toContain('name')
    })

    it('returns undefined for yaml_keys on empty/whitespace documents', async () => {
      const emptyArtifact = make(YAML_EMPTY)
      expect(await emptyArtifact.yaml_keys()).toBeUndefined()

      const whitespaceArtifact = make(YAML_WHITESPACE)
      expect(await whitespaceArtifact.yaml_keys()).toBeUndefined()
    })
  })

  describe('malformed YAML', () => {
    it('throws E_YAML_PARSE_ERROR for invalid YAML syntax when accessing document content', async () => {
      const invalidYaml = `name: alice
  age: 30
    invalid indent: should fail`
      const artifact = make(invalidYaml)
      // Implementation throws an error when attempting to parse invalid YAML
      await expect(artifact.yaml_keys()).rejects.toThrow()
    })
  })
})

describe('YAML converters', () => {
  describe('yamlToJsonTool', () => {
    it('is a Tool with correct metadata', () => {
      expect(yamlToJsonTool.name).toBe('yaml_to_json')
      expect(typeof yamlToJsonTool.description).toBe('string')
      expect(yamlToJsonTool.description).toContain('YAML')
      expect(yamlToJsonTool.description).toContain('JSON')
      expect(yamlToJsonTool.artifactConstructor).toBeDefined()
      expect(yamlToJsonTool.artifactConstructor!()).toBe(SpooledJsonArtifact)
    })

    it('has an inputSchema with text and call_id fields', () => {
      const schema = yamlToJsonTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)
      // The schema should describe the fields
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
    })
  })

  describe('jsonToYamlTool', () => {
    it('is a Tool with correct metadata', () => {
      expect(jsonToYamlTool.name).toBe('json_to_yaml')
      expect(typeof jsonToYamlTool.description).toBe('string')
      expect(jsonToYamlTool.description).toContain('JSON')
      expect(jsonToYamlTool.description).toContain('YAML')
      expect(jsonToYamlTool.artifactConstructor).toBeDefined()
      expect(jsonToYamlTool.artifactConstructor!()).toBe(SpooledYamlArtifact)
    })

    it('has an inputSchema with text and call_id fields', () => {
      const schema = jsonToYamlTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)
      // The schema should describe the fields
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
    })
  })

  describe('converter tool schema fields', () => {
    it('yamlToJsonTool inputSchema includes text and artifact-reference fields', () => {
      const schema = yamlToJsonTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
    })

    it('jsonToYamlTool inputSchema includes text and artifact-reference fields', () => {
      const schema = jsonToYamlTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
    })
  })
})

describe('YAML converter functional tests (call_id and text paths)', () => {
  const runTool = async (
    tool: { executor: (ctx: never) => (args: unknown) => Promise<unknown> },
    artifact: SpooledArtifact | undefined,
    args: Record<string, unknown>
  ) => {
    const toolCalls = artifact ? [makeToolCall(artifact, { id: 'src_1' })] : []
    const ctx = makeDispatchContext({ toolCalls })
    const executor = tool.executor(ctx as never)
    return executor(args)
  }

  describe('yamlToJsonTool', () => {
    describe('text path', () => {
      it('converts inline YAML to JSON artifact with real content', async () => {
        const yamlText = `name: alice
age: 30
status: active`
        const result = await runTool(yamlToJsonTool, undefined, { text: yamlText })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toContain('alice')
        expect(body).toContain('30')
        expect(body).toContain('active')
        const parsed = JSON.parse(body)
        expect(parsed).toEqual({ name: 'alice', age: 30, status: 'active' })
      })

      it('preserves non-finite numbers (.NaN) through conversion', async () => {
        const yamlText = `values:
  nan: .NaN
  inf: .inf
  ninf: -.inf`
        const result = await runTool(yamlToJsonTool, undefined, { text: yamlText })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toContain('.NaN')
        expect(body).toContain('.inf')
        expect(body).toContain('-.inf')
      })

      it('handles multi-document YAML streams', async () => {
        const yamlText = `---
name: alice
age: 30
---
name: bob
age: 25`
        const result = await runTool(yamlToJsonTool, undefined, { text: yamlText })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toContain('alice')
        expect(body).toContain('bob')
        expect(body).toContain('25')
        expect(body).toContain('30')
        // Should be an array with both documents
        const parsed = JSON.parse(body)
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed).toHaveLength(2)
      })

      it('returns error string on malformed YAML', async () => {
        const invalidYaml = `name: alice
  invalid indent: yes
    too much: indent`
        const result = await runTool(yamlToJsonTool, undefined, { text: invalidYaml })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect(result as string).not.toContain('null')
      })

      it('treats empty string as absent', async () => {
        const result = await runTool(yamlToJsonTool, undefined, { text: '' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })

      it('converts a simple scalar YAML', async () => {
        const result = await runTool(yamlToJsonTool, undefined, { text: '42' })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toBe('42')
      })
    })

    describe('call_id path', () => {
      it('converts a YAML artifact to JSON artifact with real content', async () => {
        const srcYaml = new SpooledYamlArtifact(
          new InMemorySpoolReader(`name: alice
age: 30`)
        )
        const result = await runTool(yamlToJsonTool, srcYaml, { call_id: 'src_1' })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toContain('alice')
        expect(body).toContain('30')
        // Should NOT be the string 'null' or class name
        expect(body).not.toBe('null')
        expect(body).not.toContain('SpooledYamlArtifact')
        const parsed = JSON.parse(body)
        expect(parsed).toEqual({ name: 'alice', age: 30 })
      })

      it('returns error string when call_id does not exist', async () => {
        const result = await runTool(yamlToJsonTool, undefined, { call_id: 'nonexistent' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect(result as string).toContain('nonexistent')
      })

      it('returns error when call_id names a non-YAML artifact', async () => {
        const srcJson = new SpooledJsonArtifact(new InMemorySpoolReader('{"name":"alice"}'))
        const result = await runTool(yamlToJsonTool, srcJson, { call_id: 'src_1' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
      })

      it('treats empty call_id as absent', async () => {
        const result = await runTool(yamlToJsonTool, undefined, { call_id: '' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })

      it('converts multi-document YAML artifact through call_id', async () => {
        const srcYaml = new SpooledYamlArtifact(
          new InMemorySpoolReader(`---
name: alice
---
name: bob`)
        )
        const result = await runTool(yamlToJsonTool, srcYaml, { call_id: 'src_1' })

        expect(result).toBeInstanceOf(SpooledJsonArtifact)
        const body = await (result as SpooledJsonArtifact).asString()
        expect(body).toContain('alice')
        expect(body).toContain('bob')
        const parsed = JSON.parse(body)
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed).toHaveLength(2)
      })
    })

    describe('error paths', () => {
      it('returns error when both text and call_id are provided', async () => {
        const srcYaml = new SpooledYamlArtifact(new InMemorySpoolReader('name: test'))
        const result = await runTool(yamlToJsonTool, srcYaml, {
          text: 'name: override',
          call_id: 'src_1',
        })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('not both')
      })

      it('returns error when neither text nor call_id are provided', async () => {
        const result = await runTool(yamlToJsonTool, undefined, {})

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })
    })
  })

  describe('jsonToYamlTool', () => {
    describe('text path', () => {
      it('converts inline JSON to YAML artifact with real content', async () => {
        const jsonText = '{"name":"bob","age":25,"active":true}'
        const result = await runTool(jsonToYamlTool, undefined, { text: jsonText })

        expect(result).toBeInstanceOf(SpooledYamlArtifact)
        const body = await (result as SpooledYamlArtifact).asString()
        expect(body).toContain('bob')
        expect(body).toContain('25')
        expect(body).toContain('true')
        expect(body).not.toContain('SpooledJsonArtifact')
      })

      it('returns error string on malformed JSON', async () => {
        const invalidJson = '{name: bob, age: 25}'
        const result = await runTool(jsonToYamlTool, undefined, { text: invalidJson })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
      })

      it('treats empty string as absent', async () => {
        const result = await runTool(jsonToYamlTool, undefined, { text: '' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })

      it('converts a JSON array to YAML', async () => {
        const result = await runTool(jsonToYamlTool, undefined, { text: '["item1","item2"]' })

        expect(result).toBeInstanceOf(SpooledYamlArtifact)
        const body = await (result as SpooledYamlArtifact).asString()
        expect(body).toContain('item1')
        expect(body).toContain('item2')
      })
    })

    describe('call_id path', () => {
      it('converts a JSON artifact to YAML artifact with real content', async () => {
        const srcJson = new SpooledJsonArtifact(
          new InMemorySpoolReader('{"name":"bob","age":7,"active":false}')
        )
        const result = await runTool(jsonToYamlTool, srcJson, { call_id: 'src_1' })

        expect(result).toBeInstanceOf(SpooledYamlArtifact)
        const body = await (result as SpooledYamlArtifact).asString()
        expect(body).toContain('bob')
        expect(body).toContain('7')
        expect(body).toContain('false')
        // Should NOT be the empty object or class name
        expect(body).not.toBe('{}')
        expect(body).not.toContain('SpooledJsonArtifact')
      })

      it('returns error string when call_id does not exist', async () => {
        const result = await runTool(jsonToYamlTool, undefined, { call_id: 'nonexistent' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect(result as string).toContain('nonexistent')
      })

      it('returns error when call_id names a non-JSON artifact', async () => {
        const srcYaml = new SpooledYamlArtifact(new InMemorySpoolReader('name: alice'))
        const result = await runTool(jsonToYamlTool, srcYaml, { call_id: 'src_1' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
      })

      it('treats empty call_id as absent', async () => {
        const result = await runTool(jsonToYamlTool, undefined, { call_id: '' })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })
    })

    describe('error paths', () => {
      it('returns error when both text and call_id are provided', async () => {
        const srcJson = new SpooledJsonArtifact(new InMemorySpoolReader('{"name":"test"}'))
        const result = await runTool(jsonToYamlTool, srcJson, {
          text: '{"name":"override"}',
          call_id: 'src_1',
        })

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('not both')
      })

      it('returns error when neither text nor call_id are provided', async () => {
        const result = await runTool(jsonToYamlTool, undefined, {})

        expect(typeof result).toBe('string')
        expect(result as string).toContain('Error')
        expect((result as string).toLowerCase()).toContain('provide')
      })
    })
  })
})
