import { Tool } from './tool'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../utils/guards'
import { E_INVALID_INITIAL_TOOL_VALUE } from '../exceptions/runtime'
import { validateOrThrow, ValidationException } from '../utils/validation'
import type { Registry } from './registry'
import type { Schema } from '@nhtio/validation'
import type { Tokenizable } from './tokenizable'
import type { DispatchContext } from '../contracts/dispatch_context'

/**
 * The execution function for an {@link ArtifactTool}.
 *
 * @remarks
 * Identical to the base tool handler except the return type is narrowed to
 * `string | Tokenizable | Promise<string | Tokenizable>`. Forged artifact-query tools emit
 * model-visible strings — the ADK wraps a bare-string return into a {@link @nhtio/adk!Tokenizable}
 * at the result-wrapping site so downstream code can rely on
 * `ToolCall.results instanceof Tokenizable` for every `ArtifactTool` invocation.
 */
export type ArtifactToolHandler = (
  args: unknown,
  ctx: DispatchContext,
  meta: Registry
) => string | Tokenizable | Promise<string | Tokenizable>

/**
 * Plain input object supplied to {@link ArtifactTool} at construction time.
 *
 * @remarks
 * Mirrors the base `RawTool` except `artifactConstructor` is forbidden — an `ArtifactTool`
 * emits a {@link @nhtio/adk!Tokenizable} directly into `ToolCall.results` and explicitly opts out of
 * `SpooledArtifact` wrapping. The forbidden field is enforced by {@link ArtifactTool.schema}
 * at construction time.
 */
export interface RawArtifactTool {
  /** Unique identifier used in LLM tool definitions. Recommend lowercase snake_case. */
  name: string
  /** Human-readable description passed to the model to explain what the tool does. */
  description: string
  /** @nhtio/validation schema for the tool's input arguments. */
  inputSchema: Schema
  /** Execution function. Returns a string or {@link @nhtio/adk!Tokenizable}; the ADK wraps a bare string into a `Tokenizable` at the result-wrapping site. */
  handler: ArtifactToolHandler
  /** Optional arbitrary metadata for this tool. Defaults to `{}`. */
  meta?: Record<string, unknown>
  /**
   * When `true`, marks this tool as owned by a specific {@link @nhtio/adk!DispatchContext}.
   *
   * @remarks
   * `ArtifactTool` instances produced by `SpooledArtifact.forgeTools(ctx)` set this to `true`
   * so that `ToolRegistry.pruneEphemeral()` drops them at ctx-completion.
   *
   * @defaultValue `false`
   */
  ephemeral?: boolean
  /**
   * When `true`, declares that this tool's output should be treated as **trusted developer/user
   * intent** rather than as untrusted third-party text when surfaced to the model.
   *
   * @remarks
   * Forged artifact-query tools default to `false` because their results are derived from
   * spooled artifact bodies — which may themselves be untrusted upstream tool output. The
   * trust signal does not promote handle-query results above the trust tier of the underlying
   * artifact.
   *
   * @defaultValue `false`
   */
  trusted?: boolean
  /**
   * Self-declared merge collision policy honoured by `ToolRegistry.merge`.
   *
   * @remarks
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
 * Validator schema for a {@link RawArtifactTool}.
 *
 * @remarks
 * Mirrors the base tool schema but explicitly forbids `artifactConstructor` — the entire
 * point of `ArtifactTool` is to opt out of `SpooledArtifact` wrapping.
 */
const rawArtifactToolSchema = validator.object<RawArtifactTool & { artifactConstructor?: never }>({
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
  // eslint-disable-next-line adk/require-validator-any-required -- map value type-arg: meta holds arbitrary values; disposition is set by .default({}) on the object
  meta: validator.object().pattern(validator.string(), validator.any()).default({}),
  ephemeral: validator.boolean().default(false),
  trusted: validator.boolean().default(false),
  onCollision: validator.string().valid('throw', 'replace', 'keep').default('throw'),
  artifactConstructor: validator.any().forbidden(),
})

/**
 * A {@link @nhtio/adk!Tool} subclass whose handler return value is wrapped directly in a
 * {@link @nhtio/adk!Tokenizable} (not a {@link @nhtio/adk!SpooledArtifact}) when it
 * lands on `ToolCall.results`.
 *
 * @remarks
 * `ArtifactTool` is the canonical producer for **forged artifact-query tools** — the tools
 * `SpooledArtifact.forgeTools(ctx)` emits so the model can `head`, `tail`, `grep`, `json_get`,
 * `md_headings` (etc.) an artifact that is already in `ctx.turnToolCalls`.
 *
 * The difference from {@link @nhtio/adk!Tool} is structural, not stylistic:
 *
 * - A normal `Tool`'s handler returns bytes the ADK wraps in a fresh `SpooledArtifact`.
 *   The artifact lands in `ToolCall.results`, joins `ctx.turnToolCalls`, and is itself a
 *   first-class queryable artifact in the turn.
 * - An `ArtifactTool`'s handler returns a string that is **already the model-visible answer**
 *   to a query against an existing artifact. The ADK wraps it in a `Tokenizable` rather
 *   than a `SpooledArtifact`; nothing new is queryable on its own. Subsequent
 *   `forgeTools(ctx)` calls exclude `ToolCall`s produced by an `ArtifactTool` from the
 *   `callId` enum (via the `ToolCall.fromArtifactTool` marker) — this is the structural fix
 *   that breaks the otherwise-recursive grep-on-the-grep-result loop.
 *
 * Consumers who want to build their own artifact-query tools (e.g. for a domain-specific
 * spooled subclass not shipped by the ADK) should extend or instantiate this class.
 */
export class ArtifactTool extends Tool {
  /**
   * Validator schema that accepts a {@link RawArtifactTool} object.
   *
   * @remarks
   * Differs from {@link @nhtio/adk!Tool.schema} by forbidding `artifactConstructor` — wrapping is
   * exactly the thing this class opts out of. Typed identically to {@link @nhtio/adk!Tool.schema} so the
   * subclass relationship `class ArtifactTool extends Tool` remains structurally sound; the
   * runtime validation rules still differ as declared by `rawArtifactToolSchema`.
   */
  public static schema = rawArtifactToolSchema as unknown as typeof Tool.schema

  /**
   * Returns `true` if `value` is an {@link ArtifactTool} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an {@link ArtifactTool} instance.
   */
  public static isArtifactTool(value: unknown): value is ArtifactTool {
    return isInstanceOf(value, 'ArtifactTool', ArtifactTool)
  }

  /**
   * @param raw - Raw tool input validated against {@link ArtifactTool.schema}.
   *
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_TOOL_VALUE} when `raw` does not satisfy
   *   {@link ArtifactTool.schema} (most commonly, when `artifactConstructor` is supplied — it is
   *   explicitly forbidden on this class) or when the base {@link @nhtio/adk!Tool} constructor rejects the
   *   input for any reason.
   */
  constructor(raw: RawArtifactTool) {
    // Enforce the forbidden `artifactConstructor` field up-front so the error reports against
    // ArtifactTool's contract, not the base Tool's. The base Tool constructor re-validates
    // against its own schema and stores the resolved fields.
    try {
      validateOrThrow(rawArtifactToolSchema, raw, true)
    } catch (err) {
      if (isInstanceOf(err, 'ValidationException', ValidationException)) {
        throw new E_INVALID_INITIAL_TOOL_VALUE({ cause: err })
      }
      throw err
    }
    super(raw as never)
  }
}
