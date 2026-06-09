import { default as JSON5 } from 'json5'
import { JSONPath } from 'jsonpath-plus'
import { validator } from '@nhtio/validation'
import { ArtifactTool } from './artifact_tool'
import { ToolRegistry } from './tool_registry'
import { isInstanceOf, isObject } from '../utils/guards'
import { SpooledArtifact, defaultSerialise } from './spooled_artifact'
import type { SpoolReader } from '../contracts/spool_reader'
import type { ToolMethodDescriptor } from './spooled_artifact'
import type { DispatchContext } from '../contracts/dispatch_context'

/**
 * The set of JSON-derived formats that {@link SpooledJsonArtifact} can handle.
 *
 * @remarks
 * - `json` — a single JSON value spanning the entire artifact (strict RFC 8259).
 * - `json5` — a single JSON5 value spanning the entire artifact; permits comments, trailing
 *   commas, unquoted keys, and other relaxed syntax via the `json5` package.
 * - `jsonl` — newline-delimited JSON; each non-empty line is an independent JSON value.
 * - `ndjson` — alias for `jsonl`; both names are accepted and behave identically.
 */
export type JsonArtifactFormat = 'json' | 'json5' | 'jsonl' | 'ndjson'

/**
 * Detects the {@link JsonArtifactFormat} of a raw string.
 *
 * @remarks
 * Detection strategy (in order):
 * 1. If the content parses as strict JSON → `json`.
 * 2. If every non-empty line parses as strict JSON → `jsonl`.
 * 3. If the content parses as JSON5 → `json5`.
 * 4. Otherwise throws.
 *
 * Strict JSON is tried before JSON5 so that well-formed JSON files are not unnecessarily
 * classified as JSON5.
 *
 * @param content - The full artifact text to inspect.
 * @returns The inferred format.
 * @throws `Error` when the content cannot be classified as any supported JSON format.
 */
function inferFormat(content: string): JsonArtifactFormat {
  const trimmed = content.trim()

  // 1. Try strict JSON
  try {
    JSON.parse(trimmed)
    return 'json'
  } catch {
    // fall through
  }

  // 2. Try JSONL (every non-empty line is valid JSON)
  const nonEmptyLines = trimmed.split('\n').filter((l) => l.trim().length > 0)
  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })
  ) {
    return 'jsonl'
  }

  // 3. Try JSON5
  try {
    JSON5.parse(trimmed)
    return 'json5'
  } catch {
    // fall through
  }

  throw new Error('Unable to infer JSON format: content is not valid JSON, JSONL, NDJSON, or JSON5')
}

/**
 * A {@link @nhtio/adk!SpooledArtifact} specialisation that adds JSON-aware read operations.
 *
 * @typeParam T - The expected shape of each parsed record. Defaults to `unknown`.
 *
 * @remarks
 * Construct with an optional `format` hint. When omitted the format is auto-detected on first
 * access by reading the full artifact and inferring the format. Once detected (or
 * provided), the format is cached for the lifetime of the instance.
 *
 * All JSON methods are async, consistent with {@link @nhtio/adk!SpooledArtifact}.
 *
 * Path-based methods (`json_get`, `json_filter`, `json_pluck`) use
 * [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath) expressions. Full JSONPath syntax
 * is supported, including recursive descent (`..`), filter expressions (`[?(@.age > 18)]`),
 * and union selectors.
 */
export class SpooledJsonArtifact<T = unknown> extends SpooledArtifact {
  #format: JsonArtifactFormat | undefined
  #parsed: T[] | undefined

  /**
   * @param reader - The backing store to read from.
   * @param format - Optional format hint. When omitted, the format is inferred on first access.
   */
  constructor(reader: SpoolReader, format?: JsonArtifactFormat) {
    super(reader)
    this.#format = format
  }

  /**
   * Returns `true` if `value` is a {@link SpooledJsonArtifact} instance.
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard: `instanceof` first, then
   * `Symbol.hasInstance`, then a `constructor.name` fallback. Matches the pattern used by every
   * other class guard in the ADK; safe against the dual-module-copy case where two distinct
   * `SpooledJsonArtifact` classes coexist in the same realm.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link SpooledJsonArtifact} instance.
   */
  public static isSpooledJsonArtifact(value: unknown): value is SpooledJsonArtifact {
    return isInstanceOf(value, 'SpooledJsonArtifact', SpooledJsonArtifact)
  }

  /**
   * The JSON-specific artifact-query descriptors this class adds on top of the base set.
   *
   * @remarks
   * Lists `artifact_json_type`, `artifact_json_keys`, `artifact_json_length`,
   * `artifact_json_get`, `artifact_json_filter`, `artifact_json_slice`, `artifact_json_pluck`.
   * The base seven descriptors (`artifact_head`, etc.) are NOT included here — they are
   * forged separately by {@link SpooledJsonArtifact.forgeTools}, which calls
   * `SpooledArtifact.forgeTools(ctx)` to produce the base-narrowed tools and then registers
   * its own JSON tools on the result. Downstream consumers building custom subclasses
   * should follow the same pattern: own only your own descriptors; override `forgeTools` to
   * compose with the base output.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
    {
      name: 'artifact_json_type',
      method: 'json_type',
      description:
        'Return the JSON format (json | json5 | jsonl | ndjson) of a JSON artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_json_keys',
      method: 'json_keys',
      description: 'Return the top-level keys of a JSON artifact produced earlier in this turn.',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_json_length',
      method: 'json_length',
      description:
        'Return the record count of a JSON artifact produced earlier in this turn (1 for json/json5; line count for jsonl/ndjson).',
      argsSchema: validator.object({}),
    },
    {
      name: 'artifact_json_get',
      method: 'json_get',
      description:
        'Evaluate a JSONPath expression against a JSON artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$.user.name'."),
      }),
    },
    {
      name: 'artifact_json_filter',
      method: 'json_filter',
      description:
        'Return records of a JSON artifact (produced earlier in this turn) matched by a JSONPath filter.',
      argsSchema: validator.object({
        path: validator
          .string()
          .required()
          .description("JSONPath filter expression, e.g. '$[?(@.age>18)]'."),
      }),
    },
    {
      name: 'artifact_json_slice',
      method: 'json_slice',
      description:
        'Return a slice of records by index range from a JSON artifact produced earlier in this turn.',
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
      name: 'artifact_json_pluck',
      method: 'json_pluck',
      description:
        'Return all values matched by a JSONPath expression across every record of a JSON artifact produced earlier in this turn.',
      argsSchema: validator.object({
        path: validator.string().required().description("JSONPath expression, e.g. '$..name'."),
      }),
    },
  ])

  /**
   * Forges base-class tools plus JSON-specific tools narrowed to {@link SpooledJsonArtifact}.
   *
   * @remarks
   * Standard subclass extension pattern: call `SpooledArtifact.forgeTools(ctx)` to produce
   * the base seven `artifact_*` tools narrowed to any `SpooledArtifact` in the turn, then
   * register one `ArtifactTool` per JSON-specific descriptor narrowed to JSON artifacts.
   * Downstream consumers building their own subclasses should follow the same shape.
   */
  public static override forgeTools(ctx: DispatchContext): ToolRegistry {
    const registry = SpooledArtifact.forgeTools(ctx)
    const requires = SpooledJsonArtifact
    const compatibleIds = [...ctx.turnToolCalls]
      .filter((tc) => !tc.fromArtifactTool && isInstanceOf(tc.results, requires.name, requires))
      .map((tc) => tc.id)
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
          const tc = [...ctxInner.turnToolCalls].find((t) => t.id === args.callId)
          if (!tc) {
            return `Error: no tool call with id ${args.callId} in this turn`
          }
          const artifact = tc.results
          if (!isInstanceOf(artifact, requires.name, requires)) {
            return `Error: tool call ${args.callId} results are not a ${requires.name} instance`
          }
          const methodArgs: unknown[] = []
          if (
            descriptor.method === 'json_get' ||
            descriptor.method === 'json_filter' ||
            descriptor.method === 'json_pluck'
          ) {
            methodArgs.push(args.path as string)
          } else if (descriptor.method === 'json_slice') {
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
   * Resolves and caches the detected or provided format.
   */
  async #resolveFormat(): Promise<JsonArtifactFormat> {
    if (this.#format !== undefined) {
      return this.#format
    }
    const lines = await this.cat()
    this.#format = inferFormat(lines.join('\n'))
    return this.#format
  }

  /**
   * Parses and caches all records from the artifact.
   *
   * @remarks
   * For `json`/`json5` format: returns a single-element array containing the parsed root value.
   * For `jsonl`/`ndjson` format: returns one element per non-empty line.
   */
  async #resolveRecords(): Promise<T[]> {
    if (this.#parsed !== undefined) {
      return this.#parsed
    }
    const format = await this.#resolveFormat()
    const lines = await this.cat()
    if (format === 'json') {
      this.#parsed = [JSON.parse(lines.join('\n')) as T]
    } else if (format === 'json5') {
      this.#parsed = [JSON5.parse(lines.join('\n')) as T]
    } else {
      // jsonl / ndjson
      this.#parsed = lines.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T)
    }
    return this.#parsed
  }

  /**
   * Returns the detected or provided format for this artifact.
   *
   * @returns One of `'json'`, `'json5'`, `'jsonl'`, or `'ndjson'`.
   */
  async json_type(): Promise<JsonArtifactFormat> {
    return this.#resolveFormat()
  }

  /**
   * Returns the top-level keys of the parsed content.
   *
   * @remarks
   * - For `json`/`json5`: returns the keys of the root object, or `undefined` when the root is
   *   not a plain object (e.g. an array or scalar).
   * - For `jsonl`/`ndjson`: returns the union of keys across all records that are plain objects.
   *   Duplicate keys are deduplicated.
   *
   * @returns Array of key strings, or `undefined` when no object keys are present.
   */
  async json_keys(): Promise<string[] | undefined> {
    const records = await this.#resolveRecords()
    const format = await this.#resolveFormat()
    if (format === 'json' || format === 'json5') {
      const root = records[0]
      if (isObject(root)) {
        return Object.keys(root as object)
      }
      return undefined
    }
    const keySet = new Set<string>()
    for (const record of records) {
      if (isObject(record)) {
        for (const key of Object.keys(record as object)) {
          keySet.add(key)
        }
      }
    }
    return keySet.size > 0 ? Array.from(keySet) : undefined
  }

  /**
   * Returns the total number of records in the artifact.
   *
   * @remarks
   * - For `json`/`json5`: always `1` (the entire artifact is a single value).
   * - For `jsonl`/`ndjson`: the number of non-empty lines.
   *
   * @returns The record count.
   */
  async json_length(): Promise<number> {
    const records = await this.#resolveRecords()
    return records.length
  }

  /**
   * Evaluates a JSONPath expression against the parsed content.
   *
   * @remarks
   * Uses [JSONPath-Plus](https://github.com/JSONPath-Plus/JSONPath). Full JSONPath syntax is
   * supported: recursive descent (`$..*`), filter expressions (`$[?(@.age > 18)]`), union
   * selectors, and more.
   *
   * - For `json`/`json5`: evaluates the expression against the root value.
   * - For `jsonl`/`ndjson`: evaluates the expression against each record and returns a flat
   *   array of all matches across all records.
   *
   * @param path - A JSONPath expression (e.g. `'$.user.address.city'`, `'$..name'`).
   * @returns Array of matched values. Empty array when no matches are found.
   */
  async json_get(path: string): Promise<unknown[]> {
    const records = await this.#resolveRecords()
    const format = await this.#resolveFormat()
    if (format === 'json' || format === 'json5') {
      return JSONPath({ path, json: records[0] as object })
    }
    return records.flatMap((r) => JSONPath({ path, json: r as object }))
  }

  /**
   * Returns a slice of the parsed records by index range.
   *
   * @remarks
   * For `json`/`json5`: always returns `[root]` — the artifact is a single record so slicing is
   * not meaningful. For `jsonl`/`ndjson`: behaves like `Array.prototype.slice`.
   *
   * @param start - Start index (inclusive). Defaults to `0`.
   * @param end - End index (exclusive). Defaults to the record count.
   * @returns Array of sliced records.
   */
  async json_slice(start?: number, end?: number): Promise<T[]> {
    const records = await this.#resolveRecords()
    const format = await this.#resolveFormat()
    if (format === 'json' || format === 'json5') {
      return records
    }
    return records.slice(start, end)
  }

  /**
   * Returns records matched by a JSONPath filter expression.
   *
   * @remarks
   * Evaluates `path` against each record and returns those for which the expression produces at
   * least one match. For `json`/`json5`, evaluates against the root value and returns it in an
   * array if matched.
   *
   * @param path - A JSONPath expression (e.g. `'$[?(@.status === "active")]'`).
   * @returns Array of matching records.
   */
  async json_filter(path: string): Promise<T[]> {
    const records = await this.#resolveRecords()
    return records.filter((r) => {
      const matches = JSONPath({ path, json: r as object })
      return Array.isArray(matches) && matches.length > 0
    })
  }

  /**
   * Returns all values matched by a JSONPath expression across every record.
   *
   * @remarks
   * Convenience over {@link SpooledJsonArtifact.json_get} with an identical signature — use
   * whichever name better communicates intent at the call site. `json_pluck` reads well for
   * extracting a single field column; `json_get` reads well for structured queries.
   *
   * @param path - A JSONPath expression (e.g. `'$..name'`).
   * @returns Array of matched values.
   */
  async json_pluck(path: string): Promise<unknown[]> {
    return this.json_get(path)
  }
}
