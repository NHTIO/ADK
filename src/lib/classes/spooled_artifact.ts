import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../utils/guards'
import { ArtifactTool } from './artifact_tool'
import { ToolRegistry } from './tool_registry'
import { Tokenizable, TokenEncoding } from './tokenizable'
import { implementsSpoolReader } from '../contracts/spool_reader'
import { resolveSpoolReader } from '../contracts/reader_resolvers'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_NOT_A_SPOOL_READER, E_READER_NOT_DESCRIBABLE } from '../exceptions/runtime'
import type { ObjectSchema } from '@nhtio/validation'
import type { AdkEncodableSnapshot } from './encodable'
import type { SpoolReader } from '../contracts/spool_reader'
import type { DispatchContext } from '../contracts/dispatch_context'
import type { ReaderDescriptor } from '../contracts/reader_descriptor'

/**
 * Constructor signature for {@link SpooledArtifact} and any subclass.
 *
 * @remarks
 * Used by {@link @nhtio/adk!Tool} to declare the artifact subclass the consumer should use when wrapping
 * the handler's serialised output. The variadic rest parameter accommodates subclass-specific
 * constructor arguments (e.g. `SpooledJsonArtifact(reader, format?)`).
 *
 * @typeParam A - The {@link SpooledArtifact} subtype the constructor produces.
 */
export type SpooledArtifactConstructor<A extends SpooledArtifact = SpooledArtifact> = new (
  reader: SpoolReader,
  ...rest: any[]
) => A

/**
 * Metadata table entry for one of the artifact's existing query methods, used by
 * {@link SpooledArtifact.forgeTools} to surface that method as an {@link @nhtio/adk!ArtifactTool}.
 *
 * @remarks
 * This is a metadata shape, not a general method → tool pipeline. `forgeTools` knows how to
 * marshal arguments for a fixed, closed set of method names (the base seven on
 * {@link SpooledArtifact} and the JSON/Markdown methods on the bundled subclasses); a
 * descriptor is the place to attach a tool name, description, args schema, and optional
 * serializer to one of those methods. Adding a descriptor for a method whose name is not
 * in that closed set will produce a tool whose handler invokes the method with no arguments.
 *
 * For new methods that require custom argument marshalling, branching, multi-step logic,
 * cross-artifact joins, or any other behaviour beyond "call this existing method," override
 * {@link SpooledArtifact.forgeTools} and mint the {@link @nhtio/adk!ArtifactTool} directly — do not try
 * to express it through a descriptor.
 *
 * Zero-arg methods are the exception: a descriptor with no `argsSchema` (or one that adds
 * only `callId`-adjacent fields you don't consume) works for any method that takes no
 * arguments, regardless of name.
 */
export interface ToolMethodDescriptor {
  /** Absolute tool name as exposed to the LLM (e.g. `'artifact_head'`). */
  name: string
  /** Method to invoke on the resolved artifact instance (e.g. `'head'`, `'json_get'`). */
  method: string
  /** Human-readable description passed to the model. Should mention "in this turn" so the model understands the artifact's lifecycle scope. */
  description: string
  /** Schema for the method's own args, NOT including `callId`. `forgeTools()` injects `callId`. */
  argsSchema?: ObjectSchema
  /** Optional formatter for non-string return values. Defaults: string → as-is; string[] → newline-join; number → `String(n)`; otherwise `JSON.stringify(value, null, 2)`. */
  serialise?: (result: unknown) => string
}

const noArgsSchema = validator.object<Record<string, never>>({})

/**
 * Default serialiser for {@link @nhtio/adk!ArtifactTool} handler return values when a descriptor does not
 * provide its own. Exported for reuse by subclass `forgeTools` overrides.
 *
 * @param result - The artifact-method return value.
 * @returns A string suitable for inclusion in an LLM tool-call response.
 */
export const defaultSerialise = (result: unknown): string => {
  if (result === undefined) return '(undefined)'
  if (result === null) return 'null'
  if (typeof result === 'string') return result
  if (Array.isArray(result) && result.every((r) => typeof r === 'string')) {
    if (result.length === 0) return '(empty list)'
    return (result as string[]).join('\n')
  }
  if (typeof result === 'number') return String(result)
  return JSON.stringify(result, null, 2)
}

const baseToolMethods: ReadonlyArray<ToolMethodDescriptor> = Object.freeze([
  {
    name: 'artifact_head',
    method: 'head',
    description:
      'Return the first n lines of a spooled artifact produced earlier in this turn. Takes a callId selecting which artifact to inspect.',
    argsSchema: validator.object({
      n: validator.number().integer().min(1).default(10).description('Number of lines to return.'),
    }),
  },
  {
    name: 'artifact_tail',
    method: 'tail',
    description:
      'Return the last n lines of a spooled artifact produced earlier in this turn. Takes a callId selecting which artifact to inspect.',
    argsSchema: validator.object({
      n: validator.number().integer().min(1).default(10).description('Number of lines to return.'),
    }),
  },
  {
    name: 'artifact_grep',
    method: 'grep',
    description:
      'Return all lines matching a regular expression pattern from a spooled artifact produced earlier in this turn.',
    argsSchema: validator.object({
      pattern: validator
        .string()
        .required()
        .description('Regular expression pattern, applied via JavaScript RegExp.'),
      flags: validator
        .string()
        .pattern(/^[imsu]*$/)
        .optional()
        .description(
          "Optional RegExp flags. Allowed: 'i' (case-insensitive), 'm' (multiline), 's' (dotAll), 'u' (unicode). 'g' and 'y' are disallowed because per-line matching is stateless."
        ),
    }),
  },
  {
    name: 'artifact_cat',
    method: 'cat',
    description:
      'Return lines from a spooled artifact produced earlier in this turn, optionally bounded to a range.',
    argsSchema: validator.object({
      start: validator.number().integer().min(0).optional().description('Start line (inclusive).'),
      end: validator.number().integer().min(0).optional().description('End line (exclusive).'),
    }),
  },
  {
    name: 'artifact_byte_length',
    method: 'byteLength',
    description:
      'Return the total byte length of a spooled artifact produced earlier in this turn.',
    argsSchema: noArgsSchema,
  },
  {
    name: 'artifact_line_count',
    method: 'lineCount',
    description: 'Return the total line count of a spooled artifact produced earlier in this turn.',
    argsSchema: noArgsSchema,
  },
  {
    name: 'artifact_estimate_tokens',
    method: 'estimateTokens',
    description:
      'Estimate the total token count of a spooled artifact produced earlier in this turn under a named encoding.',
    argsSchema: validator.object({
      encoding: validator
        .string()
        .valid(...TokenEncoding)
        .required()
        .description('Token encoding identifier.'),
    }),
  },
])

/**
 * A lazy, line-oriented view over an arbitrary backing store.
 *
 * @remarks
 * All I/O methods are async to remain compatible with both in-memory and streaming
 * {@link @nhtio/adk!SpoolReader} implementations. Token estimation delegates to
 * {@link @nhtio/adk!Tokenizable.estimateTokens} — the same backends used elsewhere in the ADK.
 *
 * The class is read-only by design: mutation of the underlying data is the responsibility of the
 * producer that created the {@link @nhtio/adk!SpoolReader}, not the consumer reading from this artifact.
 */
export class SpooledArtifact {
  /**
   * The set of artifact-query methods this class surfaces via {@link SpooledArtifact.forgeTools}.
   *
   * @remarks
   * The base set covers the generic line-oriented operations every artifact supports:
   * `artifact_head`, `artifact_tail`, `artifact_grep`, `artifact_cat`, `artifact_byte_length`,
   * `artifact_line_count`, `artifact_estimate_tokens`. Each `toolMethods` array lists **only**
   * its own class's descriptors — subclasses do not concatenate inherited descriptors. The
   * subclass instead overrides {@link SpooledArtifact.forgeTools} to merge the base registry
   * (produced by `SpooledArtifact.forgeTools(ctx)`) with its own — see
   * {@link @nhtio/adk!SpooledJsonArtifact.forgeTools} and {@link @nhtio/adk!SpooledMarkdownArtifact.forgeTools} for
   * the canonical shape and the pattern downstream consumers should follow when building
   * their own `SpooledArtifact` subclasses.
   *
   * Tool names are absolute (not subclass-prefixed). Forged tools carry
   * `Tool.onCollision = 'replace'` so merging multiple subclasses' `forgeTools()` outputs is
   * silent — every same-named tool dispatches the same method on whatever artifact the
   * `callId` resolves to, so the overlap is behaviourally interchangeable.
   *
   * Frozen at module load.
   */
  public static toolMethods: ReadonlyArray<ToolMethodDescriptor> = baseToolMethods

  #reader: SpoolReader

  /**
   * @param reader - The backing store to read from.
   * @throws {@link @nhtio/adk!E_NOT_A_SPOOL_READER} when `reader` does not implement {@link @nhtio/adk!SpoolReader}.
   */
  constructor(reader: SpoolReader) {
    if (!implementsSpoolReader(reader)) {
      throw new E_NOT_A_SPOOL_READER()
    }
    this.#reader = reader
  }

  /**
   * Emit the backing reader's serialisable {@link ReaderDescriptor}, or throw if it cannot describe
   * itself.
   *
   * @remarks
   * `protected` so subclasses can build their own encode snapshots over the base reader (which is
   * otherwise private). Throws {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE} when the reader has no
   * `describe()` (or returns `undefined`) — there is no serialisable handle to write.
   *
   * @returns The reader's tagged handle descriptor.
   * @throws {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE} when the reader is not describable.
   */
  protected readerDescriptor(): ReaderDescriptor {
    const descriptor = this.#reader.describe?.()
    if (!descriptor) {
      throw new E_READER_NOT_DESCRIBABLE(['reader'])
    }
    return descriptor
  }

  /**
   * Serialise this SpooledArtifact into an `@nhtio/encoder` snapshot — the reader **handle**, not the
   * bytes.
   *
   * @remarks
   * Emits the backing reader's {@link ReaderDescriptor}; decode re-binds the reader through the
   * registered resolver. Throws {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE} when the reader cannot
   * describe itself. Subclasses override this to include their own discriminators (e.g.
   * {@link @nhtio/adk!SpooledJsonArtifact} adds `format`).
   *
   * @returns A snapshot consumed by {@link SpooledArtifact.[DECODE_METHOD]}.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return { reader: this.readerDescriptor() }
  }

  /**
   * Reconstruct a {@link SpooledArtifact} from an {@link SpooledArtifact.[ENCODE_METHOD]} snapshot.
   *
   * @remarks
   * Re-binds the reader via {@link @nhtio/adk!resolveSpoolReader}; throws
   * {@link @nhtio/adk!E_NO_READER_RESOLVER} when no resolver is registered for the descriptor's tag.
   *
   * @param data - The snapshot produced by {@link SpooledArtifact.[ENCODE_METHOD]}.
   * @returns A fresh {@link SpooledArtifact} backed by a freshly-resolved reader.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): SpooledArtifact {
    const snapshot = data as { reader: ReaderDescriptor }
    return new SpooledArtifact(resolveSpoolReader(snapshot.reader))
  }

  /**
   * Returns the line at the given 0-based index, or `undefined` when out of range.
   *
   * @remarks
   * Protected so subclasses can scan the backing store line-by-line without allocating
   * intermediate arrays. Delegates directly to the {@link @nhtio/adk!SpoolReader}.
   *
   * @param index - 0-based line index.
   * @returns The raw line string, or `undefined` when out of range.
   */
  protected async line(index: number): Promise<string | undefined> {
    return this.#reader.line(index)
  }

  /**
   * Returns `true` if `value` is a {@link SpooledArtifact} instance (including any subclass).
   *
   * @remarks
   * Uses the cross-realm-safe {@link @nhtio/adk!isInstanceOf} guard: `instanceof` first, then
   * `Symbol.hasInstance`, then a `constructor.name` fallback. Subclass instances (e.g.
   * {@link @nhtio/adk!SpooledJsonArtifact}) satisfy this guard because `instanceof` walks the prototype
   * chain. The fallbacks handle the dual-module-copy case where two distinct `SpooledArtifact`
   * classes coexist in the same realm (e.g. one bundled into a downstream library, one in the
   * consumer's `node_modules`).
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link SpooledArtifact} instance.
   */
  public static isSpooledArtifact(value: unknown): value is SpooledArtifact {
    return isInstanceOf(value, 'SpooledArtifact', SpooledArtifact)
  }

  /**
   * Returns `true` if `value` is a constructor function whose prototype chain includes
   * {@link SpooledArtifact} (including `SpooledArtifact` itself).
   *
   * @remarks
   * Used by {@link @nhtio/adk!Tool} to validate the optional `artifactConstructor` field. Performs an
   * `instanceof`-based check on the prototype chain; falls back to a duck-type test that looks
   * for the canonical SpooledArtifact instance methods on `value.prototype` for cross-realm
   * safety (constructors passed from a different module copy or VM context).
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a constructor for `SpooledArtifact` or a subclass.
   */
  public static isSpooledArtifactConstructor(
    value: unknown
  ): value is SpooledArtifactConstructor<SpooledArtifact> {
    if (typeof value !== 'function') return false
    if (value === SpooledArtifact) return true
    const proto = (value as { prototype?: unknown }).prototype
    if (proto === undefined || proto === null) return false
    if (isInstanceOf(proto, 'SpooledArtifact', SpooledArtifact)) return true
    // Cross-realm duck-type fallback: prototype carries the canonical SpooledArtifact methods
    const methods = ['head', 'tail', 'grep', 'cat', 'byteLength', 'lineCount', 'estimateTokens']
    return methods.every((m) => typeof (proto as Record<string, unknown>)[m] === 'function')
  }

  /**
   * Returns the first `n` lines of the artifact.
   *
   * @remarks
   * If the artifact contains fewer than `n` lines, all available lines are returned. Matches the
   * behaviour of POSIX `head -n`.
   *
   * @param n - Number of lines to return. Defaults to 10.
   * @returns Array of line strings, without trailing newlines.
   */
  async head(n: number = 10): Promise<string[]> {
    const count = await this.#reader.lineCount()
    const limit = Math.min(n, count)
    const lines: string[] = []
    for (let i = 0; i < limit; i++) {
      const line = await this.#reader.line(i)
      if (line !== undefined) {
        lines.push(line)
      }
    }
    return lines
  }

  /**
   * Returns the last `n` lines of the artifact.
   *
   * @remarks
   * If the artifact contains fewer than `n` lines, all available lines are returned. Matches the
   * behaviour of POSIX `tail -n`.
   *
   * @param n - Number of lines to return. Defaults to 10.
   * @returns Array of line strings, without trailing newlines.
   */
  async tail(n: number = 10): Promise<string[]> {
    const count = await this.#reader.lineCount()
    const start = Math.max(0, count - n)
    const lines: string[] = []
    for (let i = start; i < count; i++) {
      const line = await this.#reader.line(i)
      if (line !== undefined) {
        lines.push(line)
      }
    }
    return lines
  }

  /**
   * Returns all lines that match `pattern`.
   *
   * @remarks
   * Behaves like POSIX `grep`: each line is tested against the pattern and included in the result
   * when it matches. The pattern is applied as a JavaScript `RegExp`; flags (e.g. case-
   * insensitivity) should be encoded in the expression itself.
   *
   * Stateful flags (`g`, `y`) on the supplied `RegExp` would normally cause `pattern.test()` to
   * advance `lastIndex` across calls, producing skipped matches and order-dependent results. To
   * keep the per-line semantics stateless, `grep` resets `pattern.lastIndex` to `0` before each
   * line test. The forged `artifact_grep` tool also rejects `g` and `y` flags up-front at schema
   * validation time.
   *
   * @param pattern - The regular expression to test each line against.
   * @returns Array of matching line strings, in order.
   */
  async grep(pattern: RegExp): Promise<string[]> {
    const count = await this.#reader.lineCount()
    const matches: string[] = []
    for (let i = 0; i < count; i++) {
      const line = await this.#reader.line(i)
      if (line !== undefined) {
        pattern.lastIndex = 0
        if (pattern.test(line)) {
          matches.push(line)
        }
      }
    }
    return matches
  }

  /**
   * Returns lines from the artifact, optionally bounded to a range.
   *
   * @remarks
   * Without arguments, returns all lines — equivalent to POSIX `cat`. With `start` and/or `end`,
   * behaves like `Array.prototype.slice`: `start` defaults to `0`, `end` defaults to the total
   * line count, and only lines in `[start, end)` are fetched from the backing store. For large
   * artifacts, prefer a bounded range or {@link SpooledArtifact.head} / {@link SpooledArtifact.tail}.
   *
   * @param start - 0-based start line index (inclusive). Defaults to `0`.
   * @param end - 0-based end line index (exclusive). Defaults to `lineCount()`.
   * @returns Array of line strings in the requested range.
   */
  async cat(start?: number, end?: number): Promise<string[]> {
    const count = await this.#reader.lineCount()
    const from = Math.max(0, start ?? 0)
    const to = Math.min(count, end ?? count)
    const lines: string[] = []
    for (let i = from; i < to; i++) {
      const line = await this.#reader.line(i)
      if (line !== undefined) {
        lines.push(line)
      }
    }
    return lines
  }

  /**
   * Returns the total byte length of the underlying data.
   *
   * @returns The byte length as reported by the {@link @nhtio/adk!SpoolReader}.
   */
  async byteLength(): Promise<number> {
    return this.#reader.byteLength()
  }

  /**
   * Returns the total number of lines in the artifact.
   *
   * @returns The line count as reported by the {@link @nhtio/adk!SpoolReader}.
   */
  async lineCount(): Promise<number> {
    return this.#reader.lineCount()
  }

  /**
   * Estimates the total token count of the artifact under `encoding`.
   *
   * @remarks
   * Reads the full byte-faithful content via {@link SpooledArtifact.asString} (which delegates to
   * {@link @nhtio/adk!SpoolReader.readAll}) and delegates to {@link @nhtio/adk!Tokenizable.estimateTokens}. The estimate
   * therefore reflects the actual source bytes — including trailing newlines and non-`\n` line
   * terminators that the line-based {@link SpooledArtifact.cat} view would otherwise discard or
   * misrepresent.
   *
   * @param encoding - The encoding identifier to use for counting.
   * @returns The estimated number of tokens.
   */
  async estimateTokens(encoding: TokenEncoding): Promise<number> {
    const content = await this.#reader.readAll()
    return Tokenizable.estimateTokens(content, encoding)
  }

  /**
   * Returns the full artifact body as a single byte-faithful string.
   *
   * @remarks
   * Round-trip faithful to whatever bytes the {@link @nhtio/adk!SpoolReader} was constructed over —
   * preserves trailing newlines and non-`\n` line terminators that {@link SpooledArtifact.cat}
   * discards via its line-based view. This is the canonical primitive for "inline the artifact
   * content directly into a message" use cases.
   *
   * `asString()` and the static `forgeTools(ctx)` factory on each subclass are independent
   * alternatives — a consumer chooses per turn whether to inline the body in a message
   * (`await tc.results.asString()`) or hand the model query tools
   * (`SpooledArtifact.forgeTools(ctx)`). Neither calls the other; either works with neither.
   *
   * @returns The full content as a single string.
   */
  async asString(): Promise<string> {
    return this.#reader.readAll()
  }

  /**
   * Forges a fresh {@link @nhtio/adk!ToolRegistry} of ephemeral {@link @nhtio/adk!ArtifactTool} instances that let the
   * LLM query artifacts already present in `ctx.turnToolCalls`.
   *
   * @remarks
   * Standard subclass extension pattern — each class owns only its own `toolMethods` and its
   * own `forgeTools`. The base `SpooledArtifact.forgeTools(ctx)` narrows the `callId` enum to
   * any `tc.results instanceof SpooledArtifact` (so subclass instances are included — that's
   * the whole point of inheritance) and dispatches the seven base methods (`head`, `tail`,
   * `grep`, `cat`, `byteLength`, `lineCount`, `estimateTokens`) on the resolved artifact.
   * Subclasses override `forgeTools` to call this static first and then register their own
   * tools on the returned registry — see {@link @nhtio/adk!SpooledJsonArtifact.forgeTools} and
   * {@link @nhtio/adk!SpooledMarkdownArtifact.forgeTools} for the canonical shape. There is no
   * `requiresSubclass` field, no helper indirection, and no `this`-based class narrowing —
   * just plain `instanceof ThisClass` at each subclass's own filter site.
   *
   * For each descriptor in this class's `toolMethods`, the factory:
   *
   * 1. Walks `ctx.turnToolCalls` to find `ToolCall`s whose `results instanceof SpooledArtifact`.
   *    `ToolCall`s flagged `fromArtifactTool === true` are excluded — they carry a
   *    {@link @nhtio/adk!Tokenizable}, not a `SpooledArtifact`, and including them would let the model
   *    `artifact_grep` on a previous `artifact_grep` result (an infinite-recursion hazard with
   *    no semantic value).
   * 2. Returns an empty registry if no compatible callIds are found — no point shipping tools
   *    whose `callId` enum is empty.
   * 3. Otherwise mints an {@link @nhtio/adk!ArtifactTool} with `ephemeral: true` and `onCollision: 'replace'`
   *    so multiple `Subclass.forgeTools(ctx)` outputs merge silently. The tool's `inputSchema`
   *    includes a required `callId` field with `.valid(...compatibleIds)`, plus the descriptor's
   *    own `argsSchema` fields.
   *
   * The handler resolves the artifact via `[...ctx.turnToolCalls].find(t => t.id === callId)`,
   * dispatches the descriptor's method, and serialises the return value (string → as-is;
   * string[] → newline-join; number → `String(n)`; otherwise `JSON.stringify(value, null, 2)`;
   * `descriptor.serialise` overrides the defaults). `grep` is special-cased: the handler
   * constructs `new RegExp(pattern, flags ?? '')` before invoking the artifact's `grep` method.
   *
   * The returned registry must be merged into the consumer's main registry and the main
   * registry must be bound to `ctx` via {@link @nhtio/adk!ToolRegistry.bindContext}:
   *
   * ```ts
   * const executor: DispatchExecutorFn = async (ctx) => {
   *   const forged = SpooledArtifact.forgeTools(ctx)
   *   const merged = ToolRegistry.merge([main, forged])
   *   main.bindContext(ctx)
   *   const result = await llm.invoke({ tools: merged.all(), ... })
   *   ctx.ack() // ← ephemeral cleanup fires here
   * }
   * ```
   *
   * @warning You **must** call `registry.bindContext(ctx)` on the registry hosting these tools,
   * or ephemeral cleanup will not run and the `callId` enum in subsequent executor calls will
   * be stale (excluding new tool calls produced in the meantime).
   *
   * @param ctx - The execution context whose `turnToolCalls` snapshot defines the `callId` enum.
   * @returns A fresh `ToolRegistry`. Empty when `turnToolCalls` contains no compatible artifacts.
   *
   * @see {@link @nhtio/adk!ToolRegistry.bindContext}
   * @see {@link @nhtio/adk!ToolRegistry.merge}
   * @see {@link @nhtio/adk!DispatchContext.onAck}
   */
  public static forgeTools(ctx: DispatchContext): ToolRegistry {
    const requires: SpooledArtifactConstructor = SpooledArtifact
    const calls = [...ctx.turnToolCalls]
    const compatibleIds = calls
      .filter((tc) => !tc.fromArtifactTool && isInstanceOf(tc.results, requires.name, requires))
      .map((tc) => tc.id)
    if (compatibleIds.length === 0) return new ToolRegistry([])

    const tools: ArtifactTool[] = []
    for (const descriptor of this.toolMethods) {
      const callIdSchema = validator
        .string()
        .valid(...compatibleIds)
        .required()
        .description('ToolCall id of the artifact to query.')

      const argsSchema = (descriptor.argsSchema ?? noArgsSchema).append({
        callId: callIdSchema,
      })

      const serialise = descriptor.serialise ?? defaultSerialise

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
          if (descriptor.method === 'grep') {
            const pattern = args.pattern as string
            const flags = (args.flags as string | undefined) ?? ''
            methodArgs.push(new RegExp(pattern, flags))
          } else if (descriptor.method === 'head' || descriptor.method === 'tail') {
            methodArgs.push((args.n as number | undefined) ?? 10)
          } else if (descriptor.method === 'cat') {
            methodArgs.push(args.start as number | undefined, args.end as number | undefined)
          } else if (descriptor.method === 'estimateTokens') {
            methodArgs.push(args.encoding as TokenEncoding)
          }
          const fn = (artifact as unknown as Record<string, (...a: unknown[]) => unknown>)[
            descriptor.method
          ]
          if (typeof fn !== 'function') {
            return `Error: artifact has no method ${descriptor.method}`
          }
          const result = await Promise.resolve(fn.apply(artifact, methodArgs))
          return serialise(result)
        },
      })
      tools.push(tool)
    }
    return new ToolRegistry(tools)
  }
}
