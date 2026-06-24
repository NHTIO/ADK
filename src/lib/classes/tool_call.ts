import { Media } from './media'
import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { SpooledArtifact } from './spooled_artifact'
import { validateOrThrow } from '../utils/validation'
import { isObject, isInstanceOf, isError } from '../utils/guards'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_INVALID_INITIAL_TOOL_CALL_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'
import type { AdkEncodableSnapshot } from './encodable'

/**
 * Union of every shape a {@link ToolCall.results} field may carry.
 *
 * @remarks
 * Three silos with distinct render-time semantics:
 *
 * - {@link @nhtio/adk!Tokenizable} — always singular. The {@link @nhtio/adk!ArtifactTool}
 *   carve-out: a model-visible text answer that explicitly opts out of artifact wrapping to
 *   break the recursive grep-on-the-grep-result loop.
 * - {@link @nhtio/adk!SpooledArtifact} or `SpooledArtifact[]` — bounded text output spooled to durable
 *   storage. A single tool call may legitimately produce multiple artifacts (e.g. one tool
 *   that returns N PR bodies). LLM adapters render either inline (full body in trust envelope)
 *   or as a handle reference (forged artifact-query tools).
 * - {@link @nhtio/adk!Media} or `Media[]` — binary modality output (image, audio, video, document).
 *   Adapters render as provider-specific content blocks (`image_url`, `input_audio`, `file`,
 *   etc.). Bytes are lazy — reached only through {@link @nhtio/adk!Media.stream}.
 */
export type ToolCallResults = Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]

const isToolCallResults = (value: unknown): value is ToolCallResults => {
  if (Tokenizable.isTokenizable(value)) return true
  if (SpooledArtifact.isSpooledArtifact(value)) return true
  if (Media.isMedia(value)) return true
  if (Array.isArray(value) && value.length > 0) {
    const allMedia = value.every((entry) => Media.isMedia(entry))
    if (allMedia) return true
    const allSpooled = value.every((entry) => SpooledArtifact.isSpooledArtifact(entry))
    if (allSpooled) return true
  }
  return false
}

/**
 * Plain input object supplied to {@link ToolCall} at construction time.
 *
 * @remarks
 * Validated against `rawToolCallSchema` before the `ToolCall` instance is created.
 * Temporal fields accept any value that Luxon can parse — ISO strings, Unix timestamps,
 * `Date` objects, or existing `DateTime` instances.
 */
export interface RawToolCall {
  /** Stable unique identifier for this tool call; correlates the request with its result. */
  id: string
  /** Name of the tool the model has requested. */
  tool: string
  /**
   * Arguments the model supplied for this tool call.
   *
   * @remarks
   * Accepts either a plain object or a JSON-encoded string that deserialises to an object.
   * Always exposed as a plain object on the constructed {@link ToolCall} instance.
   */
  args: string | Record<string, unknown>
  /** Integrity checksum over `tool` and `args`; can be used to detect tampering before execution. */
  checksum: string
  /** `true` once the tool call has finished (successfully or not). */
  isComplete: boolean
  /** `true` when the tool execution produced an error; inspect `results` for detail. */
  isError: boolean
  /**
   * Result returned by the tool, or error detail when `isError` is `true`.
   *
   * @remarks
   * Three silos with distinct render-time semantics — see {@link ToolCallResults}:
   *
   * - For a normal {@link @nhtio/adk!Tool} call whose handler returned `string` or
   *   `Uint8Array`, this is a {@link @nhtio/adk!SpooledArtifact} (or one of its subclasses) wrapping the
   *   spooled bytes. Tools that legitimately produce multiple bounded artifacts may return
   *   a `SpooledArtifact[]`.
   * - For a `Tool` call whose handler returned a {@link @nhtio/adk!Media} or `Media[]`, this is the same
   *   media handle(s) — the explicit-modality silo bypasses `SpooledArtifact` wrapping because
   *   the bytes are binary and rendered as provider-specific content blocks, not text.
   * - For an {@link @nhtio/adk!ArtifactTool} call (a forged artifact-query tool),
   *   this is a {@link @nhtio/adk!Tokenizable} holding the raw model-visible answer — `ArtifactTool`
   *   explicitly opts out of wrapping to break the recursive grep-on-the-grep-result loop.
   *
   * The ADK sets {@link RawToolCall.fromArtifactTool} on calls produced by an
   * `ArtifactTool` so subsequent `forgeTools(ctx)` invocations can filter them out of the
   * `callId` enum.
   */
  results: ToolCallResults
  /**
   * `true` when this tool call originated from an {@link @nhtio/adk!ArtifactTool}
   * invocation. Defaults to `false`.
   *
   * @remarks
   * Set by the ADK's result-wrapping touch sites when `ArtifactTool.isArtifactTool(tool)`
   * holds. Read by `SpooledArtifact.forgeTools(ctx)` when building each descriptor's `callId`
   * enum — calls with this flag set are excluded so the model can't `artifact_grep` on a
   * previous `artifact_grep` result. Optional in the raw shape (defaults to `false`); always
   * defined on the constructed {@link ToolCall}.
   *
   * @defaultValue `false`
   */
  fromArtifactTool?: boolean
  /**
   * When `true` (default), LLM adapters render this tool call's result inline — the full
   * stringified body is wrapped in the adapter's trust envelope and sent to the model as the
   * `tool` role content. When `false`, the adapter surfaces the result as a "handle" — a
   * directions-bearing envelope that tells the model which forged artifact-query tools to call
   * against this `tc.id` to read the content incrementally.
   *
   * @remarks
   * Policy is the producer's or middleware's call:
   *   - A normal tool returns its result with `inline: true` by default so its output is shown
   *     verbatim.
   *   - Middleware that wants to keep large results out of the model's prompt sets `inline: false`
   *     (typically via `ctx.mutateToolCall(tc.id, { inline: false })`) before yielding.
   *   - LLM adapters do not override the flag, do not size-check the result, and do not silently
   *     switch to the handle pattern.
   *
   * For {@link @nhtio/adk!Tokenizable} results, the flag is effectively informational — handles only make
   * sense for {@link @nhtio/adk!SpooledArtifact} (which is the only result kind the forged artifact-query
   * tools can read). When `inline: false` is set on a call whose `results` is a `Tokenizable`,
   * the adapter renders inline anyway and may log a warning.
   *
   * @defaultValue `true`
   */
  inline?: boolean
  /** When this tool call was first created. */
  createdAt: string | number | Date | DateTime
  /** When this tool call was last modified. */
  updatedAt: string | number | Date | DateTime
  /** When the tool call completed. */
  completedAt: string | number | Date | DateTime
}

/**
 * A fully-resolved {@link RawToolCall} where temporal fields have been normalised to Luxon
 * `DateTime` instances.
 *
 * @remarks
 * Used internally by the {@link ToolCall} constructor to assign private fields with
 * guaranteed types.
 */
interface ResolvedToolCall {
  id: string
  tool: string
  args: Record<string, unknown>
  checksum: string
  isComplete: boolean
  isError: boolean
  results: ToolCallResults
  fromArtifactTool: boolean
  inline: boolean
  createdAt: DateTime
  updatedAt: DateTime
  completedAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawToolCall} before constructing a {@link ToolCall}.
 *
 * @remarks
 * Validates all fields of {@link RawToolCall}:
 * - `id` — required non-empty string.
 * - `tool` — required non-empty string.
 * - `args` — required; either a plain object or a JSON string that deserialises to an object.
 *   Strings are parsed and the resulting object is stored.
 * - `checksum` — required string.
 * - `isComplete` — required boolean.
 * - `isError` — required boolean.
 * - `results` — required; one of {@link @nhtio/adk!Tokenizable}, {@link @nhtio/adk!SpooledArtifact}, a non-empty
 *   `SpooledArtifact[]`, {@link @nhtio/adk!Media}, or a non-empty `Media[]`. Arrays must be homogeneous.
 * - `createdAt` / `updatedAt` / `completedAt` — required datetime-parseable values, normalised to `DateTime`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_INITIAL_TOOL_CALL_VALUE} (via the {@link ToolCall} constructor) when
 * validation fails.
 */
const rawToolCallSchema = validator.object<RawToolCall>({
  id: validator.string().required(),
  tool: validator.string().required(),
  args: validator
    .alternatives(
      validator.object().unknown(true),
      validator.string().custom((value, helpers) => {
        try {
          const parsed = JSON.parse(value)
          if (!isObject(parsed)) {
            return helpers.error('any.invalid')
          }
          return parsed
        } catch {
          return helpers.error('any.invalid')
        }
      })
    )
    .required(),
  checksum: validator.string().required(),
  isComplete: validator.boolean().required(),
  isError: validator.boolean().required(),
  results: validator
    .any()
    .custom((value, helpers) => {
      if (isToolCallResults(value)) {
        return value
      }
      return helpers.error('any.invalid')
    })
    .required(),
  fromArtifactTool: validator.boolean().default(false),
  inline: validator.boolean().default(true),
  createdAt: validator.datetime().required(),
  updatedAt: validator.datetime().required(),
  completedAt: validator.datetime().required(),
})

/**
 * An immutable, validated tool call record associated with a turn.
 *
 * @remarks
 * Represents a completed tool invocation from the conversation history — `results`,
 * `completedAt`, `isComplete`, and `isError` are all present and required.
 * Temporal fields are normalised to Luxon `DateTime` instances at construction time.
 */
export class ToolCall {
  /**
   * Validator schema that accepts a {@link RawToolCall} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a tool call entry.
   */
  public static schema = rawToolCallSchema

  /**
   * Returns `true` if `value` is a {@link ToolCall} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link ToolCall} instance.
   */
  public static isToolCall(value: unknown): value is ToolCall {
    return isInstanceOf(value, 'ToolCall', ToolCall)
  }

  /** Stable unique identifier for this tool call; correlates the request with its result. */
  declare readonly id: string
  /** Name of the tool the model has requested. */
  declare readonly tool: string
  /** Arguments the model supplied for this tool call, always as a plain object. */
  declare readonly args: Record<string, unknown>
  /** Integrity checksum over `tool` and `args`. */
  declare readonly checksum: string
  /** `true` once the tool call has finished (successfully or not). */
  declare readonly isComplete: boolean
  /** `true` when the tool execution produced an error; inspect `results` for detail. */
  declare readonly isError: boolean
  /**
   * Result returned by the tool, or error detail when `isError` is `true`.
   *
   * @remarks
   * One of three silos — see {@link ToolCallResults}. {@link @nhtio/adk!SpooledArtifact} or
   * `SpooledArtifact[]` for normal text-output {@link @nhtio/adk!Tool} calls;
   * {@link @nhtio/adk!Media} or `Media[]` for tool calls whose handler returned binary modality output;
   * {@link @nhtio/adk!Tokenizable} for {@link @nhtio/adk!ArtifactTool} calls
   * (see {@link ToolCall.fromArtifactTool}).
   */
  declare readonly results: ToolCallResults
  /**
   * `true` when this tool call originated from an {@link @nhtio/adk!ArtifactTool}
   * invocation. Used by `SpooledArtifact.forgeTools(ctx)` to filter out forged-tool results from
   * the `callId` enum it builds.
   */
  declare readonly fromArtifactTool: boolean
  /**
   * `true` (default) renders this tool call's result inline in the prompt; `false` instructs LLM
   * adapters to surface the result as a handle reference. See {@link RawToolCall.inline}.
   */
  declare readonly inline: boolean
  /** When this tool call was first created. */
  declare readonly createdAt: DateTime
  /** When this tool call was last modified. */
  declare readonly updatedAt: DateTime
  /** When the tool call completed. */
  declare readonly completedAt: DateTime

  #id: string
  #tool: string
  #args: Record<string, unknown>
  #checksum: string
  #isComplete: boolean
  #isError: boolean
  #results: ToolCallResults
  #fromArtifactTool: boolean
  #inline: boolean
  #createdAt: DateTime
  #updatedAt: DateTime
  #completedAt: DateTime

  /**
   * @param raw - The raw tool call input validated against `rawToolCallSchema`.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_TOOL_CALL_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawToolCall) {
    let resolved: ResolvedToolCall
    try {
      resolved = validateOrThrow<ResolvedToolCall>(rawToolCallSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_TOOL_CALL_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#id = resolved.id
    this.#tool = resolved.tool
    this.#args = resolved.args
    this.#checksum = resolved.checksum
    this.#isComplete = resolved.isComplete
    this.#isError = resolved.isError
    this.#results = resolved.results
    this.#fromArtifactTool = resolved.fromArtifactTool
    this.#inline = resolved.inline
    this.#createdAt = resolved.createdAt
    this.#updatedAt = resolved.updatedAt
    this.#completedAt = resolved.completedAt

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      tool: {
        get: () => this.#tool,
        enumerable: true,
        configurable: false,
      },
      args: {
        get: () => this.#args,
        enumerable: true,
        configurable: false,
      },
      checksum: {
        get: () => this.#checksum,
        enumerable: true,
        configurable: false,
      },
      isComplete: {
        get: () => this.#isComplete,
        enumerable: true,
        configurable: false,
      },
      isError: {
        get: () => this.#isError,
        enumerable: true,
        configurable: false,
      },
      results: {
        get: () => this.#results,
        enumerable: true,
        configurable: false,
      },
      fromArtifactTool: {
        get: () => this.#fromArtifactTool,
        enumerable: true,
        configurable: false,
      },
      inline: {
        get: () => this.#inline,
        enumerable: true,
        configurable: false,
      },
      createdAt: {
        get: () => this.#createdAt,
        enumerable: true,
        configurable: false,
      },
      updatedAt: {
        get: () => this.#updatedAt,
        enumerable: true,
        configurable: false,
      },
      completedAt: {
        get: () => this.#completedAt,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Serialise this ToolCall into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * Emits a {@link RawToolCall}-shaped object. `results` is the live {@link ToolCallResults} union —
   * a {@link @nhtio/adk!Tokenizable}, {@link @nhtio/adk!SpooledArtifact}(s), or {@link @nhtio/adk!Media}(s) —
   * which the encoder recurses into; reader-backed results round-trip as handles (and throw
   * {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE} if a backing reader cannot describe itself). The `args`
   * object and the producer-supplied `checksum` are emitted verbatim, so the constructor's
   * checksum re-validation passes on decode. Round-trips via {@link ToolCall.[DECODE_METHOD]}.
   *
   * @returns A {@link RawToolCall}-shaped snapshot.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      id: this.#id,
      tool: this.#tool,
      args: this.#args,
      checksum: this.#checksum,
      isComplete: this.#isComplete,
      isError: this.#isError,
      results: this.#results,
      fromArtifactTool: this.#fromArtifactTool,
      inline: this.#inline,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      completedAt: this.#completedAt,
    }
  }

  /**
   * Reconstruct a {@link ToolCall} from a {@link ToolCall.[ENCODE_METHOD]} snapshot.
   *
   * @param data - The snapshot produced by {@link ToolCall.[ENCODE_METHOD]}.
   * @returns A fully-validated {@link ToolCall}.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): ToolCall {
    return new ToolCall(data as RawToolCall)
  }
}
