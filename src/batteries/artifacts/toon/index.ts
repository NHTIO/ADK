/**
 * TOON artifact battery — structured queries over TOON format artifacts.
 *
 * @module @nhtio/adk/batteries/artifacts/toon
 *
 * @remarks
 * Adds {@link SpooledToonArtifact}, a {@link @nhtio/adk!SpooledArtifact} specialisation for
 * structured TOON queries. TOON encodes the JSON data model in a compact text format; parsing
 * produces the same values as decoding JSON, so queries use {@link https://github.com/JSONPath-Plus/JSONPath JSONPath-Plus} for path navigation, exactly as {@link @nhtio/adk!SpooledJsonArtifact} does.
 *
 * Requires the optional peer `@toon-format/toon` (version `^4.1.1`). If it is not installed,
 * methods requiring it throw {@link E_TOON_PEER_MISSING} with installation instructions.
 *
 * Export note: {@link registerArtifactEncodables} must be called before any attempt to
 * `decode()` a spooled TOON artifact. Call it once at startup:
 *
 * ```ts
 * import { registerArtifactEncodables } from '@nhtio/adk/batteries/artifacts'
 * await registerArtifactEncodables()
 * ```
 */

import { v6 as uuidv6 } from 'uuid'
import { JSONPath } from 'jsonpath-plus'
import { validator } from '@nhtio/validation'
import { resolveSpoolReader } from '@nhtio/adk/common'
import { isInstanceOf, isObject } from '@nhtio/adk/guards'
import { E_TOON_PEER_MISSING, E_TOON_DECODE_FAILED } from './exceptions'
import {
  ArtifactTool,
  SpooledJsonArtifact,
  Tool,
  ToolRegistry,
  ReaderDescriptor,
} from '@nhtio/adk/common'

// Well-known @nhtio/encoder contract keys, resolved through the global symbol registry.
// These are identical to the symbols core uses, with no import edge on the optional peer.
const ENCODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:toEncoded')
const DECODE_METHOD: unique symbol = Symbol.for('@nhtio/encoder:fromEncoded')

/**
 * Lazily-loaded TOON module, cached as a module-level promise.
 *
 * @remarks
 * Shared across all instances of SpooledToonArtifact. Once the promise resolves or rejects,
 * the same promise is reused for all subsequent calls, ensuring the in-flight promise and
 * any error state are preserved globally.
 */
let toonModulePromise: Promise<Record<string, unknown>> | undefined
import {
  SpooledArtifact,
  collectArtifactCompatibleIds,
  resolveArtifactById,
  defaultSerialise,
} from '@nhtio/adk/spooled_artifact'
import type { SpoolReader, ToolMethodDescriptor, DispatchContext } from '@nhtio/adk/types'

/** Snapshot payload for the encoder contract; the encoder treats it as opaque. */
type AdkEncodableSnapshot = unknown

/**
 * TOON decode options.
 *
 * @remarks
 * Passed to the `@toon-format/toon` `decode` function.
 */
export interface ToonDecodeOptions {
  /** The indent size used in the TOON encoding (default: 2). */
  indentSize?: number
  /** When `true`, reject non-standard TOON (default: `true`). */
  strict?: boolean
}

/**
 * A {@link @nhtio/adk!SpooledArtifact} specialisation that adds TOON-aware read operations.
 *
 * @remarks
 * Construct with an optional `options` object to control decoding. When omitted, the TOON is
 * decoded with `strict: true` (default). Once decoded (on first access), the parsed value is
 * cached for the lifetime of the instance.
 *
 * All TOON methods are async, consistent with {@link @nhtio/adk!SpooledArtifact}.
 *
 * Path-based methods (`toon_get`, `toon_filter`, `toon_pluck`) use
 * [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath) expressions. Full JSONPath syntax
 * is supported, including recursive descent (`..`), filter expressions (`[?(@.age > 18)]`),
 * and union selectors.
 */
export class SpooledToonArtifact extends SpooledArtifact {
  #parsed: unknown
  #hasParsed: boolean = false
  #options: ToonDecodeOptions | undefined

  /**
   * @param reader - The backing store to read from.
   * @param options - Optional TOON decode options.
   */
  constructor(reader: SpoolReader, options?: ToonDecodeOptions) {
    super(reader)
    this.#options = options
  }

  /**
   * Returns `true` if `value` is a {@link SpooledToonArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard: `instanceof` first, then
   * `Symbol.hasInstance`, then a `constructor.name` fallback. Matches the pattern used by every
   * other class guard in the ADK; safe against the dual-module-copy case where two distinct
   * `SpooledToonArtifact` classes coexist in the same realm.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link SpooledToonArtifact} instance.
   */
  public static isSpooledToonArtifact(value: unknown): value is SpooledToonArtifact {
    return isInstanceOf(value, 'SpooledToonArtifact', SpooledToonArtifact)
  }

  /**
   * The TOON-specific artifact-query descriptors this class adds on top of the base set.
   *
   * @remarks
   * Lists `artifact_toon_type`, `artifact_toon_keys`, `artifact_toon_length`,
   * `artifact_toon_get`, `artifact_toon_filter`, `artifact_toon_slice`, `artifact_toon_pluck`.
   * The base seven descriptors (`artifact_head`, etc.) are NOT included here — they are
   * forged separately by {@link SpooledToonArtifact.forgeTools}, which calls
   * `SpooledArtifact.forgeTools(ctx)` to produce the base-narrowed tools and then registers
   * its own TOON tools on the result. Downstream consumers building custom subclasses
   * should follow the same pattern: own only your own descriptors; override `forgeTools` to
   * compose with the base output.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_toon_type',
      method: 'toon_type',
      description: 'Return the format of a TOON artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_toon_keys',
      method: 'toon_keys',
      description: 'Return the top-level keys of a TOON artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_toon_length',
      method: 'toon_length',
      description:
        'Return the element count of a TOON artifact produced earlier in this turn (1 if the root is not an array).',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_toon_get',
      method: 'toon_get',
      description:
        'Evaluate a JSONPath expression against a TOON artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$.user.name'."),
      }),
    },
    {
      name: 'artifact_toon_filter',
      method: 'toon_filter',
      description:
        'Return elements of a TOON artifact (produced earlier in this turn) matched by a JSONPath filter.',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description("JSONPath filter expression, e.g. '$[?(@.age>18)]'."),
      }),
    },
    {
      name: 'artifact_toon_slice',
      method: 'toon_slice',
      description:
        'Return a slice of elements by index range from a TOON artifact produced earlier in this turn.',
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
      name: 'artifact_toon_pluck',
      method: 'toon_pluck',
      description:
        'Return all values matched by a JSONPath expression across a TOON artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$..name'."),
      }),
    },
  ])

  /**
   * Forges base-class tools plus TOON-specific tools narrowed to {@link SpooledToonArtifact}.
   *
   * @remarks
   * Standard subclass extension pattern: call `SpooledArtifact.forgeTools(ctx)` to produce
   * the base seven `artifact_*` tools narrowed to any `SpooledArtifact` in the turn, then
   * register one `ArtifactTool` per TOON-specific descriptor narrowed to TOON artifacts.
   * Downstream consumers building their own subclasses should follow the same shape.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledToonArtifact
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
            descriptor.method === 'toon_get' ||
            descriptor.method === 'toon_filter' ||
            descriptor.method === 'toon_pluck'
          ) {
            methodArgs.push(args.path as string)
          } else if (descriptor.method === 'toon_slice') {
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
   * Parses and caches the TOON content.
   *
   * @remarks
   * On first access, decodes the TOON source and caches the parsed value. Subsequent calls
   * return the cached value without re-parsing.
   *
   * @returns The parsed TOON value.
   */
  async #resolveParsed(): Promise<unknown> {
    if (this.#hasParsed) {
      return this.#parsed
    }
    const toonModule = await this.#loadToonModule()
    const text = await this.asString()
    try {
      const decode = toonModule.decode as (text: string, opts: Record<string, unknown>) => unknown
      this.#parsed = decode(text, {
        indentSize: this.#options?.indentSize ?? 2,
        strict: this.#options?.strict ?? true,
      })
    } catch (err) {
      const message = this.#formatToonError(err)
      throw new E_TOON_DECODE_FAILED([message])
    }
    this.#hasParsed = true
    return this.#parsed
  }

  /**
   * Formats an error from the TOON decoder, including line number and source.
   */
  #formatToonError(err: unknown): string {
    if (isObject(err) && (err as Record<string, unknown>).name === 'ToonDecodeError') {
      const toonErr = err as { line?: number; source?: string; message?: string }
      const line = toonErr.line ?? '?'
      const source = toonErr.source ?? '(no source)'
      return `line ${line}: ${source}`
    }
    return String((err as Record<string, unknown>).message ?? err)
  }

  /**
   * Loads the TOON module lazily, with error handling.
   *
   * @remarks
   * Uses the module-level `toonModulePromise` to ensure the in-flight promise and error state
   * are shared across all instances of SpooledToonArtifact.
   */
  async #loadToonModule() {
    toonModulePromise ??= import('@toon-format/toon').catch((err: unknown) => {
      throw new E_TOON_PEER_MISSING([String(err)])
    })
    return (await toonModulePromise) as Record<string, unknown>
  }

  /**
   * Returns the format of a TOON artifact.
   *
   * @remarks
   * Reports only the format name. The delimiter is deliberately not reported: the TOON decoder
   * exposes no delimiter information, and every method of inferring one from the source proved
   * unreliable for some class of strict-valid document. Four distinct approaches were attempted,
   * each defeated by its own edge case:
   * - Lexical scanning for the delimiter character failed on unquoted pipes inside values
   * - Anchored header regex requiring a word key failed on quoted keys and keyless root arrays
   * - Widened regex accepting quoted keys failed on escaped quotes within the key (e.g., "a\"b")
   * - Byte-exact round-trip re-encoding failed on non-canonical formatting (indentation, line
   *   endings, trailing newlines)
   *
   * Delimiter inference is no longer attempted: nothing in the model's workflow needs it, and
   * the TOON decoder is the source of truth for all document metadata.
   *
   * This result is cached after the first parse and returned identically on every call.
   *
   * @returns An object with `format: 'toon'`.
   */
  async toon_type(): Promise<{ format: string }> {
    await this.#resolveParsed()
    return { format: 'toon' }
  }

  /**
   * Returns the top-level keys of the parsed TOON content.
   *
   * @remarks
   * - If the root is an object, returns its keys.
   * - If the root is not a plain object (e.g. an array or scalar), returns `undefined`.
   *
   * @returns Array of key strings, or `undefined` when the root is not an object.
   */
  async toon_keys(): Promise<string[] | undefined> {
    const value = await this.#resolveParsed()
    if (isObject(value)) {
      return Object.keys(value as object)
    }
    return undefined
  }

  /**
   * Returns the element count of the parsed TOON content.
   *
   * @remarks
   * - If the root is an array, returns the array length.
   * - Otherwise, returns `1` (the root is a single element).
   *
   * @returns The element count.
   */
  async toon_length(): Promise<number> {
    const value = await this.#resolveParsed()
    if (Array.isArray(value)) {
      return value.length
    }
    return 1
  }

  /**
   * Evaluates a JSONPath expression against the parsed TOON content.
   *
   * @remarks
   * Uses [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath). Full JSONPath syntax is
   * supported: recursive descent (`$..*`), filter expressions (`$[?(@.age > 18)]`), union
   * selectors, and more.
   *
   * @param path - A JSONPath expression (e.g. `'$.user.address.city'`, `'$..name'`).
   * @returns Array of matched values. Empty array when no matches are found.
   */
  async toon_get(path: string): Promise<unknown[]> {
    const value = await this.#resolveParsed()
    return JSONPath({ path, json: value as object })
  }

  /**
   * Returns elements matched by a JSONPath filter expression.
   *
   * @remarks
   * Evaluates `path` against the root value and returns it in an array if matched.
   *
   * @param path - A JSONPath expression (e.g. `'$[?(@.status === "active")]'`).
   * @returns Array of matching elements (at most one element, the root if matched).
   */
  async toon_filter(path: string): Promise<unknown[]> {
    const value = await this.#resolveParsed()
    const matches = JSONPath({ path, json: value as object })
    return Array.isArray(matches) && matches.length > 0 ? [value] : []
  }

  /**
   * Returns a slice of the parsed content by index range.
   *
   * @remarks
   * - If the root is an array, behaves like `Array.prototype.slice`.
   * - If the root is not an array, returns the entire root in an array.
   *
   * @param start - Start index (inclusive). Defaults to `0`.
   * @param end - End index (exclusive). Defaults to the element count.
   * @returns Array of sliced elements.
   */
  async toon_slice(start?: number, end?: number): Promise<unknown[]> {
    const value = await this.#resolveParsed()
    if (Array.isArray(value)) {
      return value.slice(start, end)
    }
    return [value]
  }

  /**
   * Returns all values matched by a JSONPath expression.
   *
   * @remarks
   * Convenience over {@link SpooledToonArtifact.toon_get} with an identical signature — use
   * whichever name better communicates intent at the call site. `toon_pluck` reads well for
   * extracting a single field; `toon_get` reads well for structured queries.
   *
   * @param path - A JSONPath expression (e.g. `'$..name'`).
   * @returns Array of matched values.
   */
  async toon_pluck(path: string): Promise<unknown[]> {
    return this.toon_get(path)
  }

  /**
   * Serialise this SpooledToonArtifact into an `@nhtio/encoder` snapshot — the reader **handle** plus
   * the decode `options`.
   *
   * @remarks
   * Overrides {@link SpooledArtifact.[ENCODE_METHOD]} to carry the constructor's `options` (the
   * parsed-value cache is derived and not encoded). Round-trips via
   * {@link SpooledToonArtifact.[DECODE_METHOD]}.
   *
   * @returns A snapshot consumed by {@link SpooledToonArtifact.[DECODE_METHOD]}.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return { reader: this.readerDescriptor(), options: this.#options }
  }

  /**
   * Reconstruct a {@link SpooledToonArtifact} from a {@link SpooledToonArtifact.[ENCODE_METHOD]}
   * snapshot.
   *
   * @param data - The snapshot produced by {@link SpooledToonArtifact.[ENCODE_METHOD]}.
   * @returns A fresh {@link SpooledToonArtifact}} backed by a freshly-resolved reader.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): SpooledToonArtifact {
    const snapshot = data as {
      reader: ReaderDescriptor
      options?: ToonDecodeOptions
    }
    return new SpooledToonArtifact(resolveSpoolReader(snapshot.reader), snapshot.options)
  }
}

/**
 * Converter tool: TOON to JSON.
 *
 * @remarks
 * Accepts either inline TOON text or a reference to an artifact produced earlier in this turn.
 * Converts to JSON and returns a new {@link @nhtio/adk!SpooledJsonArtifact}.
 *
 * This is a plain {@link @nhtio/adk!Tool}, not an {@link @nhtio/adk!ArtifactTool} — the handler
 * returns the new artifact directly, allowing the forge to discover and query it on the next
 * iteration without explicit wiring.
 */
export const toonToJsonTool: Tool = new Tool({
  name: 'toon_to_json',
  description: 'Convert inline TOON text or a TOON artifact to JSON.',
  inputSchema: validator.object({
    text: validator
      .string()
      .optional()
      .allow('')
      .description('Inline TOON text. Provide this or call_id, not both.'),
    call_id: validator
      .string()
      .optional()
      .allow('')
      .description('ToolCall id of a TOON artifact produced earlier in this turn.'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (rawArgs: unknown, ctx: DispatchContext) => {
    const args = rawArgs as { text?: string; call_id?: string }
    const text = args.text ?? ''
    const callId = args.call_id ?? ''

    const hasText = text.length > 0
    const hasCallId = callId.length > 0

    if (!hasText && !hasCallId) {
      return 'Error: provide either text or call_id, not neither'
    }
    if (hasText && hasCallId) {
      return 'Error: provide either text or call_id, not both'
    }

    let toonContent: string
    if (hasCallId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledToonArtifact)
      if (!resolved) {
        return `Error: no TOON artifact with id ${callId} in this turn`
      }
      toonContent = await resolved.artifact.asString()
    } else {
      toonContent = text
    }

    const toonModule = await import('@toon-format/toon').catch((err: unknown) => {
      throw new E_TOON_PEER_MISSING([String(err)])
    })

    let parsed: unknown
    try {
      const decode = toonModule.decode as (text: string, opts: Record<string, unknown>) => unknown
      parsed = decode(toonContent, { indentSize: 2, strict: true })
    } catch (err) {
      const message =
        isObject(err) && (err as Record<string, unknown>).name === 'ToonDecodeError'
          ? `line ${(err as { line?: number }).line ?? '?'}: ${(err as { source?: string }).source ?? '(no source)'}`
          : String((err as Record<string, unknown>).message ?? err)
      return `Error: failed to decode TOON: ${message}`
    }

    const json = JSON.stringify(parsed, null, 2)
    const sourceId = hasCallId ? callId : uuidv6()
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:toon_to_json:${sourceId}`, json)
    return new SpooledJsonArtifact(reader)
  },
})

/**
 * Converter tool: JSON to TOON.
 *
 * @remarks
 * Accepts either inline JSON text or a reference to a JSON artifact produced earlier in this turn.
 * Converts to TOON and returns a new {@link SpooledToonArtifact}.
 *
 * This is a plain {@link @nhtio/adk!Tool}, not an {@link @nhtio/adk!ArtifactTool} — the handler
 * returns the new artifact directly, allowing the forge to discover and query it on the next
 * iteration without explicit wiring.
 */
export const jsonToToonTool: Tool = new Tool({
  name: 'json_to_toon',
  description: 'Convert inline JSON text or a JSON artifact to TOON.',
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
  artifactConstructor: () => SpooledToonArtifact,
  handler: async (rawArgs: unknown, ctx: DispatchContext) => {
    const args = rawArgs as { text?: string; call_id?: string }
    const text = args.text ?? ''
    const callId = args.call_id ?? ''

    const hasText = text.length > 0
    const hasCallId = callId.length > 0

    if (!hasText && !hasCallId) {
      return 'Error: provide either text or call_id, not neither'
    }
    if (hasText && hasCallId) {
      return 'Error: provide either text or call_id, not both'
    }

    let jsonContent: string
    if (hasCallId) {
      const resolved = resolveArtifactById(ctx, callId, SpooledJsonArtifact)
      if (!resolved) {
        return `Error: no JSON artifact with id ${callId} in this turn`
      }
      jsonContent = await resolved.artifact.asString()
    } else {
      jsonContent = text
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonContent)
    } catch (err) {
      return `Error: failed to parse JSON: ${String((err as Record<string, unknown>).message ?? err)}`
    }

    const toonModule = await import('@toon-format/toon').catch((err: unknown) => {
      throw new E_TOON_PEER_MISSING([String(err)])
    })

    let toon: string
    try {
      const encode = toonModule.encode as (val: unknown, opts: Record<string, unknown>) => string
      toon = encode(parsed, { indentSize: 2 })
    } catch (err) {
      return `Error: failed to encode TOON: ${String((err as Record<string, unknown>).message ?? err)}`
    }

    const sourceId = hasCallId ? callId : uuidv6()
    const reader = await ctx.storeRetrievableBytes(`${ctx.id}:json_to_toon:${sourceId}`, toon)
    return new SpooledToonArtifact(reader)
  },
})

/**
 * Exports for the public barrel.
 */
export { E_TOON_PEER_MISSING, E_TOON_DECODE_FAILED } from './exceptions'
