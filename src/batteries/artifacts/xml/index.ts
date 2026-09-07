/**
 * A structured artifact battery for XML documents.
 *
 * @module @nhtio/adk/batteries/artifacts/xml
 *
 * @remarks
 * Provides {@link SpooledXmlArtifact} — a `SpooledArtifact` specialisation that parses XML
 * into a JSON projection and offers path-based query tools over that projection. The XML-to-JSON
 * mapping defaults to `ignoreAttributes: false` and `attributeNamePrefix: '_'`, both settable
 * per instance through the constructor; `preserveOrder: false` is fixed. Under the default
 * mapping:
 *
 * - Element attributes become keys prefixed with `_` (e.g., `root-element` with `href="x"`
 *   becomes `{ a: { _href: 'x', ... } }`).
 * - Element text content becomes a `#text` key when the element also has attributes or siblings.
 * - Repeated sibling elements collapse into an array.
 * - The full projection is queryable via JSONPath expressions (e.g., `$..name` finds all name
 *   elements anywhere in the tree). Attributes are accessed via underscore-prefixed keys,
 *   e.g. `$..["_href"]` for the href attribute (recursive descent).
 *
 * The battery also exports two converter `Tool` constants: `xmlToJsonTool` and `jsonToXmlTool`.
 * These accept either inline XML/JSON text or a reference to an artifact produced earlier in
 * the turn, and return the converted result as a new `SpooledJsonArtifact` or
 * `SpooledXmlArtifact`.
 *
 * Battery exceptions are defined in this module's `exceptions.ts` file — `createException`
 * re-exported from `@nhtio/adk/factories`. Decoding a {@link SpooledXmlArtifact} instance via
 * `decode()` throws until `registerArtifactEncodables()` has run (see
 * {@link @nhtio/adk/batteries/artifacts!registerArtifactEncodables}).
 */

import { v6 as uuidv6 } from 'uuid'
import { JSONPath } from 'jsonpath-plus'
import { validator } from '@nhtio/validation'
import { resolveSpoolReader } from '@nhtio/adk/common'
import { SpooledJsonArtifact } from '@nhtio/adk/common'
import { isInstanceOf, isError, isObject } from '@nhtio/adk/guards'
import { E_XML_PARSER_PEER_MISSING, E_XML_PARSE_FAILED } from './exceptions'
import { ArtifactTool, Tool, ToolRegistry, ReaderDescriptor } from '@nhtio/adk/common'

// Well-known @nhtio/encoder contract keys, resolved through the global symbol registry.
// These are identical to the symbols core uses, with no import edge on the optional peer.
const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')
import {
  SpooledArtifact,
  collectArtifactCompatibleIds,
  resolveArtifactById,
  defaultSerialise,
} from '@nhtio/adk/spooled_artifact'
import type { SpoolReader } from '@nhtio/adk/types'
import type { XMLParser, XMLBuilder } from 'fast-xml-parser'
import type { ToolMethodDescriptor, DispatchContext } from '@nhtio/adk/types'

/** Snapshot payload for the encoder contract; the encoder treats it as opaque. */
type AdkEncodableSnapshot = unknown

/**
 * Lazy-loaded promise for the `fast-xml-parser` module, cached at module scope.
 */
let xmlParserPromise:
  | Promise<{ XMLParser: typeof XMLParser; XMLBuilder: typeof XMLBuilder }>
  | undefined

/**
 * Lazily import and cache the `fast-xml-parser` module with battery-scoped error handling.
 *
 * @returns The imported module.
 * @throws {@link E_XML_PARSER_PEER_MISSING} when the module is unavailable.
 */
async function getXmlParser(): Promise<{
  XMLParser: typeof XMLParser
  XMLBuilder: typeof XMLBuilder
}> {
  xmlParserPromise ??= import('fast-xml-parser').catch((err) => {
    const detail = isError(err) ? err.message : String(err)
    throw new E_XML_PARSER_PEER_MISSING([detail])
  })
  return xmlParserPromise
}

/**
 * A {@link @nhtio/adk!SpooledArtifact} specialisation that adds XML-aware read operations.
 *
 * @remarks
 * The artifact parses XML into a JSON projection on first access and caches it for the
 * lifetime of the instance. The projection uses `ignoreAttributes` and `attributeNamePrefix` as
 * supplied to the constructor — defaulting to `false` and `'_'` — with `preserveOrder: false`.
 *
 * Under this mapping, an XML element like:
 *
 * `root-element` with an `href` attribute and text content becomes a JSON object like:
 * `{ root: { element: { _href: 'value', '#text': 'content' } } }`
 *
 * Attributes are prefixed with `_` by default rather than the conventional `@_`, because
 * `jsonpath-plus` reads a leading `@` in a path segment as its type-selector sigil before
 * honouring quotes: `$..["@_href"]` throws `Unknown value type _hr`, while `$..["_href"]`
 * matches. Text nodes use the `#text` key.
 *
 * All XML methods are async, consistent with {@link @nhtio/adk!SpooledArtifact}.
 *
 * Path-based methods (`xml_get`, `xml_filter`, `xml_pluck`) use
 * [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath) expressions over the projection.
 * Full JSONPath syntax is supported, including recursive descent (`..`), filter expressions,
 * and union selectors.
 */
export class SpooledXmlArtifact extends SpooledArtifact {
  #parsed: Record<string, unknown> | undefined
  #attributeNamePrefix: string
  #ignoreAttributes: boolean

  /**
   * @param reader - The backing store to read from.
   * @param options - Optional parser configuration.
   * @param options.attributeNamePrefix - Prefix for attribute keys (default: '_'). Set to '@_'
   *   if you need the conventional XML-to-JSON mapping, but be aware that naming such a key in a
   *   JSONPath segment fails — `$..["@_attr"]` throws `Unknown value type _at`, and quoting does
   *   not escape it. A filter expression still reaches it (`$..[?(@['@_attr'])]`); a wildcard
   *   does too, but only when placed exactly one level above the key, so the working path
   *   depends on whether repeated elements collapsed into an array.
   * @param options.ignoreAttributes - When true, ignore element attributes (default: false).
   */
  constructor(
    reader: SpoolReader,
    options?: {
      attributeNamePrefix?: string
      ignoreAttributes?: boolean
    }
  ) {
    super(reader)
    this.#attributeNamePrefix = options?.attributeNamePrefix ?? '_'
    this.#ignoreAttributes = options?.ignoreAttributes ?? false
  }

  /**
   * Returns `true` if `value` is a {@link SpooledXmlArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard. Safe against the
   * dual-module-copy case where two distinct `SpooledXmlArtifact` classes coexist in the same
   * realm.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link SpooledXmlArtifact} instance.
   */
  public static isSpooledXmlArtifact(value: unknown): value is SpooledXmlArtifact {
    return isInstanceOf(value, 'SpooledXmlArtifact', SpooledXmlArtifact)
  }

  /**
   * Returns the effective XML-to-JSON parser configuration for this artifact.
   *
   * @remarks
   * When converting an XML artifact to JSON by call_id, the converter inherits the source
   * artifact's attribute prefix and ignoreAttributes setting. This accessor exposes those
   * options so the converter can apply them consistently.
   *
   * @returns An object with `attributeNamePrefix` and `ignoreAttributes` keys.
   */
  public getParserOptions(): {
    attributeNamePrefix: string
    ignoreAttributes: boolean
  } {
    return {
      attributeNamePrefix: this.#attributeNamePrefix,
      ignoreAttributes: this.#ignoreAttributes,
    }
  }

  /**
   * The XML-specific artifact-query descriptors this class adds on top of the base set.
   *
   * @remarks
   * Lists `artifact_xml_root`, `artifact_xml_keys`, `artifact_xml_tags`, `artifact_xml_length`,
   * `artifact_xml_get`, `artifact_xml_filter`, `artifact_xml_pluck`. The base seven descriptors
   * (`artifact_head`, etc.) are NOT included here — they are forged separately by
   * {@link SpooledXmlArtifact.forgeTools}.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_xml_root',
      method: 'xml_root',
      description: 'The root element name of the XML document produced earlier in this turn.',
    },
    {
      name: 'artifact_xml_keys',
      method: 'xml_keys',
      description:
        'Keys directly under the root element of the XML document produced earlier in this turn.',
    },
    {
      name: 'artifact_xml_tags',
      method: 'xml_tags',
      description:
        'Every distinct element name in the XML document produced earlier in this turn, deduplicated. ' +
        'Call this before writing a path to an unfamiliar document — it tells you what elements are present.',
    },
    {
      name: 'artifact_xml_length',
      method: 'xml_length',
      description:
        'Element count when the root element contains an array of children; otherwise 1. ' +
        'The XML document was produced earlier in this turn.',
    },
    {
      name: 'artifact_xml_get',
      method: 'xml_get',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description(
            'JSONPath expression to query the document. Attributes appear with a leading underscore (e.g., _href). Use bracket notation for recursive descent: $..["_href"].'
          ),
      }),
      description:
        'Query the XML document via JSONPath. The document was produced earlier in this turn. ' +
        'Attributes appear as underscore-prefixed keys (e.g., _href for an href attribute). Use bracket notation in recursive-descent queries: $..["_href"].',
    },
    {
      name: 'artifact_xml_filter',
      method: 'xml_filter',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description(
            'JSONPath expression to filter the document. Attributes appear with a leading underscore (e.g., _href).'
          ),
      }),
      description:
        'Return XML elements whose content matches a JSONPath filter. Differs from artifact_xml_get: get returns matched values; filter returns the element objects containing them. The document was produced earlier in this turn. Attributes appear as underscore-prefixed keys (e.g., _href).',
    },
    {
      name: 'artifact_xml_pluck',
      method: 'xml_pluck',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description(
            'JSONPath expression to pluck values. Attributes appear with a leading underscore (e.g., _href).'
          ),
      }),
      description:
        'Alias for artifact_xml_get — extract values matching a JSONPath. The document was produced earlier in this turn. ' +
        'Attributes appear as underscore-prefixed keys (e.g., _href).',
    },
  ])

  /**
   * The root element name of the XML document.
   *
   * @returns The name of the root element.
   * @throws Error when the document is malformed or empty.
   */
  async xml_root(): Promise<string> {
    const parsed = await this.#resolveParsed()
    const keys = Object.keys(parsed)
    if (keys.length === 0) {
      throw new Error('XML document is empty')
    }
    return keys[0]
  }

  /**
   * Keys directly under the root element.
   *
   * @returns Array of key names at the root level.
   */
  async xml_keys(): Promise<string[]> {
    const parsed = await this.#resolveParsed()
    const rootKey = Object.keys(parsed)[0]
    if (!rootKey) return []
    const rootContent = parsed[rootKey]
    if (!isObject(rootContent)) return []
    return Object.keys(rootContent)
  }

  /**
   * Every distinct element name in the document, deduplicated.
   *
   * @remarks
   * Walks the entire projection recursively, excluding attribute keys (prefixed with the
   * configured `attributeNamePrefix`, default `_`) and `#text` keys. This is what a model
   * calls before it can write a path into an unfamiliar document.
   *
   * @returns Sorted array of unique element names.
   */
  async xml_tags(): Promise<string[]> {
    const parsed = await this.#resolveParsed()
    const tags = new Set<string>()
    const attributePrefix = this.#attributeNamePrefix

    function walk(obj: unknown): void {
      if (!isObject(obj)) return
      for (const [key, value] of Object.entries(obj)) {
        // Skip attribute keys and text nodes
        if (key.startsWith(attributePrefix) || key === '#text') {
          continue
        }
        tags.add(key)
        if (Array.isArray(value)) {
          for (const item of value) {
            walk(item)
          }
        } else {
          walk(value)
        }
      }
    }

    walk(parsed)
    return Array.from(tags).sort()
  }

  /**
   * Element count when the root contains an array of children; otherwise 1.
   *
   * @returns Number of elements.
   */
  async xml_length(): Promise<number> {
    const parsed = await this.#resolveParsed()
    const rootKey = Object.keys(parsed)[0]
    if (!rootKey) return 0
    const rootContent = parsed[rootKey]
    if (Array.isArray(rootContent)) {
      return rootContent.length
    }
    return 1
  }

  /**
   * Query the document via JSONPath expression.
   *
   * @param path - A JSONPath expression (e.g., `'$..name'`).
   * @returns Array of matched values.
   */
  async xml_get(path: string): Promise<unknown[]> {
    const parsed = await this.#resolveParsed()
    const results = JSONPath({ path, json: parsed })
    return results
  }

  /**
   * Returns the elements (subtrees) that match a JSONPath expression.
   *
   * @remarks
   * Evaluates the path against the XML projection and returns the elements that
   * contain matching values. Unlike xml_get (which returns matched values), xml_filter
   * returns the element objects containing those matches.
   *
   * Candidate set definition for XML's single-rooted projection:
   * - If the root element contains an array of repeated siblings (e.g., root.item
   *   where item is an array property), filters across those siblings and returns
   *   elements that have matching content.
   * - If the root element contains a single object, evaluates the path against it
   *   and returns it when matched.
   *
   * The path is evaluated using JSONPath-Plus with resultType 'all' to extract
   * parent elements of matched values. The immediate parent object of any matched
   * value is included in the result, deduplicating elements.
   *
   * Example: for XML with root containing multiple 'item' elements each with an
   * 'id' attribute, xml_filter('$.root.item[*]._id') returns the item elements
   * that have an id attribute, whereas xml_get would return the id values themselves.
   *
   * @param path - A JSONPath expression (e.g. '$.root.item[*]._id' or '$[?(@.status)]').
   * @returns Array of matching element subtrees. Empty array when no matches found.
   */
  async xml_filter(path: string): Promise<unknown[]> {
    const parsed = await this.#resolveParsed()
    const rootKey = Object.keys(parsed)[0]
    if (!rootKey) return []

    const rootContent = parsed[rootKey]

    // If the root content is an array of siblings, filter the array elements
    if (Array.isArray(rootContent)) {
      // Evaluate the path against each sibling element to see if it matches
      return rootContent.filter((element) => {
        const matches = JSONPath({ path, json: element as object })
        return Array.isArray(matches) && matches.length > 0
      })
    }

    // If the root content is a single object, use 'all' resultType to get parent objects
    if (isObject(rootContent)) {
      // Evaluate the path against the full parsed document to get match information
      const allMatches = JSONPath({
        path,
        json: parsed,
        resultType: 'all',
      }) as unknown

      if (!Array.isArray(allMatches) || allMatches.length === 0) {
        return []
      }

      // Extract parent objects, deduplicating by reference
      const parentSet = new Set<object>()
      for (const match of allMatches) {
        const m = match as Record<string, unknown>
        if (isObject(m.parent)) {
          parentSet.add(m.parent as object)
        }
      }

      return Array.from(parentSet)
    }

    // For scalar or other types, return empty
    return []
  }

  /**
   * Alias for xml_get — extract values matching a JSONPath.
   *
   * @param path - A JSONPath expression (e.g., `'$..name'`).
   * @returns Array of matched values.
   */
  async xml_pluck(path: string): Promise<unknown[]> {
    return this.xml_get(path)
  }

  /**
   * Standard subclass extension pattern: call `SpooledArtifact.forgeTools(ctx)` to produce
   * the base seven `artifact_*` tools narrowed to any `SpooledArtifact` in the turn, then
   * register one `ArtifactTool` per XML-specific descriptor narrowed to XML artifacts.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledXmlArtifact
    const compatibleIds = collectArtifactCompatibleIds(ctx, requires)
    if (compatibleIds.length === 0) return registry

    for (const descriptor of this.toolMethods) {
      const callIdSchema = validator
        .string()
        .valid(...compatibleIds)
        .required()
        .description('ToolCall id of the artifact to query.')

      const argsSchema = (
        descriptor.argsSchema ?? validator.object<Record<string, never>>({})
      ).append({
        callId: callIdSchema,
      })

      const tool = new ArtifactTool({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: argsSchema,
        ephemeral: true,
        onCollision: 'replace',
        handler: async (rawArgs, ctxInner) => {
          const args = rawArgs as Record<string, unknown> & { callId: string }
          const resolved = resolveArtifactById(ctxInner, args.callId, requires)
          if (!resolved) return `Error: no artifact with id ${args.callId} in this turn`
          const artifact = resolved.artifact
          const methodArgs: unknown[] = []
          if (
            descriptor.method === 'xml_get' ||
            descriptor.method === 'xml_filter' ||
            descriptor.method === 'xml_pluck'
          ) {
            methodArgs.push(args.path as string)
          }
          const fn = (artifact as unknown as Record<string, (...a: unknown[]) => unknown>)[
            descriptor.method
          ]
          if (typeof fn !== 'function') {
            return `Error: artifact has no method ${descriptor.method}`
          }
          const result = await Promise.resolve(fn.apply(artifact, methodArgs))
          const serialise = descriptor.serialise ?? defaultSerialise
          return serialise(result)
        },
      })
      registry.register(tool)
    }
    return registry
  }

  /**
   * Parses and caches the XML projection.
   *
   * @returns The parsed projection as a JSON object.
   * @throws {@link E_XML_PARSE_FAILED} when XML parsing fails.
   */
  async #resolveParsed(): Promise<Record<string, unknown>> {
    if (this.#parsed !== undefined) {
      return this.#parsed
    }

    const parser = await getXmlParser()
    const xmlParser = new parser.XMLParser({
      ignoreAttributes: this.#ignoreAttributes,
      attributeNamePrefix: this.#attributeNamePrefix,
      preserveOrder: false,
    })

    const content = await this.asString()
    try {
      this.#parsed = xmlParser.parse(content) as Record<string, unknown>
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_XML_PARSE_FAILED([detail])
    }
    return this.#parsed
  }

  /**
   * Serialise this SpooledXmlArtifact into an `@nhtio/encoder` snapshot — the reader **handle**
   * plus the constructor options for `attributeNamePrefix` and `ignoreAttributes`.
   *
   * @remarks
   * Overrides {@link SpooledArtifact.[ENCODE_METHOD]} to carry the constructor's options
   * (the parsed projection cache is derived and not encoded). Round-trips via
   * {@link SpooledXmlArtifact.[DECODE_METHOD]}.
   *
   * @returns A snapshot consumed by {@link SpooledXmlArtifact.[DECODE_METHOD]}.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      reader: this.readerDescriptor(),
      attributeNamePrefix: this.#attributeNamePrefix,
      ignoreAttributes: this.#ignoreAttributes,
    }
  }

  /**
   * Reconstruct a {@link SpooledXmlArtifact} from a {@link SpooledXmlArtifact.[ENCODE_METHOD]}
   * snapshot.
   *
   * @param data - The snapshot produced by {@link SpooledXmlArtifact.[ENCODE_METHOD]}.
   * @returns A fresh {@link SpooledXmlArtifact} backed by a freshly-resolved reader.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): SpooledXmlArtifact {
    const snapshot = data as {
      reader: ReaderDescriptor
      attributeNamePrefix?: string
      ignoreAttributes?: boolean
    }
    return new SpooledXmlArtifact(resolveSpoolReader(snapshot.reader), {
      attributeNamePrefix: snapshot.attributeNamePrefix,
      ignoreAttributes: snapshot.ignoreAttributes,
    })
  }
}

/**
 * A tool that converts XML (inline or from an artifact) to JSON.
 *
 * @remarks
 * Input is either `text` (inline XML) or `call_id` (an XML artifact from earlier in this turn).
 * Provide exactly one. Returns a new {@link SpooledJsonArtifact}.
 */
export const xmlToJsonTool = new Tool({
  name: 'xml_to_json',
  description:
    'Convert XML (inline or from an artifact produced earlier in this turn) to JSON. ' +
    'Returns a queryable JSON artifact.',
  inputSchema: validator.object({
    text: validator
      .string()
      .optional()
      .allow('')
      .description('Inline XML text. Provide this or call_id, not both.'),
    call_id: validator
      .string()
      .optional()
      .allow('')
      .description('ToolCall id of an XML artifact produced earlier in this turn.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (rawArgs, ctx) => {
    const args = rawArgs as { text?: string; call_id?: string }
    const text = (args.text ?? '').trim()
    const callId = (args.call_id ?? '').trim()

    // Validate input
    if (!text && !callId) {
      return 'Error: provide either text or call_id, not both or neither'
    }
    if (text && callId) {
      return 'Error: provide either text or call_id, not both'
    }

    let xmlContent: string
    let sourceId: string
    let attributeNamePrefix: string
    let ignoreAttributes: boolean

    if (callId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledXmlArtifact)
      if (!resolved) {
        return `Error: no artifact with id ${callId} in this turn`
      }
      const xmlArtifact = resolved.artifact as SpooledXmlArtifact
      xmlContent = await xmlArtifact.asString()
      sourceId = callId
      // Inherit the source artifact's parser configuration
      const sourceOptions = xmlArtifact.getParserOptions()
      attributeNamePrefix = sourceOptions.attributeNamePrefix
      ignoreAttributes = sourceOptions.ignoreAttributes
    } else {
      xmlContent = text
      sourceId = uuidv6()
      // Use defaults for inline conversions
      attributeNamePrefix = '_'
      ignoreAttributes = false
    }

    // Parse XML to JSON projection
    const parser = await getXmlParser()
    const xmlParser = new parser.XMLParser({
      ignoreAttributes,
      attributeNamePrefix,
      preserveOrder: false,
    })

    let parsed: unknown
    try {
      parsed = xmlParser.parse(xmlContent)
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      return `Error: XML parse failed: ${detail}`
    }

    // Convert to JSON string
    const jsonString = JSON.stringify(parsed)

    // Spool and return
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:xml_to_json:${sourceId}`, jsonString)
    return new SpooledJsonArtifact(reader)
  },
})

/**
 * A tool that converts JSON (inline or from an artifact) to XML.
 *
 * @remarks
 * Input is either `text` (inline JSON) or `call_id` (a JSON artifact from earlier in this turn).
 * Provide exactly one. Returns a new {@link SpooledXmlArtifact}.
 *
 * Note: XML has no faithful JSON inverse. A JSON document that never came from XML may not
 * rebuild into sensible markup. This tool converts on a best-effort basis; the result may not
 * round-trip perfectly back to the original JSON.
 */
export const jsonToXmlTool = new Tool({
  name: 'json_to_xml',
  description:
    'Convert JSON (inline or from an artifact produced earlier in this turn) to XML. ' +
    'Returns a queryable XML artifact. ' +
    'Note: XML has no faithful JSON inverse — a JSON document that never came from XML may not rebuild into sensible markup.',
  inputSchema: validator.object({
    text: validator
      .string()
      .optional()
      .allow('')
      .description('Inline JSON text. Provide this or call_id, not both.'),
    call_id: validator
      .string()
      .optional()
      .allow('')
      .description('ToolCall id of a JSON artifact produced earlier in this turn.'),
  }),
  artifactConstructor: () => SpooledXmlArtifact,
  handler: async (rawArgs, ctx) => {
    const args = rawArgs as { text?: string; call_id?: string }
    const text = (args.text ?? '').trim()
    const callId = (args.call_id ?? '').trim()

    // Validate input
    if (!text && !callId) {
      return 'Error: provide either text or call_id, not both or neither'
    }
    if (text && callId) {
      return 'Error: provide either text or call_id, not both'
    }

    let jsonContent: unknown
    let sourceId: string

    if (callId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledJsonArtifact)
      if (!resolved) {
        return `Error: no artifact with id ${callId} in this turn`
      }
      const jsonString = await resolved.artifact.asString()
      try {
        jsonContent = JSON.parse(jsonString)
      } catch (err) {
        const detail = isError(err) ? err.message : String(err)
        return `Error: JSON parse failed: ${detail}`
      }
      sourceId = callId
    } else {
      try {
        jsonContent = JSON.parse(text)
      } catch (err) {
        const detail = isError(err) ? err.message : String(err)
        return `Error: JSON parse failed: ${detail}`
      }
      sourceId = uuidv6()
    }

    // Convert JSON to XML via builder
    const parser = await getXmlParser()
    const xmlBuilder = new parser.XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '_',
      format: false,
    })

    let xmlString: string
    try {
      xmlString = xmlBuilder.build(jsonContent) as string
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      return `Error: XML build failed: ${detail}`
    }

    // Spool and return
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:json_to_xml:${sourceId}`, xmlString)
    return new SpooledXmlArtifact(reader)
  },
})

/**
 * Re-export the exceptions for battery-scoped error handling.
 *
 * @remarks
 * Battery exceptions are defined in `exceptions.ts` and re-exported here per the
 * battery-scoped-exceptions pattern — consumers of `@nhtio/adk/batteries/artifacts/xml`
 * can import these exception classes directly.
 */
export { E_XML_PARSER_PEER_MISSING, E_XML_PARSE_FAILED } from './exceptions'
