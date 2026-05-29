import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { Registry } from './registry'
import { validator } from '@nhtio/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { canonicalStringify } from '../utils/canonical_json'
import { validateOrThrow, asyncValidateOrThrow, ValidationException } from '../utils/validation'
import { implementsSpooledArtifactConstructor } from '../contracts/spooled_artifact_constructor'
import {
  E_INVALID_INITIAL_TOOL_VALUE,
  E_INVALID_TOOL_ARGS,
  E_TOOL_DOWNSTREAM_ERROR,
} from '../exceptions/runtime'
import type { Media } from './media'
import type { Schema, Description } from '@nhtio/validation'
import type { DispatchContext } from '../contracts/dispatch_context'
import type { SpooledArtifact, SpooledArtifactConstructor } from './spooled_artifact'

/**
 * A zero-arg function that returns the {@link @nhtio/adk!SpooledArtifactConstructor} the consumer should
 * use when wrapping this tool's serialised output into a `ToolCall.results` field.
 *
 * @remarks
 * Why a resolver (and not the constructor itself)? `tool.ts` participates in a module-load
 * cycle with `spooled_artifact.ts` and `artifact_tool.ts` (`ArtifactTool extends Tool` closes
 * the loop). Any eager value-level reference to `SpooledArtifact` in `tool.ts` would crash the
 * cycle with a TDZ error. A resolver lets `tool.ts` validate "is a function" at module-load
 * time and defer the actual constructor check to validate-time (which always runs after every
 * module body has executed). Wrap-sites invoke `tool.artifactConstructor?.() ?? SpooledArtifact`
 * to obtain the final constructor.
 */
export type ArtifactConstructorResolver<A extends SpooledArtifact = SpooledArtifact> =
  () => SpooledArtifactConstructor<A>

/**
 * The execution function for a {@link Tool}.
 *
 * @remarks
 * Receives the raw arguments passed to the executor, the active {@link @nhtio/adk!DispatchContext}, and the
 * tool's metadata registry.
 *
 * Return shapes:
 * - `string` / `Uint8Array` — opaque serialised output. The ADK does not persist the bytes
 *   itself; the consumer's executor middleware is responsible for storing them and wrapping
 *   them via `tool.artifactConstructor?.() ?? SpooledArtifact` when assembling the `ToolCall`
 *   record.
 * - {@link @nhtio/adk!Media} / `Media[]` — explicit-modality silo. Bypasses
 *   {@link Tool.artifactConstructor} — the handler returns the final result shape directly.
 *   The LLM battery renders each `Media` as a provider-specific content block.
 */
export type ToolHandler = (
  args: unknown,
  ctx: DispatchContext,
  meta: Registry
) => string | Uint8Array | Media | Media[] | Promise<string | Uint8Array | Media | Media[]>

/**
 * Plain input object supplied to {@link Tool} at construction time.
 *
 * @typeParam A - The {@link @nhtio/adk!SpooledArtifact} subtype used to wrap this tool's results when
 *   the consumer assembles a `ToolCall.results` field. Defaults to {@link @nhtio/adk!SpooledArtifact}
 *   (plain text). Tools producing JSON output should set this to `SpooledJsonArtifact`; tools
 *   producing markdown should set it to `SpooledMarkdownArtifact`; consumers can also pass a
 *   custom subclass.
 */
export interface RawTool<A extends SpooledArtifact = SpooledArtifact> {
  /** Unique identifier used in LLM tool definitions. Recommend lowercase snake_case. */
  name: string
  /** Human-readable description passed to the model to explain what the tool does. */
  description: string
  /** @nhtio/validation schema for the tool's input arguments. Annotate with `.description()`, `.note()`, `.example()` etc. to produce rich LLM tool definitions via `.describe()`. */
  inputSchema: Schema
  /** Execution function. Not exposed as a public property — invoke via `executor()`. */
  handler: ToolHandler
  /**
   * Zero-arg resolver returning the {@link @nhtio/adk!SpooledArtifactConstructor} the consumer should use
   * when wrapping this tool's serialised output into a `ToolCall.results` field. Optional —
   * when omitted, wrap-sites fall back to {@link @nhtio/adk!SpooledArtifact} (plain text).
   *
   * @remarks
   * Recommended call shape: `artifactConstructor: () => SpooledJsonArtifact`. The closure is
   * the indirection that lets `tool.ts` validate this field without eagerly importing
   * `SpooledArtifact` (which would crash the `tool.ts ↔ spooled_artifact.ts ↔ artifact_tool.ts`
   * module-load cycle). At validate time the schema invokes the resolver and verifies its
   * return value is a `SpooledArtifact`-derived constructor — wrong-shape resolvers throw
   * {@link @nhtio/adk!E_INVALID_INITIAL_TOOL_VALUE}.
   *
   * Wrap-sites (storage batteries, scripted executors) read the constructor via
   * `tool.artifactConstructor?.() ?? SpooledArtifact`.
   */
  artifactConstructor?: ArtifactConstructorResolver<A>
  /** Optional arbitrary metadata for this tool (e.g. RBAC scopes, feature flags). Defaults to `{}`. Stored in a {@link @nhtio/adk!Registry} for dot-path access. */
  meta?: Record<string, unknown>
  /**
   * When `true`, marks this tool as owned by a specific {@link @nhtio/adk!DispatchContext} so that
   * `ToolRegistry.pruneEphemeral()` will drop it at ctx-completion.
   *
   * @remarks
   * The flag is advisory at the `Tool` level — registries decide what to do with it. The canonical
   * producer of ephemeral tools is `SpooledArtifact.forgeTools(ctx)`, which sets this to `true`
   * on every artifact-query tool it emits.
   *
   * @defaultValue `false`
   */
  ephemeral?: boolean
  /**
   * When `true`, declares that this tool's output should be treated as **trusted developer/user
   * intent** rather than as untrusted third-party text when surfaced to the model.
   *
   * @remarks
   * LLM batteries read this flag per call when rendering tool-call results. The default
   * untrusted envelope (e.g. `<untrusted_content>` in the OpenAI Chat Completions battery) is the
   * secure-by-default treatment for arbitrary tool output. A tool whose output is authored by the
   * user or operator (Q&A tools surfacing user-authored answers, human-in-the-loop approval
   * gates, feedback-collection tools, configuration tools returning developer-authored
   * constants) sets this to `true` so the LLM battery routes the result through its trusted
   * envelope (`<trusted_content>` in the OpenAI Chat Completions battery).
   *
   * Trust is a property of the tool's output, not a property of how a particular battery is
   * wired — putting the flag here means the trust signal travels with the tool wherever it is
   * registered, no per-battery string lists, no name-matching to fail-open on typos.
   *
   * @defaultValue `false`
   */
  trusted?: boolean
  /**
   * Self-declared merge collision policy. Honoured by `ToolRegistry.merge` (NOT by
   * `ToolRegistry.register`) when this tool collides with another of the same name.
   *
   * @remarks
   * - `'throw'` (default): defer to the merge-level `options.onCollision`. If that is also
   *   `'throw'`, the merge raises `E_TOOL_ALREADY_REGISTERED`. This matches the default behaviour
   *   of `ToolRegistry.register`.
   * - `'replace'`: this tool always wins the collision, regardless of the merge-level option.
   * - `'keep'`: this tool always loses to any previously-registered tool of the same name.
   *
   * Forged artifact-query tools set this to `'replace'` so that merging multiple
   * `Subclass.forgeTools(ctx)` outputs (whose base-method tools overlap by name) resolves
   * silently — the descriptors, snapshot, and handler behaviour are interchangeable across
   * subclasses, so replacement is a behavioural no-op.
   *
   * @defaultValue `'throw'`
   */
  onCollision?: 'throw' | 'replace' | 'keep'
}

/**
 * Validator schema for a {@link RawTool}.
 */
const rawToolSchema = validator.object<RawTool>({
  name: validator.string().required(),
  description: validator.string().required(),
  inputSchema: validator
    .any()
    .custom((value, helpers) => {
      if (validator.isSchema(value) && (value as any).type === 'object') return value
      return helpers.error('any.invalid')
    })
    .required(),
  handler: validator.function().required(),
  artifactConstructor: validator
    .any()
    .custom((value, helpers) => {
      if (typeof value !== 'function') return helpers.error('any.invalid')
      // The resolver runs at validate time — well after the tool.ts ↔ spooled_artifact.ts ↔
      // artifact_tool.ts module cycle has fully unwound — so invoking it is safe. Delegate the
      // "is this a SpooledArtifact-shaped constructor?" check to the contract-level guard so
      // there's one canonical duck-type test (mirrors `implementsSpoolReader`'s pattern).
      let resolved: unknown
      try {
        resolved = (value as () => unknown)()
      } catch {
        return helpers.error('any.invalid')
      }
      if (implementsSpooledArtifactConstructor(resolved)) return value
      return helpers.error('any.invalid')
    })
    .optional(),
  meta: validator.object().pattern(validator.string(), validator.any()).default({}),
  ephemeral: validator.boolean().default(false),
  trusted: validator.boolean().default(false),
  onCollision: validator.string().valid('throw', 'replace', 'keep').default('throw'),
})

/**
 * A tool definition that serves as the single source of truth for a callable tool: its name,
 * description, input schema, execution handler, and the {@link @nhtio/adk!SpooledArtifact} subclass that
 * wraps its serialised output.
 *
 * @typeParam A - The {@link @nhtio/adk!SpooledArtifact} subtype this tool's results should be wrapped in.
 *   Defaults to {@link @nhtio/adk!SpooledArtifact}.
 *
 * @remarks
 * The `inputSchema` is a `@nhtio/validation` schema. It is used at runtime to validate incoming
 * arguments before the handler is called, and its `.describe()` output provides all the metadata
 * needed to build a provider-specific LLM tool definition — annotate the schema with
 * `.description()`, `.note()`, `.example()` etc. once, and that information is available in both
 * contexts without duplication.
 *
 * The handler is private — invoke it only through `executor(ctx)` which validates args, fires
 * observability events (with a stable `callId` derived from the tool name and arguments), and
 * wraps handler errors in {@link @nhtio/adk!E_TOOL_DOWNSTREAM_ERROR}. The handler returns serialised bytes
 * (`string | Uint8Array`); persistence is the consumer's responsibility.
 *
 * `artifactConstructor` is the {@link @nhtio/adk!SpooledArtifact} subclass the consumer should use when
 * wrapping the handler's output into a `ToolCall.results` field. The author declares it once
 * on the tool instance; the consumer reads it when assembling persisted records.
 */
export class Tool<A extends SpooledArtifact = SpooledArtifact> {
  /**
   * Validator schema that accepts a {@link RawTool} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a tool entry
   * (e.g. `TurnRunnerConfig.tools`).
   */
  public static schema = rawToolSchema

  /**
   * Returns `true` if `value` is a {@link Tool} instance.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Tool} instance.
   */
  public static isTool(value: unknown): value is Tool {
    return isInstanceOf(value, 'Tool', Tool)
  }

  declare readonly name: string
  declare readonly description: string
  declare readonly inputSchema: Schema
  declare readonly artifactConstructor: ArtifactConstructorResolver<A> | undefined
  declare readonly meta: Registry
  declare readonly ephemeral: boolean
  declare readonly trusted: boolean
  declare readonly onCollision: 'throw' | 'replace' | 'keep'

  #name: string
  #description: string
  #inputSchema: Schema
  #handler: ToolHandler
  #artifactConstructor: ArtifactConstructorResolver<A> | undefined
  #meta: Registry
  #ephemeral: boolean
  #trusted: boolean
  #onCollision: 'throw' | 'replace' | 'keep'

  /**
   * @param raw - The raw tool input validated against `rawToolSchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_TOOL_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawTool<A>) {
    let resolved: RawTool<A> & {
      meta: Record<string, unknown>
      ephemeral: boolean
      trusted: boolean
      onCollision: 'throw' | 'replace' | 'keep'
    }
    try {
      resolved = validateOrThrow<typeof resolved>(
        rawToolSchema,
        raw as RawTool,
        true
      ) as typeof resolved
    } catch (err) {
      throw new E_INVALID_INITIAL_TOOL_VALUE({ cause: isError(err) ? err : undefined })
    }

    this.#name = resolved.name
    this.#description = resolved.description
    this.#inputSchema = resolved.inputSchema
    this.#handler = resolved.handler
    this.#artifactConstructor = resolved.artifactConstructor as
      | ArtifactConstructorResolver<A>
      | undefined
    this.#meta = new Registry(resolved.meta)
    this.#ephemeral = resolved.ephemeral
    this.#trusted = resolved.trusted
    this.#onCollision = resolved.onCollision

    Object.defineProperties(this, {
      name: {
        get: () => this.#name,
        enumerable: true,
        configurable: false,
      },
      description: {
        get: () => this.#description,
        enumerable: true,
        configurable: false,
      },
      inputSchema: {
        get: () => this.#inputSchema,
        enumerable: true,
        configurable: false,
      },
      artifactConstructor: {
        get: () => this.#artifactConstructor,
        enumerable: true,
        configurable: false,
      },
      meta: {
        get: () => this.#meta,
        enumerable: true,
        configurable: false,
      },
      ephemeral: {
        get: () => this.#ephemeral,
        enumerable: true,
        configurable: false,
      },
      trusted: {
        get: () => this.#trusted,
        enumerable: true,
        configurable: false,
      },
      onCollision: {
        get: () => this.#onCollision,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Validates `args` against the tool's input schema asynchronously.
   *
   * @remarks
   * Async to support schemas with external validators (e.g. database lookups, API calls).
   * A validation failure throws {@link @nhtio/adk!E_INVALID_TOOL_ARGS} — this indicates a programming error
   * in the tool call loop, not a downstream failure.
   *
   * @param args - The arguments to validate.
   * @returns The validated (and coerced) arguments.
   * @throws {@link @nhtio/adk!E_INVALID_TOOL_ARGS} when `args` does not satisfy the input schema.
   */
  async validate(args: unknown): Promise<unknown> {
    try {
      return await asyncValidateOrThrow(this.#inputSchema, args)
    } catch (err) {
      if (isInstanceOf(err, 'ValidationException', ValidationException)) {
        throw new E_INVALID_TOOL_ARGS({ cause: err })
      }
      throw err
    }
  }

  /**
   * Returns a bound executor function for this tool against the given turn context.
   *
   * @remarks
   * The executor: (1) computes a stable `callId` as `sha256(canonicalStringify({tool, args}))`
   * over the **raw, pre-validation args**, (2) validates `args` via {@link Tool.validate},
   * (3) emits `toolExecutionStart` on the context (with the computed `callId`), (4) calls the
   * handler, (5) emits `toolExecutionEnd` (with the same `callId`), (6) wraps any handler error
   * in {@link @nhtio/adk!E_TOOL_DOWNSTREAM_ERROR} before re-throwing.
   *
   * The handler returns serialised bytes (`string | Uint8Array`) — persistence is the consumer's
   * concern. Use {@link Tool.artifactConstructor} when wrapping the bytes into a
   * `ToolCall.results` field.
   *
   * Pattern mirrors `Middleware.runner()` — call once per turn, reuse the returned function.
   *
   * @param ctx - The active turn context. Provides emit functions and turn ID.
   * @returns An async function `(args) => Promise<string | Uint8Array>`.
   */
  executor(
    ctx: DispatchContext
  ): (args: unknown) => Promise<string | Uint8Array | Media | Media[]> {
    return async (args: unknown): Promise<string | Uint8Array | Media | Media[]> => {
      // Compute callId over raw args (pre-validation) so two invocations with the same
      // (tool, raw args) produce the same identifier even if validation coerces values.
      const callId = sha256(canonicalStringify({ tool: this.#name, args }))
      const validatedArgs = await this.validate(args)
      const startedAt = DateTime.now()
      ctx.emitToolExecutionStart({
        toolName: this.#name,
        turnId: ctx.id,
        callId,
        args: validatedArgs,
        startedAt,
      })
      try {
        const result = await this.#handler(validatedArgs, ctx, this.#meta)
        const endedAt = DateTime.now()
        ctx.emitToolExecutionEnd({
          toolName: this.#name,
          turnId: ctx.id,
          callId,
          startedAt,
          endedAt,
          durationMs: endedAt.diff(startedAt).milliseconds,
          isError: false,
        })
        return result
      } catch (err) {
        const endedAt = DateTime.now()
        ctx.emitToolExecutionEnd({
          toolName: this.#name,
          turnId: ctx.id,
          callId,
          startedAt,
          endedAt,
          durationMs: endedAt.diff(startedAt).milliseconds,
          isError: true,
        })
        throw new E_TOOL_DOWNSTREAM_ERROR({ cause: isError(err) ? err : undefined })
      }
    }
  }

  /**
   * Returns a fully serialisable snapshot of this tool's definition.
   *
   * @remarks
   * The `inputSchema` property is the result of calling `.describe()` on the raw schema — a plain
   * object carrying all the annotation metadata (descriptions, notes, examples, types) without any
   * validator functions. Use this to build provider-specific LLM tool definitions.
   *
   * @returns `{ name, description, inputSchema }` where `inputSchema` is the schema description.
   */
  describe(): { name: string; description: string; inputSchema: Description } {
    return {
      name: this.#name,
      description: this.#description,
      inputSchema: this.#inputSchema.describe(),
    }
  }
}
