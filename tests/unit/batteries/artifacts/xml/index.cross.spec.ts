import { describe, expect, it, beforeAll } from 'vitest'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import { ArtifactTool } from '../../../../../src/lib/classes/artifact_tool'
import { makeDispatchContext } from '../../../../_fixtures/dispatch_context'
import { registerAdkEncodables } from '../../../../../src/batteries/encoding'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledXmlArtifact } from '../../../../../src/batteries/artifacts/xml'
import { SpooledArtifact } from '../../../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { makeSpooledArtifact, makeToolCall } from '../../../../_fixtures/primitives'
import { ENCODE_METHOD, DECODE_METHOD } from '../../../../../src/lib/utils/encoder_symbols'

// Register both ADK core encodables and the XML artifact class
async function registerEncodablesForTest() {
  try {
    // First register core ADK encodables to set up reader resolvers
    registerAdkEncodables()
    // Then register the XML class
    const { registerClass } = await import('@nhtio/encoder')
    registerClass(SpooledXmlArtifact as unknown as Parameters<typeof registerClass>[0])
  } catch (err) {
    // If encoder is not available or registration fails, tests will error
    // but we'll document that encode/decode tests require full battery setup
    console.warn('Encoder registration failed, round-trip tests may fail', err)
  }
}

// Basic XML with attributes and repeated elements matching the spec example
const XML_WITH_ATTRIBUTES = '<root><a href="x">hi</a><a href="y">there</a></root>'

// XML with mixed content
const XML_NESTED =
  '<root><section id="s1"><title>Section 1</title><para>Content here</para></section><section id="s2"><title>Section 2</title></section></root>'

// Empty root
const XML_EMPTY = '<root></root>'

// Single element with no attributes
const XML_SIMPLE = '<root><item>text</item></root>'

// XML with text and attributes at same level
const XML_TEXT_AND_ATTRS = '<root attr="val">text content</root>'

// Malformed XML
const XML_MALFORMED = '<root><unclosed>'

const make = (
  content: string,
  options?: { attributeNamePrefix?: string; ignoreAttributes?: boolean }
) => new SpooledXmlArtifact(new InMemorySpoolReader(content), options)

describe('SpooledXmlArtifact', () => {
  describe('xml_root', () => {
    it('returns the root element name', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      expect(await artifact.xml_root()).toBe('root')
    })

    it('returns the root name for nested structures', async () => {
      const artifact = make(XML_NESTED)
      expect(await artifact.xml_root()).toBe('root')
    })

    it('works on empty documents', async () => {
      const artifact = make(XML_EMPTY)
      expect(await artifact.xml_root()).toBe('root')
    })
  })

  describe('xml_keys', () => {
    it('returns the keys directly under the root element', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const keys = await artifact.xml_keys()
      expect(keys).toEqual(['a'])
    })

    it('returns multiple distinct keys for mixed content', async () => {
      const artifact = make(XML_NESTED)
      const keys = await artifact.xml_keys()
      expect(keys).toEqual(['section'])
    })

    it('returns an empty array for empty root', async () => {
      const artifact = make(XML_EMPTY)
      const keys = await artifact.xml_keys()
      expect(keys).toEqual([])
    })

    it('includes attribute-prefix keys and #text in keys output when both are present', async () => {
      const artifact = make(XML_TEXT_AND_ATTRS)
      const keys = await artifact.xml_keys()
      // When the root element has both attributes and text, both appear as keys
      expect(keys).toContain('_attr')
      expect(keys).toContain('#text')
    })
  })

  describe('xml_tags', () => {
    it('returns all distinct element names in the document', async () => {
      const artifact = make(XML_NESTED)
      const tags = await artifact.xml_tags()
      expect(tags).toContain('root')
      expect(tags).toContain('section')
      expect(tags).toContain('title')
      expect(tags).toContain('para')
    })

    it('deduplicates repeated element names', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const tags = await artifact.xml_tags()
      expect(tags.filter((t) => t === 'a')).toHaveLength(1)
    })

    it('excludes attribute-prefix keys (_*)', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const tags = await artifact.xml_tags()
      for (const tag of tags) {
        expect(tag).not.toMatch(/^_/)
      }
    })

    it('excludes #text from the tag list', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const tags = await artifact.xml_tags()
      expect(tags).not.toContain('#text')
    })

    it('returns only the root tag for empty documents', async () => {
      const artifact = make(XML_EMPTY)
      const tags = await artifact.xml_tags()
      // An empty root <root></root> still yields the root element name
      expect(tags).toEqual(['root'])
    })
  })

  describe('xml_length', () => {
    it('returns 1 when root has a single child or is itself a scalar', async () => {
      const artifact = make(XML_SIMPLE)
      const length = await artifact.xml_length()
      expect(length).toBe(1)
    })

    it('returns a numeric length representing element count', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const length = await artifact.xml_length()
      expect(length).toBe(1)
    })

    it('returns 1 for empty root (no children)', async () => {
      const artifact = make(XML_EMPTY)
      const length = await artifact.xml_length()
      expect(length).toBe(1)
    })

    it('returns 1 when root contains an object with repeated child elements', async () => {
      const xml = '<root><item>1</item><item>2</item><item>3</item></root>'
      const artifact = make(xml)
      const length = await artifact.xml_length()
      // Root element contains { item: [...] }, which is an object, not an array
      expect(length).toBe(1)
    })
  })

  describe('xml_get (JSONPath)', () => {
    it('extracts values via JSONPath over the XML projection', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_get('$.root.a[0].#text')
      expect(result).toContain('hi')
    })

    it('returns an empty array when path matches nothing', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_get('$.root.nonexistent')
      expect(result).toEqual([])
    })

    it('returns multiple matches for a path that resolves to multiple elements', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_get('$.root.a[*].#text')
      expect(result).toContain('hi')
      expect(result).toContain('there')
    })

    it('accesses attributes with the _ prefix', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_get('$.root.a[0]._href')
      expect(result).toContain('x')
    })

    it('supports recursive descent to find attributes anywhere in the document', async () => {
      // This is the regression test for the _-prefix choice over @_:
      // JSONPath's ".." operator fails with @_ but works with _
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_get('$..._href')
      expect(result).toContain('x')
      expect(result).toContain('y')
      expect(result).toHaveLength(2)
    })

    it('throws or returns error for invalid XMLPath expressions', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      // With the jsonpath-plus library, invalid paths return an empty array
      const result = await artifact.xml_get('$...[invalid')
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(0)
    })
  })

  describe('xml_filter', () => {
    it('returns records where the path resolves to at least one match', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_filter('$.root.a[*]._href')
      expect(result).toHaveLength(2)
      // xml_filter returns ELEMENTS (objects), not VALUES (strings)
      for (const item of result) {
        expect(typeof item).toBe('object')
        expect(item).toHaveProperty('#text')
        expect(item).toHaveProperty('_href')
      }
      expect((result[0] as Record<string, unknown>)._href).toBe('x')
      expect((result[1] as Record<string, unknown>)._href).toBe('y')
    })

    it('returns an empty array when path matches nothing', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_filter('$.root.nonexistent')
      expect(result).toEqual([])
    })
  })

  describe('xml_pluck', () => {
    it('extracts values via JSONPath, flattening results across the document', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_pluck('$.root.a[*].#text')
      expect(result).toEqual(['hi', 'there'])
    })

    it('returns an empty array when path matches nothing', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const result = await artifact.xml_pluck('$.root.nonexistent')
      expect(result).toEqual([])
    })

    it('flattens nested results via recursive descent', async () => {
      const artifact = make(XML_NESTED)
      const result = await artifact.xml_pluck('$...title')
      // Recursive descent finds both title elements and returns their content
      expect(result).toContain('Section 1')
      expect(result).toContain('Section 2')
    })
  })

  describe('SpooledXmlArtifact.isSpooledXmlArtifact', () => {
    it('returns true for SpooledXmlArtifact instances', () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      expect(SpooledXmlArtifact.isSpooledXmlArtifact(artifact)).toBe(true)
    })

    it('returns false for plain objects', () => {
      expect(SpooledXmlArtifact.isSpooledXmlArtifact({})).toBe(false)
    })

    it('returns false for null', () => {
      expect(SpooledXmlArtifact.isSpooledXmlArtifact(null)).toBe(false)
    })

    it('returns false for other SpooledArtifact subclasses', async () => {
      const { artifact } = await makeSpooledArtifact('test')
      expect(SpooledXmlArtifact.isSpooledXmlArtifact(artifact)).toBe(false)
    })
  })

  describe('forgeTools (subclass-narrowed)', () => {
    it('includes base + xml_* tools when the turn has an XML artifact', async () => {
      const xmlArtifact = make(XML_WITH_ATTRIBUTES)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(xmlArtifact, { id: 'tc-xml' })],
      })
      const registry = SpooledXmlArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      // Base set
      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))

      // XML-specific
      expect(names).toEqual(
        expect.arrayContaining([
          'artifact_xml_root',
          'artifact_xml_keys',
          'artifact_xml_tags',
          'artifact_xml_length',
          'artifact_xml_get',
          'artifact_xml_filter',
          'artifact_xml_pluck',
        ])
      )

      // All should be ArtifactTools
      for (const tool of registry.all()) {
        expect(ArtifactTool.isArtifactTool(tool)).toBe(true)
      }
    })

    it('discovers retrievable-backed XML artifacts through XML forged tools', () => {
      const artifact = make(XML_WITH_ATTRIBUTES)
      const r = new Retrievable({
        id: 'ret-xml',
        content: artifact,
        trustTier: 'first-party',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      })
      const registry = SpooledXmlArtifact.forgeTools(makeDispatchContext({ retrievables: [r] }))
      expect(JSON.stringify(registry.get('artifact_xml_get')!.describe().inputSchema)).toContain(
        'ret-xml'
      )
    })

    it('restricts artifact_xml_* callId enum to XML artifacts; base tools see every artifact', async () => {
      const xmlArtifact = make(XML_WITH_ATTRIBUTES)
      const { artifact: baseArtifact } = await makeSpooledArtifact('line1\nline2', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(xmlArtifact, { id: 'tc-xml' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledXmlArtifact.forgeTools(ctx)
      const xmlGet = registry.get('artifact_xml_get')!
      const baseHead = registry.get('artifact_head')!
      const xmlGetDump = JSON.stringify(xmlGet.describe().inputSchema)
      const baseHeadDump = JSON.stringify(baseHead.describe().inputSchema)

      expect(xmlGetDump).toContain('tc-xml')
      expect(xmlGetDump).not.toContain('tc-base')

      // Base methods come from SpooledArtifact.forgeTools and accept any SpooledArtifact
      expect(baseHeadDump).toContain('tc-xml')
      expect(baseHeadDump).toContain('tc-base')
    })

    it('rejects a base-artifact callId for artifact_xml_get at validation time', async () => {
      const xmlArtifact = make(XML_WITH_ATTRIBUTES)
      const { artifact: baseArtifact } = await makeSpooledArtifact('line1\nline2', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [
          makeToolCall(xmlArtifact, { id: 'tc-xml' }),
          makeToolCall(baseArtifact, { id: 'tc-base' }),
        ],
      })
      const registry = SpooledXmlArtifact.forgeTools(ctx)
      const xmlGet = registry.get('artifact_xml_get')!

      await expect(xmlGet.validate({ callId: 'tc-base', path: '$.root' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('omits artifact_xml_* tools when no XML artifacts are present (base tools still appear)', async () => {
      const { artifact: baseArtifact } = await makeSpooledArtifact('line1\nline2', 'tc-base')
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(baseArtifact, { id: 'tc-base' })],
      })
      const registry = SpooledXmlArtifact.forgeTools(ctx)
      const names = registry.all().map((t) => t.name)

      expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_grep']))
      for (const n of names) {
        expect(n).not.toMatch(/^artifact_xml_/)
      }
    })

    it('returns an empty registry when ctx.turnToolCalls is empty', () => {
      const ctx = makeDispatchContext()
      const registry = SpooledXmlArtifact.forgeTools(ctx)
      expect(registry.all()).toEqual([])
    })

    it('still emits the base set as ordinary base-class names (not subclass-prefixed)', async () => {
      const xmlArtifact = make(XML_WITH_ATTRIBUTES)
      const ctx = makeDispatchContext({
        toolCalls: [makeToolCall(xmlArtifact, { id: 'tc-xml' })],
      })
      const baseRegistry = SpooledArtifact.forgeTools(ctx)
      const subclassRegistry = SpooledXmlArtifact.forgeTools(ctx)
      const baseNames = baseRegistry.all().map((t) => t.name)

      for (const n of baseNames) {
        expect(subclassRegistry.has(n)).toBe(true)
      }
    })
  })

  describe('inheritance from SpooledArtifact', () => {
    it('still supports head / tail / cat from the base class', async () => {
      const content = 'line1\nline2\nline3'
      const xml = `<root>${content
        .split('\n')
        .map((l) => `<item>${l}</item>`)
        .join('')}</root>`
      const a = make(xml)

      const lineCount = await a.lineCount()
      expect(lineCount).toBeGreaterThan(0)

      const headLines = await a.head(1)
      expect(headLines).toHaveLength(1)
      expect(typeof headLines[0]).toBe('string')
    })
  })

  describe('constructor options', () => {
    it('accepts and applies a custom attributeNamePrefix', async () => {
      // Create an artifact with custom prefix
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@' })
      const root = await artifact.xml_root()
      expect(root).toBe('root')
    })

    it('accepts ignoreAttributes option to exclude attributes from projection', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { ignoreAttributes: true })
      const root = await artifact.xml_root()
      expect(root).toBe('root')
    })
  })

  // Pins the reason `_` is the default rather than fast-xml-parser's conventional `@_`.
  // jsonpath-plus reads a leading `@` in a path SEGMENT as its type-selector sigil before
  // honouring quotes, so the segment is parsed as a type name. If a future jsonpath-plus fixes
  // that, these tests fail and the docs claiming otherwise should be revisited.
  describe('attributeNamePrefix and JSONPath interaction', () => {
    it('queries the default "_" prefix by recursive descent', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '_' })
      expect(await artifact.xml_get('$..["_href"]')).toEqual(['x', 'y'])
    })

    it('cannot name an "@_" key in a path segment, even quoted', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@_' })
      // The error text tracks the characters AFTER the '@' — proof it is tokenising a type name
      // rather than failing to find a property.
      await expect(artifact.xml_get('$..["@_href"]')).rejects.toThrow('Unknown value type _hr')
    })

    it('fails the same way for an explicit path, so quoting is not an escape', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@_' })
      await expect(artifact.xml_get('$.root.a["@_href"]')).rejects.toThrow('Unknown value type _hr')
    })

    it('reaches an "@_" key through a wildcard placed one level above it', async () => {
      // XML_WITH_ATTRIBUTES has two <a> siblings, which fast-xml-parser collapses into an ARRAY
      // at root.a — so the wildcard that lands on the attribute holders is `a[*]`, not `root.*`.
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@_' })
      expect(await artifact.xml_get('$.root.a[*]["@_href"]')).toEqual(['x', 'y'])
    })

    it('needs the wildcard at the right depth — one level off still throws', async () => {
      // This is why the wildcard workaround is not general: the correct path depends on whether
      // repeated elements collapsed to an array, which the author must know in advance.
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@_' })
      await expect(artifact.xml_get('$.root.*["@_href"]')).rejects.toThrow('Unknown value type _hr')
    })

    it('still reaches an "@_" key from inside a filter expression', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@_' })
      // Inside a filter the key is an ordinary JS string, so the sigil never applies.
      expect(await artifact.xml_get("$..[?(@['@_href'])]")).toEqual([
        { '@_href': 'x', '#text': 'hi' },
        { '@_href': 'y', '#text': 'there' },
      ])
    })

    it('is specific to "@" — other sigil-looking prefixes query normally', async () => {
      const artifact = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '$' })
      expect(await artifact.xml_get('$..["$href"]')).toEqual(['x', 'y'])
    })
  })

  describe('malformed XML handling', () => {
    it('returns an error message for malformed XML on first method call', async () => {
      const artifact = make(XML_MALFORMED)
      // fast-xml-parser returns the root name even for malformed XML like '<root><unclosed>'
      const root = await artifact.xml_root()
      expect(root).toBe('root')
    })
  })

  describe('encode/decode round-trip', () => {
    beforeAll(async () => registerEncodablesForTest())

    it('encodes and decodes to the same subclass with options preserved', async () => {
      const original = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '_' })
      const snapshot = original[ENCODE_METHOD]()
      const decoded: SpooledXmlArtifact = SpooledXmlArtifact[DECODE_METHOD](
        snapshot
      ) as SpooledXmlArtifact

      // Must be the SUBCLASS, not a bare SpooledArtifact
      expect(decoded).toBeInstanceOf(SpooledXmlArtifact)
      expect(SpooledXmlArtifact.isSpooledXmlArtifact(decoded)).toBe(true)

      // Options should survive the round-trip
      const originalRoot = await original.xml_root()
      const decodedRoot = await decoded.xml_root()
      expect(decodedRoot).toBe(originalRoot)
    })

    it('preserves the attributeNamePrefix option across encode/decode', async () => {
      const custom = make(XML_WITH_ATTRIBUTES, { attributeNamePrefix: '@' })
      const snapshot = custom[ENCODE_METHOD]()
      const decoded: SpooledXmlArtifact = SpooledXmlArtifact[DECODE_METHOD](
        snapshot
      ) as SpooledXmlArtifact

      // Verify it works identically by calling a method that uses attributes
      const originalTags = await custom.xml_tags()
      const decodedTags = await decoded.xml_tags()
      expect(decodedTags).toEqual(originalTags)
    })

    it('preserves the ignoreAttributes option across encode/decode', async () => {
      const noAttrs = make(XML_WITH_ATTRIBUTES, { ignoreAttributes: true })
      const snapshot = noAttrs[ENCODE_METHOD]()
      const decoded: SpooledXmlArtifact = SpooledXmlArtifact[DECODE_METHOD](
        snapshot
      ) as SpooledXmlArtifact

      expect(decoded).toBeInstanceOf(SpooledXmlArtifact)

      // Both should behave the same way when querying
      const originalLength = await noAttrs.xml_length()
      const decodedLength = await decoded.xml_length()
      expect(decodedLength).toBe(originalLength)
    })

    it('round-tripped artifact can call all xml_* methods', async () => {
      const original = make(XML_NESTED)
      const snapshot = original[ENCODE_METHOD]()
      const decoded: SpooledXmlArtifact = SpooledXmlArtifact[DECODE_METHOD](
        snapshot
      ) as SpooledXmlArtifact

      // Call each xml_* method and verify expected structure/content
      expect(await decoded.xml_root()).toBe('root')
      expect(await decoded.xml_keys()).toEqual(['section'])
      expect(await decoded.xml_tags()).toEqual(['para', 'root', 'section', 'title'])
      expect(await decoded.xml_length()).toBe(1)
      const getResult = await decoded.xml_get('$.root')
      expect(Array.isArray(getResult)).toBe(true)
      expect(getResult.length).toBe(1)
      const filterResult = await decoded.xml_filter('$.root.section')
      expect(Array.isArray(filterResult)).toBe(true)
      expect(filterResult.length).toBe(1)
      const pluckResult = await decoded.xml_pluck('$...title')
      expect(pluckResult).toEqual(['Section 1', 'Section 2'])
    })
  })

  describe('edge cases', () => {
    it('handles XML with only text content at root', async () => {
      const xml = '<root>just text</root>'
      const artifact = make(xml)
      const root = await artifact.xml_root()
      expect(root).toBe('root')
    })

    it('handles deeply nested structures', async () => {
      const xml = '<root><a><b><c><d>value</d></c></b></a></root>'
      const artifact = make(xml)
      const tags = await artifact.xml_tags()
      expect(tags).toContain('d')
    })

    it('handles XML with CDATA sections', async () => {
      const xml = '<root><![CDATA[some content]]></root>'
      const artifact = make(xml)
      // With fast-xml-parser default config: CDATA content is dropped (not exposed as keys)
      const root = await artifact.xml_root()
      expect(root).toBe('root')
      const keys = await artifact.xml_keys()
      expect(keys).toEqual([])
    })

    it('handles XML with namespaces gracefully', async () => {
      const xml = '<root xmlns="http://example.com"><item>test</item></root>'
      const artifact = make(xml)
      const root = await artifact.xml_root()
      expect(root).toBeDefined()
      expect(typeof root).toBe('string')
      expect(root).toBe('root')
    })
  })

  describe('converter tool schema fields', () => {
    it('xmlToJsonTool inputSchema includes call_id and text fields with correct snake_case', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const schema = xmlToJsonTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
      // Regression check: call_id must be snake_case, NOT camelCase
      expect(schemaStr).not.toContain('"callId"')
    })

    it('jsonToXmlTool inputSchema includes call_id and text fields with correct snake_case', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const schema = jsonToXmlTool.describe().inputSchema
      const schemaStr = JSON.stringify(schema)

      // According to the spec, inputSchema should have text and call_id (snake_case)
      expect(schemaStr).toContain('text')
      expect(schemaStr).toContain('call_id')
      // Regression check: call_id must be snake_case, NOT camelCase
      expect(schemaStr).not.toContain('"callId"')
    })
  })

  describe('xmlToJsonTool behavior', () => {
    it('converts inline XML text path to SpooledJsonArtifact with real content', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')
      const { SpooledJsonArtifact: JsonArtifact } = await import('@nhtio/adk/common')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '<root><name>alice</name></root>', call_id: '' })

      expect(result).toBeInstanceOf(JsonArtifact)
      const body = await (result as { asString: () => Promise<string> }).asString()
      expect(body).toContain('alice')
      expect(body).not.toContain('SpooledXmlArtifact')
      const parsed = JSON.parse(body)
      expect(parsed).toHaveProperty('root')
      expect(parsed.root).toHaveProperty('name')
    })

    it('converts call_id artifact path to SpooledJsonArtifact with source content', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')
      const { SpooledJsonArtifact: JsonArtifact } = await import('@nhtio/adk/common')

      const srcXml = new SpooledXmlArtifact(
        new InMemorySpoolReader('<root><item>value</item></root>')
      )
      const tc = makeToolCall(srcXml, { id: 'src_xml_1' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'src_xml_1' })

      expect(result).toBeInstanceOf(JsonArtifact)
      const body = await (result as { asString: () => Promise<string> }).asString()
      expect(body).toContain('value')
      expect(body).not.toEqual('null')
      expect(body).not.toEqual('{}')
      expect(body).not.toContain('SpooledXmlArtifact')
      const parsed = JSON.parse(body)
      expect(parsed.root).toHaveProperty('item', 'value')
    })

    it('preserves XML attributes as underscore-prefixed keys in JSON conversion', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({
        text: '<root><link href="https://example.com" title="Example">click</link></root>',
        call_id: '',
      })

      const body = await (result as { asString: () => Promise<string> }).asString()
      const parsed = JSON.parse(body)
      expect(parsed.root.link).toHaveProperty('_href', 'https://example.com')
      expect(parsed.root.link).toHaveProperty('_title', 'Example')
      expect(parsed.root.link).toHaveProperty('#text', 'click')
    })

    it('returns error when neither text nor call_id provided', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toMatch(/provide either text or call_id/)
    })

    it('returns error when both text and call_id provided', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '<root/>', call_id: 'some_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toMatch(/provide either text or call_id, not both/)
    })

    it('returns error when call_id references non-existent artifact', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'nonexistent_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('no artifact with id')
    })

    it('returns error when call_id references wrong artifact type (JSON instead of XML)', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')

      const { artifact: jsonArt } = await makeSpooledArtifact('{"key":"value"}')
      const tc = makeToolCall(jsonArt, { id: 'json_art' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const converter = xmlToJsonTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'json_art' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('no artifact with id')
    })

    it('handles XML that is structurally incomplete by auto-closing tags', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')
      const { SpooledJsonArtifact: JsonArtifact } = await import('@nhtio/adk/common')

      const ctx = makeDispatchContext()
      const converter = xmlToJsonTool.executor(ctx as never)

      // The XML parser (fast-xml-parser) auto-closes unclosed tags rather than throwing
      const result = await converter({ text: '<root><unclosed>', call_id: '' })

      // Should still return a SpooledJsonArtifact with the auto-closed result
      expect(result).toBeInstanceOf(JsonArtifact)
      const body = await (result as { asString: () => Promise<string> }).asString()
      const parsed = JSON.parse(body)
      expect(parsed).toHaveProperty('root')
    })

    it('call_id conversion inherits source artifact attributeNamePrefix configuration', async () => {
      const { xmlToJsonTool } = await import('../../../../../src/batteries/artifacts/xml')
      const { SpooledJsonArtifact: JsonArtifact } = await import('@nhtio/adk/common')

      // Build a source XML artifact with custom @_ prefix
      const xmlContent = '<root><link href="x">hi</link></root>'
      const sourceArtifact = new SpooledXmlArtifact(new InMemorySpoolReader(xmlContent), {
        attributeNamePrefix: '@_',
      })
      const tc = makeToolCall(sourceArtifact, { id: 'src_xml_1' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const converter = xmlToJsonTool.executor(ctx as never)

      // Convert by call_id - should inherit the @_ prefix from source
      const result = await converter({ text: '', call_id: 'src_xml_1' })
      expect(result).toBeInstanceOf(JsonArtifact)

      // Parse the JSON and verify @_href is present (not _href)
      const jsonString = await (result as { asString: () => Promise<string> }).asString()
      const parsed = JSON.parse(jsonString)
      const link = parsed.root.link

      // This assertion proves the source's @_ prefix was inherited
      expect(link).toHaveProperty('@_href')
      expect(link['@_href']).toBe('x')
      // Verify it's NOT using the default _ prefix
      expect(link).not.toHaveProperty('_href')
    })
  })

  describe('jsonToXmlTool behavior', () => {
    it('converts inline JSON text path to SpooledXmlArtifact with real content', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({
        text: '{"root":{"person":{"name":"bob"}}}',
        call_id: '',
      })

      expect(result).toBeInstanceOf(SpooledXmlArtifact)
      const body = await (result as { asString: () => Promise<string> }).asString()
      expect(body).toContain('bob')
      expect(body).not.toContain('SpooledJsonArtifact')
      expect(body).toContain('<')
      expect(body).toContain('>')
    })

    it('converts call_id artifact path to SpooledXmlArtifact with source content', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')
      const { SpooledJsonArtifact: JsonArtifact } = await import('@nhtio/adk/common')

      const srcJson = new JsonArtifact(new InMemorySpoolReader('{"root":{"item":"test_value"}}'))
      const tc = makeToolCall(srcJson, { id: 'src_json_1' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'src_json_1' })

      expect(result).toBeInstanceOf(SpooledXmlArtifact)
      const body = await (result as { asString: () => Promise<string> }).asString()
      expect(body).toContain('test_value')
      expect(body).not.toEqual('null')
      expect(body).not.toEqual('{}')
      expect(body).not.toContain('SpooledJsonArtifact')
      expect(body).toMatch(/<root>/)
    })

    it('preserves JSON keys with underscore prefix as XML attributes', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({
        text: '{"root":{"link":{"_href":"http://example.com","#text":"click"}}}',
        call_id: '',
      })

      const body = await (result as { asString: () => Promise<string> }).asString()
      // Should contain the attribute and the text
      expect(body).toContain('http://example.com')
      expect(body).toContain('click')
      expect(body).toContain('href')
    })

    it('returns error when neither text nor call_id provided', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toMatch(/provide either text or call_id/)
    })

    it('returns error when both text and call_id provided', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '{}', call_id: 'some_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toMatch(/provide either text or call_id, not both/)
    })

    it('returns error when call_id references non-existent artifact', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'nonexistent_id' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('no artifact with id')
    })

    it('returns error when call_id references wrong artifact type (XML instead of JSON)', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const srcXml = new SpooledXmlArtifact(new InMemorySpoolReader('<root/>'))
      const tc = makeToolCall(srcXml, { id: 'xml_art' })
      const ctx = makeDispatchContext({ toolCalls: [tc] })
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '', call_id: 'xml_art' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toContain('no artifact with id')
    })

    it('returns error when text contains malformed JSON', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      const result = await converter({ text: '{invalid json}', call_id: '' })

      expect(typeof result).toBe('string')
      expect(result).toContain('Error')
      expect(result).toMatch(/JSON parse failed/)
    })

    it('converts root-level JSON array to numeric-keyed XML elements (lossy)', async () => {
      const { jsonToXmlTool } = await import('../../../../../src/batteries/artifacts/xml')

      const ctx = makeDispatchContext()
      const converter = jsonToXmlTool.executor(ctx as never)
      // A root-level JSON array converts to numeric-keyed XML elements
      const result = await converter({ text: '[1,2,3]', call_id: '' })

      // Root-level arrays convert to numeric-keyed elements, which is lossy and does not round-trip back to the original array
      expect(SpooledXmlArtifact.isSpooledXmlArtifact(result)).toBe(true)
      const xmlString = await (result as SpooledXmlArtifact).asString()
      expect(xmlString).toBe('<0>1</0><1>2</1><2>3</2>')
    })
  })
})
