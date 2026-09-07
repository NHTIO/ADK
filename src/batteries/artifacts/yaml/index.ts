/**
 * YAML artifact battery: {@link SpooledYamlArtifact} and bidirectional converters.
 *
 * @remarks
 * Provides structured query tools for YAML documents, both single-document and
 * multi-document streams. Includes converter tools to transform between YAML and JSON
 * representations without materialising the artifact contents.
 *
 * Requires the optional peer `js-yaml@^4.1.1`. Install with:
 * ```
 * pnpm add js-yaml
 * ```
 *
 * Note: `decode()` on `SpooledYamlArtifact` instances throws until
 * `registerArtifactEncodables()` has been called.
 *
 * @module @nhtio/adk/batteries/artifacts/yaml
 */

import { v6 as uuidv6 } from 'uuid'
import { JSONPath } from 'jsonpath-plus'
import { validator } from '@nhtio/validation'
import { resolveSpoolReader } from '@nhtio/adk/common'
import { isInstanceOf, isError, isObject } from '@nhtio/adk/guards'
import { E_YAML_PARSE_ERROR, E_YAML_PEER_MISSING } from './exceptions'
import {
  Tool,
  ArtifactTool,
  ToolRegistry,
  SpooledJsonArtifact,
  ReaderDescriptor,
} from '@nhtio/adk/common'

import {
  collectArtifactCompatibleIds,
  resolveArtifactById,
  defaultSerialise,
  SpooledArtifact,
} from '@nhtio/adk/spooled_artifact'
import type { SpoolReader } from '@nhtio/adk/common'
import type { ToolMethodDescriptor, DispatchContext } from '@nhtio/adk/types'

// Well-known @nhtio/encoder contract keys, resolved through the global symbol registry.
// These are identical to the symbols core uses, with no import edge on the optional peer.
const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')

/** Snapshot payload for the encoder contract; the encoder treats it as opaque. */
type AdkEncodableSnapshot = unknown

/**
 * Lazy-loaded promise for the js-yaml module.
 *
 * @remarks
 * Caches the result to avoid repeated import attempts. If the import fails, the exception
 * is thrown on subsequent access rather than re-importing.
 */
let yamlPromise:
  | Promise<{
      load: (content: string) => unknown
      loadAll: (content: string) => unknown[]
      dump: (data: unknown, options?: Record<string, unknown>) => string
    }>
  | undefined

/**
 * Lazy-loads and caches the js-yaml module.
 *
 * @returns The loaded `js-yaml` module.
 * @throws {@link E_YAML_PEER_MISSING} if the module fails to load.
 */
async function getYaml() {
  yamlPromise ??= import('js-yaml').catch((err) => {
    throw new E_YAML_PEER_MISSING([isError(err) ? err.message : String(err)])
  })
  return yamlPromise
}

/**
 * A {@link SpooledArtifact} specialisation that adds YAML-aware read operations.
 *
 * @remarks
 * Handles both single-document YAML and multi-document streams (delimited by `---`).
 * Parsed documents are cached in a private field for the lifetime of the instance.
 *
 * For multi-document streams:
 * - `yaml_length` reports the document count.
 * - `yaml_keys` returns the deduplicated union of keys across all documents.
 * - `yaml_get` / `yaml_filter` / `yaml_pluck` evaluate paths against all documents and return
 *   a flat array of all matches.
 *
 * Non-finite numbers (`.NaN`, `.inf`, `-.inf`) present in the YAML are preserved through the
 * `yaml_to_json` converter using a custom replacer.
 */
export class SpooledYamlArtifact extends SpooledArtifact {
  #docs: unknown[] | undefined

  /**
   * @param reader - The backing store to read from.
   * @param options - Optional configuration for parsing.
   * @param options.multiDocument - Declares the source's document mode. `true` parses as a
   *   stream and makes {@link SpooledYamlArtifact.yaml_type} report `'multi-document'` regardless
   *   of the current count. `false` asserts exactly one document and parses with `load`, so a
   *   `---` stream raises `E_YAML_PARSE_ERROR` instead of being silently accepted. When omitted,
   *   mode is auto-detected
   *   by parsing the content with `loadAll`.
   */
  constructor(reader: SpoolReader, options?: { multiDocument?: boolean }) {
    super(reader)
    this.#options = options
  }

  #options: { multiDocument?: boolean } | undefined

  /**
   * Returns `true` if `value` is a {@link SpooledYamlArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard. Safe against the
   * dual-module-copy case where two distinct `SpooledYamlArtifact` classes coexist in the
   * same realm.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link SpooledYamlArtifact} instance.
   */
  public static isSpooledYamlArtifact(value: unknown): value is SpooledYamlArtifact {
    return isInstanceOf(value, 'SpooledYamlArtifact', SpooledYamlArtifact)
  }

  /**
   * The YAML-specific artifact-query descriptors this class adds on top of the base set.
   *
   * @remarks
   * Lists `artifact_yaml_type`, `artifact_yaml_keys`, `artifact_yaml_length`,
   * `artifact_yaml_get`, `artifact_yaml_filter`, `artifact_yaml_slice`, `artifact_yaml_pluck`.
   * The base seven descriptors (`artifact_head`, etc.) are NOT included here — they are
   * forged separately by {@link SpooledYamlArtifact.forgeTools}.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_yaml_type',
      method: 'yaml_type',
      description:
        'Return the YAML type (single-document or multi-document) of an artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_yaml_keys',
      method: 'yaml_keys',
      description:
        'Return the top-level keys of a YAML artifact produced earlier in this turn; for multi-document streams, the deduplicated union across all documents.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_yaml_length',
      method: 'yaml_length',
      description:
        'Return the document count of a YAML artifact produced earlier in this turn. The count comes from js-yaml parsing; for sources with no actual YAML content (empty, whitespace, or BOM), the result is typically 0 but may be 1 depending on whitespace arrangement. For real YAML documents or multi-document streams separated by ---, the count is exact.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_yaml_get',
      method: 'yaml_get',
      description:
        'Evaluate a JSONPath expression against a YAML artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$.user.name'."),
      }),
    },
    {
      name: 'artifact_yaml_filter',
      method: 'yaml_filter',
      description:
        'Return records of a YAML artifact (produced earlier in this turn) matched by a JSONPath filter.',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description('JSONPath filter expression, e.g. \'$[?(@.status === "active")]\'.'),
      }),
    },
    {
      name: 'artifact_yaml_slice',
      method: 'yaml_slice',
      description:
        'Return a slice of documents by index range from a YAML artifact produced earlier in this turn.',
      argsSchema: validator.object({
        start: validator
          .number()
          .integer()
          .min(0)
          .optional()
          .description('Start index (inclusive).'),
        end: validator.number().integer().min(0).optional().description('End index (exclusive).'),
      }),
    },
    {
      name: 'artifact_yaml_pluck',
      method: 'yaml_pluck',
      description:
        'Return all values matched by a JSONPath expression across every document of a YAML artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$..name'."),
      }),
    },
  ])

  /**
   * Forges base-class tools plus YAML-specific tools narrowed to {@link SpooledYamlArtifact}.
   *
   * @remarks
   * Standard subclass extension pattern: call `SpooledArtifact.forgeTools(ctx)` to produce
   * the base seven `artifact_*` tools narrowed to any `SpooledArtifact` in the turn, then
   * register one `ArtifactTool` per YAML-specific descriptor narrowed to YAML artifacts.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledYamlArtifact
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
            descriptor.method === 'yaml_get' ||
            descriptor.method === 'yaml_filter' ||
            descriptor.method === 'yaml_pluck'
          ) {
            methodArgs.push(args.path as string)
          } else if (descriptor.method === 'yaml_slice') {
            methodArgs.push(args.start as number | undefined, args.end as number | undefined)
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
   * Parses and caches all documents from the artifact.
   *
   * @remarks
   * Uses `js-yaml.loadAll` to extract all documents from the stream. A single-document source
   * yields a one-element array; a multi-document stream yields one element per document. When
   * the constructor declared `multiDocument: false`, `load` is used instead so that a
   * multi-document source is rejected rather than quietly accepted. The parsed result is cached
   * for the lifetime of the instance.
   */
  async #resolveDocs(): Promise<unknown[]> {
    if (this.#docs !== undefined) {
      return this.#docs
    }

    const yaml = await getYaml()
    const content = await this.asString()
    try {
      if (this.#options?.multiDocument === false) {
        // The caller asserted this source holds exactly one document. `load` enforces that: it
        // throws "expected a single document in the stream, but found more" on a `---` stream,
        // which surfaces below as E_YAML_PARSE_ERROR. Anything weaker would make the option a
        // no-op, which is what it was before.
        this.#docs = [yaml.load(content)]
      } else {
        const loaded = yaml.loadAll(content)
        this.#docs = Array.isArray(loaded) ? loaded : [loaded]
      }
    } catch (err) {
      let detail = isError(err) ? err.message : String(err)
      // Append line and mark information if available for self-correction
      if (isObject(err)) {
        const mark = (err as Record<string, unknown>).mark as Record<string, unknown> | undefined
        if (mark && (mark.line !== undefined || mark.column !== undefined)) {
          const line = typeof mark.line === 'number' ? mark.line + 1 : 0
          const col = typeof mark.column === 'number' ? mark.column + 1 : 0
          detail += ` (line ${line}:${col})`
        }
      }
      throw new E_YAML_PARSE_ERROR([detail])
    }
    return this.#docs
  }

  /**
   * Returns whether this artifact contains a single document or multiple documents.
   *
   * @remarks
   * When the constructor was given `multiDocument: true`, the source is treated as a stream and
   * this reports `'multi-document'` even if that stream currently holds one document — a
   * one-element stream is still a stream, and {@link SpooledYamlArtifact.yaml_length} reports the
   * real count either way. `multiDocument: false` cannot disagree with the count, because parsing
   * a `---` stream under it fails outright rather than silently reporting the wrong mode.
   *
   * @returns `'single-document'` or `'multi-document'`.
   */
  async yaml_type(): Promise<'single-document' | 'multi-document'> {
    const docs = await this.#resolveDocs()
    if (this.#options?.multiDocument === true) {
      return 'multi-document'
    }
    return docs.length > 1 ? 'multi-document' : 'single-document'
  }

  /**
   * Returns the top-level keys of the parsed content.
   *
   * @remarks
   * For single-document: returns the keys of the root object, or `undefined` when the root
   * is not a plain object.
   * For multi-document: returns the union of keys across all documents that are plain objects.
   * Duplicate keys are deduplicated.
   *
   * @returns Array of key strings, or `undefined` when no object keys are present.
   */
  async yaml_keys(): Promise<string[] | undefined> {
    const docs = await this.#resolveDocs()
    const keySet = new Set<string>()

    for (const doc of docs) {
      if (isObject(doc)) {
        for (const key of Object.keys(doc as object)) {
          keySet.add(key)
        }
      }
    }

    return keySet.size > 0 ? Array.from(keySet) : undefined
  }

  /**
   * Returns the total number of documents in the artifact.
   *
   * @remarks
   * The result comes directly from js-yaml.loadAll(). For sources with no actual YAML content
   * (empty, whitespace-only, or BOM-only), the parser typically returns 0 documents, but certain
   * whitespace arrangements (such as a bare double newline) may yield 1. Do not rely on the exact
   * count to test for emptiness. For real documents, the count is reliable: a single-document
   * YAML returns 1, and a `---`-separated stream returns its exact document count.
   *
   * @returns The document count.
   */
  async yaml_length(): Promise<number> {
    const docs = await this.#resolveDocs()
    return docs.length
  }

  /**
   * Evaluates a JSONPath expression against the parsed documents.
   *
   * @remarks
   * For single-document: evaluates the expression against the root value.
   * For multi-document: evaluates the expression against each document and returns a flat
   * array of all matches across all documents.
   *
   * Uses [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath). Full JSONPath syntax is
   * supported.
   *
   * @param path - A JSONPath expression (e.g. `'$.user.address.city'`, `'$..name'`).
   * @returns Array of matched values. Empty array when no matches are found.
   */
  async yaml_get(path: string): Promise<unknown[]> {
    const docs = await this.#resolveDocs()
    return docs.flatMap((doc) => JSONPath({ path, json: doc as object }))
  }

  /**
   * Returns documents matched by a JSONPath filter expression.
   *
   * @remarks
   * Evaluates `path` against each document and returns those for which the expression
   * produces at least one match.
   *
   * @param path - A JSONPath expression (e.g. `'$[?(@.status === "active")]'`).
   * @returns Array of matching documents.
   */
  async yaml_filter(path: string): Promise<unknown[]> {
    const docs = await this.#resolveDocs()
    return docs.filter((doc) => {
      const matches = JSONPath({ path, json: doc as object })
      return Array.isArray(matches) && matches.length > 0
    })
  }

  /**
   * Returns a slice of documents by index range.
   *
   * @remarks
   * Behaves like `Array.prototype.slice` over the document array.
   *
   * @param start - Start index (inclusive). Defaults to `0`.
   * @param end - End index (exclusive). Defaults to the document count.
   * @returns Array of sliced documents.
   */
  async yaml_slice(start?: number, end?: number): Promise<unknown[]> {
    const docs = await this.#resolveDocs()
    return docs.slice(start, end)
  }

  /**
   * Returns all values matched by a JSONPath expression across every document.
   *
   * @remarks
   * Convenience over {@link yaml_get} with an identical signature — use whichever name
   * better communicates intent at the call site.
   *
   * @param path - A JSONPath expression (e.g. `'$..name'`).
   * @returns Array of matched values.
   */
  async yaml_pluck(path: string): Promise<unknown[]> {
    return this.yaml_get(path)
  }

  /**
   * Serialise this SpooledYamlArtifact into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * Overrides {@link SpooledArtifact.[ENCODE_METHOD]} to carry the constructor's `multiDocument`
   * option. The parsed-document cache is derived and not encoded. Round-trips via
   * {@link SpooledYamlArtifact.[DECODE_METHOD]}.
   *
   * @returns A snapshot consumed by {@link SpooledYamlArtifact.[DECODE_METHOD]}.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return { reader: this.readerDescriptor(), multiDocument: this.#options?.multiDocument }
  }

  /**
   * Reconstruct a {@link SpooledYamlArtifact} from a {@link SpooledYamlArtifact.[ENCODE_METHOD]}
   * snapshot.
   *
   * @param data - The snapshot produced by {@link SpooledYamlArtifact.[ENCODE_METHOD]}.
   * @returns A fresh {@link SpooledYamlArtifact}} backed by a freshly-resolved reader.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): SpooledYamlArtifact {
    const snapshot = data as {
      reader: ReaderDescriptor
      multiDocument?: boolean
    }
    return new SpooledYamlArtifact(resolveSpoolReader(snapshot.reader), {
      multiDocument: snapshot.multiDocument,
    })
  }
}

/**
 * Replacer for {@link JSON.stringify} that preserves non-finite numbers as YAML tokens.
 *
 * @remarks
 * YAML permits `.NaN`, `.inf`, and `-.inf`. {@link JSON.stringify} silently converts these
 * to `null`, losing the original value. This replacer renders non-finite numbers as their
 * YAML string representations so the information survives the JSON round-trip.
 *
 * @internal
 */
function nonFiniteReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? '.NaN' : value > 0 ? '.inf' : '-.inf'
  }
  return value
}

/**
 * Converter tool: YAML → JSON.
 *
 * @remarks
 * Takes either inline YAML text or a reference to a {@link SpooledYamlArtifact} produced
 * earlier in the turn. Converts to JSON and returns a fresh {@link SpooledJsonArtifact}
 * immediately queryable with JSON artifact tools.
 *
 * Non-finite numbers are preserved as their YAML token strings (`.NaN`, `.inf`, `-.inf`).
 * Undefined values are normalised to the JSON string `'null'`.
 */
export const yamlToJsonTool = new Tool({
  name: 'yaml_to_json',
  description:
    'Convert a YAML document to JSON format. Returns a JSON artifact. Provide inline YAML text or a tool call id of a YAML artifact produced earlier in this turn — not both.',
  inputSchema: validator.object({
    text: validator
      .string()
      .optional()
      .allow('')
      .description('Inline YAML text. Provide this or call_id, not both.'),
    call_id: validator
      .string()
      .optional()
      .allow('')
      .description('ToolCall id of a YAML artifact produced earlier in this turn.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args, ctx) => {
    const { text = '', call_id: callId = '' } = args as { text?: string; call_id?: string }
    const hasText = text.trim().length > 0
    const hasCallId = callId.trim().length > 0

    if ((!hasText && !hasCallId) || (hasText && hasCallId)) {
      return 'Error: provide either text or call_id, not both or neither'
    }

    let sourceDoc: unknown
    let sourceId: string

    if (hasCallId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledYamlArtifact)
      if (!resolved) {
        return `Error: no YAML artifact with id ${callId} in this turn`
      }
      const yaml = await getYaml()
      try {
        const yamlText = await resolved.artifact.asString()
        const loaded = yaml.loadAll(yamlText)
        sourceDoc = Array.isArray(loaded) ? (loaded.length === 1 ? loaded[0] : loaded) : loaded
        sourceId = callId
      } catch (err) {
        let detail = isError(err) ? err.message : String(err)
        if (isObject(err)) {
          const mark = (err as Record<string, unknown>).mark as Record<string, unknown> | undefined
          if (mark && (mark.line !== undefined || mark.column !== undefined)) {
            const line = typeof mark.line === 'number' ? mark.line + 1 : 0
            const col = typeof mark.column === 'number' ? mark.column + 1 : 0
            detail += ` (line ${line}:${col})`
          }
        }
        return `Error: Invalid YAML — ${detail}`
      }
    } else {
      const yaml = await getYaml()
      try {
        const loaded = yaml.loadAll(text)
        sourceDoc = Array.isArray(loaded) ? (loaded.length === 1 ? loaded[0] : loaded) : loaded
        sourceId = uuidv6()
      } catch (err) {
        let detail = isError(err) ? err.message : String(err)
        if (isObject(err)) {
          const mark = (err as Record<string, unknown>).mark as Record<string, unknown> | undefined
          if (mark && (mark.line !== undefined || mark.column !== undefined)) {
            const line = typeof mark.line === 'number' ? mark.line + 1 : 0
            const col = typeof mark.column === 'number' ? mark.column + 1 : 0
            detail += ` (line ${line}:${col})`
          }
        }
        return `Error: Invalid YAML — ${detail}`
      }
    }

    // Normalise undefined to 'null' string
    const jsonStr =
      sourceDoc === undefined ? 'null' : JSON.stringify(sourceDoc, nonFiniteReplacer, 2)
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:yaml_to_json:${sourceId}`, jsonStr)
    return new SpooledJsonArtifact(reader)
  },
})

/**
 * Converter tool: JSON → YAML.
 *
 * @remarks
 * Takes either inline JSON text or a reference to a {@link SpooledJsonArtifact} produced
 * earlier in the turn. Converts to YAML and returns a fresh {@link SpooledYamlArtifact}}
 * immediately queryable with YAML artifact tools.
 */
export const jsonToYamlTool = new Tool({
  name: 'json_to_yaml',
  description:
    'Convert a JSON document to YAML format. Returns a YAML artifact. Provide inline JSON text or a tool call id of a JSON artifact produced earlier in this turn — not both.',
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
  artifactConstructor: () => SpooledYamlArtifact,
  handler: async (args, ctx) => {
    const { text = '', call_id: callId = '' } = args as { text?: string; call_id?: string }
    const hasText = text.trim().length > 0
    const hasCallId = callId.trim().length > 0

    if ((!hasText && !hasCallId) || (hasText && hasCallId)) {
      return 'Error: provide either text or call_id, not both or neither'
    }

    let sourceData: unknown
    let sourceId: string

    if (hasCallId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledJsonArtifact)
      if (!resolved) {
        return `Error: no JSON artifact with id ${callId} in this turn`
      }
      try {
        const jsonText = await resolved.artifact.asString()
        sourceData = JSON.parse(jsonText)
        sourceId = callId
      } catch (err) {
        return `Error: Invalid JSON — ${isError(err) ? err.message : String(err)}`
      }
    } else {
      try {
        sourceData = JSON.parse(text)
        sourceId = uuidv6()
      } catch (err) {
        return `Error: Invalid JSON — ${isError(err) ? err.message : String(err)}`
      }
    }

    const yaml = await getYaml()
    const yamlStr = yaml.dump(sourceData, { indent: 2 })
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:json_to_yaml:${sourceId}`, yamlStr)
    return new SpooledYamlArtifact(reader)
  },
})

// Re-export exceptions
export { E_YAML_PARSE_ERROR, E_YAML_PEER_MISSING }
